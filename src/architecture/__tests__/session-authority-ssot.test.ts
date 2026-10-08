/**
 * @module architecture/session-authority-ssot
 * @description Default-deny guard for the session-authority single source of truth.
 *
 * `adapters/session-authority.ts` is the only module allowed to turn a
 * worktree/directory, a session id, and an optional host-claimed workspace
 * fingerprint into an authoritative session location and validated state.
 * Every other production module consumes its outcome; none may re-derive a
 * session directory from a fingerprint plus session id, because that bypasses
 * worktree/fingerprint validation and fails open on drift.
 *
 * Invariants:
 *   A1 `resolveSessionAuthority` is declared exactly once, in the authority.
 *   A2 `sessionDir(...)` — as an identifier call or a property call — is
 *      admissible only in the sanctioned exceptions below, each with an exact
 *      expected call count and a reason. A new call site anywhere else fails
 *      this guard. The authority that owns the layout formula
 *      (`adapters/workspace/init.ts`) is exempt only for its own use.
 *   A3 The removed local resolvers (`getSessionDir`,
 *      `resolveCanonicalSessionDir`) must never reappear in production source.
 *   A4 Detectors are proven by negative fixtures so a broken walk cannot make
 *      the guard pass silently.
 *
 * @version v1
 */

import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectProductionSources } from '../support/production-source.js';

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole authority allowed to resolve a session from worktree + id. */
const AUTHORITY = 'adapters/session-authority.ts';

/** Removed local resolvers that must not be reintroduced. */
const REMOVED_RESOLVERS = ['getSessionDir', 'resolveCanonicalSessionDir'] as const;

/**
 * Sanctioned `sessionDir(...)` exceptions: each already operates on an explicit,
 * persisted fingerprint/session id (archive, diagnostics) or owns the layout
 * formula itself, and none of them selects the current mutable session.
 */
const SANCTIONED: ReadonlyMap<string, { calls: number; reason: string }> = new Map([
  [AUTHORITY, { calls: 1, reason: 'the single authority itself' }],
  [
    'adapters/workspace/init.ts',
    { calls: 1, reason: 'workspace layout authority that defines the formula' },
  ],
  [
    'adapters/workspace/archive.ts',
    { calls: 1, reason: 'archive read of an explicit persisted fingerprint/session id' },
  ],
  [
    'adapters/workspace/archive-verify-publication.ts',
    { calls: 1, reason: 'audit read of an explicit archive location' },
  ],
  ['cli/inspect-command.ts', { calls: 2, reason: 'read-only diagnostic over explicit ids' }],
  ['cli/doctor-handshake.ts', { calls: 1, reason: 'read-only pointer diagnostic' }],
  [
    'mcp-server/session-resolver.ts',
    { calls: 1, reason: 'fingerprint-parent derivation; no session id is selected' },
  ],
  [
    'adapters/workspace/upgrade-preflight.ts',
    {
      calls: 1,
      reason:
        'read-only upgrade preflight classifies raw session directories without trusting state',
    },
  ],
  [
    'integration/review/observations/observation-resolution.ts',
    { calls: 1, reason: 'replay of already-recorded audit entries by persisted fingerprint/id' },
  ],
]);

/**
 * Sanctioned workspace bootstrap/initialization call sites. Every other
 * production file must resolve the session through the canonical authority and
 * must not create a session directory or workspace metadata on its own.
 */
const WORKSPACE_INIT_SANCTIONED: ReadonlyMap<
  string,
  { readonly initWorkspace: number; readonly ensureWorkspace: number; readonly reason: string }
> = new Map([
  [
    'adapters/workspace/init.ts',
    {
      initWorkspace: 0,
      ensureWorkspace: 1,
      reason: 'owns the workspace layout/bootstrap implementation',
    },
  ],
  [
    'hooks/session-start.ts',
    { initWorkspace: 0, ensureWorkspace: 1, reason: 'host bootstrap entrypoint' },
  ],
  [
    'hooks/http-server.ts',
    { initWorkspace: 0, ensureWorkspace: 1, reason: 'host bootstrap entrypoint' },
  ],
  [
    'integration/tools/hydrate/hydrate.ts',
    {
      initWorkspace: 1,
      ensureWorkspace: 0,
      reason: 'create-or-update bootstrap after authority resolution under the write lock',
    },
  ],
]);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * Local names bound to an imported symbol, including named-import aliases
 * (`import { initWorkspace as bootstrap }`). Namespace imports are covered by
 * the property-access counting in {@link countWorkspaceInitCalls}.
 */
function importAliasesOf(content: string, importedName: string): Set<string> {
  const source = ts.createSourceFile('guard.ts', content, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  walk(source, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === importedName) names.add(element.name.text);
    }
  });
  return names;
}

/**
 * Count direct `initWorkspace(...)` / `ensureWorkspace(...)` calls (or property
 * access) including named-import aliases, so an alias cannot bypass the guard.
 */
function countWorkspaceInitCalls(content: string, name: string): number {
  const callNames = new Set([name, ...importAliasesOf(content, name)]);
  const source = ts.createSourceFile('guard.ts', content, ts.ScriptTarget.Latest, true);
  let count = 0;
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callNames.has(callee.text)) count += 1;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === name) count += 1;
  });
  return count;
}

/** Count direct `sessionDir(...)` and `x.sessionDir(...)` call expressions. */
function countSessionDirCalls(content: string): number {
  const source = ts.createSourceFile('guard.ts', content, ts.ScriptTarget.Latest, true);
  let count = 0;
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'sessionDir') count += 1;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'sessionDir') count += 1;
  });
  return count;
}

/** Collect every identifier reference (not property names) in a source file. */
function identifierReferences(content: string): string[] {
  const source = ts.createSourceFile('guard.ts', content, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  walk(source, (node) => {
    if (ts.isIdentifier(node)) names.push(node.text);
  });
  return names;
}

/** Top-level and nested declarations of a named function/const. */
function declaresName(content: string, name: string): boolean {
  const source = ts.createSourceFile('guard.ts', content, ts.ScriptTarget.Latest, true);
  let found = false;
  walk(source, (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = true;
    }
  });
  return found;
}

describe('session-authority single source of truth', () => {
  const sources = collectProductionSources(SRC_ROOT);

  it('A1: resolveSessionAuthority is declared only by the authority module', () => {
    const declaring = sources
      .filter((file) => declaresName(file.content, 'resolveSessionAuthority'))
      .map((file) => file.rel);
    expect(declaring).toEqual([AUTHORITY]);
  });

  it('A2: sessionDir call sites are exactly the sanctioned exceptions', () => {
    for (const file of sources) {
      const calls = countSessionDirCalls(file.content);
      const sanction = SANCTIONED.get(file.rel);
      if (sanction === undefined) {
        expect(
          calls,
          `${file.rel} must not derive a session directory; use resolveSessionAuthority`,
        ).toBe(0);
        continue;
      }
      expect(calls, `${file.rel} sanctioned call count (${sanction.reason})`).toBe(sanction.calls);
    }
  });

  it('A3: removed local resolvers never reappear', () => {
    for (const file of sources) {
      for (const name of identifierReferences(file.content)) {
        expect(
          REMOVED_RESOLVERS.includes(name as (typeof REMOVED_RESOLVERS)[number]),
          `${file.rel} references removed resolver ${name}`,
        ).toBe(false);
      }
    }
  });

  it('A4: detectors are proven by negative fixtures', () => {
    const identifierCall = "import { sessionDir } from './init.js';\nconst d = sessionDir(f, s);";
    const propertyCall = "import { paths } from './paths.js';\nconst d = paths.sessionDir(f, s);";
    const definition =
      'export function sessionDir(fingerprint: string, id: string) { return null; }';
    const forbidden = 'const d = getSessionDir(fingerprint, id);';

    expect(countSessionDirCalls(identifierCall)).toBe(1);
    expect(countSessionDirCalls(propertyCall)).toBe(1);
    expect(countSessionDirCalls(definition)).toBe(0);
    expect(countSessionDirCalls('const d = other(f, s);')).toBe(0);
    expect(identifierReferences(forbidden)).toContain('getSessionDir');
    expect(declaresName(definition, 'sessionDir')).toBe(true);
    expect(
      declaresName('const resolveSessionAuthority = () => null;', 'resolveSessionAuthority'),
    ).toBe(true);

    const initCall = "import { initWorkspace } from './init.js';\nawait initWorkspace(dir, id);";
    expect(countWorkspaceInitCalls(initCall, 'initWorkspace')).toBe(1);
    expect(countWorkspaceInitCalls('apis.initWorkspace(dir, id)', 'initWorkspace')).toBe(1);
    expect(
      countWorkspaceInitCalls('export async function initWorkspace() {}', 'initWorkspace'),
    ).toBe(0);
    expect(countWorkspaceInitCalls('await ensureWorkspace(dir);', 'ensureWorkspace')).toBe(1);
    // Named-import aliases cannot bypass the call-site guard.
    const aliasedCall =
      "import { initWorkspace as bootstrap } from './init.js';\nawait bootstrap(dir, id);";
    expect(countWorkspaceInitCalls(aliasedCall, 'initWorkspace')).toBe(1);
    const aliasedEnsure = "import { ensureWorkspace as prep } from './init.js';\nawait prep(dir);";
    expect(countWorkspaceInitCalls(aliasedEnsure, 'ensureWorkspace')).toBe(1);
    expect(
      countWorkspaceInitCalls(
        "import { initWorkspace as bootstrap } from './init.js';\nawait other(dir, id);",
        'initWorkspace',
      ),
    ).toBe(0);
  });

  it('A5: workspace bootstrap/initialization call sites are exactly the sanctioned map', () => {
    for (const file of sources) {
      const sanction = WORKSPACE_INIT_SANCTIONED.get(file.rel);
      expect(
        countWorkspaceInitCalls(file.content, 'initWorkspace'),
        `${file.rel} must not initialize a session workspace; resolve the canonical authority first`,
      ).toBe(sanction?.initWorkspace ?? 0);
      expect(
        countWorkspaceInitCalls(file.content, 'ensureWorkspace'),
        `${file.rel} must not ensure workspace metadata outside the sanctioned bootstrap path`,
      ).toBe(sanction?.ensureWorkspace ?? 0);
    }
  });

  it('A6: initWorkspace is declared only by the workspace layout authority', () => {
    const declaring = sources
      .filter((file) => declaresName(file.content, 'initWorkspace'))
      .map((file) => file.rel);
    expect(declaring).toEqual(['adapters/workspace/init.ts']);
  });
});
