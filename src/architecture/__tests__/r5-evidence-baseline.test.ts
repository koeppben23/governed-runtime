/**
 * @module architecture/r5-evidence-baseline
 * @description Executable evidence baseline for the remaining R5 findings.
 *
 * The fifth forensic round left a broad claim behind: "nine writer entry
 * points, one parallel path without prepareState, repeated SessionState
 * validation per write". Before any disposition (fix or documented
 * non-finding) is recorded, the inventory must be precise and pinned, so a
 * later change cannot silently widen the write surface.
 *
 * This guard separates the layers the claim conflated:
 *
 *   1. Public session-state writer entry points (exported functions).
 *   2. The workspace lifecycle entry point (`updateReviewAssurance`), which is
 *      a `PluginWorkspace` method exposed through the factory — not a function
 *      export.
 *   3. Preparation helpers (`prepareState*`, `prepareAuditOperations`, the
 *      prepared-artifact commit helper) that never persist on their own.
 *   4. The raw `SessionState.safeParse` call sites, by enclosing function.
 *
 * The parallel-path finding itself was closed by #944 (PR #949's predecessor
 * audits); this guard only pins the surviving surface.
 *
 * Evidence that is already owned elsewhere is referenced, not duplicated:
 *   - the 21 frozen legacy selectors are pinned by A12 in
 *     `mutation-scope.test.ts` against `scripts/mutation-legacy-baseline.json`;
 *   - task-class ordering, all pairs, ties, commutativity and idempotence are
 *     pinned by `src/integration/phase-tool-gate.test.ts`.
 *
 * @version v1
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

const WRITER_FILES = {
  persistence: 'adapters/persistence.ts',
  auditOutbox: 'integration/audit-outbox.ts',
  toolHelpers: 'integration/tools/helpers.ts',
} as const;

const WORKSPACE_FILE = 'integration/plugin-workspace.ts';

function parse(rel: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    readFileSync(join(SRC_ROOT, rel), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.getModifiers(node as ts.HasModifiers) ?? []).some(
    (modifier) => modifier.kind === kind,
  );
}

function topLevelFunctions(
  file: ts.SourceFile,
): ReadonlyArray<{ name: string; exported: boolean }> {
  const functions: Array<{ name: string; exported: boolean }> = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      functions.push({
        name: statement.name.text,
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      });
    }
  }
  return functions;
}

/** Nearest enclosing named function/method declaration of a node. */
function enclosingFunctionName(node: ts.Node, file: ts.SourceFile): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name !== undefined
    ) {
      return current.name.getText(file);
    }
    current = current.parent;
  }
  return '<top-level>';
}

function safeParseSites(file: ts.SourceFile): Array<{ fn: string; line: number }> {
  const sites: Array<{ fn: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression } = node;
      if (
        expression.name.text === 'safeParse' &&
        expression.expression.getText(file) === 'SessionState'
      ) {
        sites.push({
          fn: enclosingFunctionName(node, file),
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

describe('R5 evidence baseline', () => {
  it('pins the public session-state writer entry points by category', () => {
    const expected: Record<keyof typeof WRITER_FILES, readonly string[]> = {
      persistence: ['writeState', 'writeStateAlreadyLocked'],
      auditOutbox: [
        'prepareAuditOperations',
        'prepareStateWithAuditOperations',
        'writeStateWithAuditOperationsAlreadyLocked',
        'writeStateWithAuditOperations',
        'mutateStateWithAuditOperations',
      ],
      toolHelpers: [
        'writeStateWithArtifacts',
        'writeStateWithArtifactsAndAuditOperations',
        'writeStateWithArtifactsAndAuditOperationsAlreadyLocked',
      ],
    };

    for (const [key, rel] of Object.entries(WRITER_FILES) as Array<
      [keyof typeof WRITER_FILES, string]
    >) {
      const functions = topLevelFunctions(parse(rel));
      const writerish = functions
        .filter(({ exported }) => exported)
        .filter(({ name }) => /^(writeState|mutateState|prepareState|prepareAudit)/.test(name))
        .map(({ name }) => name)
        .sort();
      expect(writerish, rel).toEqual([...expected[key]].sort());
    }
  });

  it('pins the non-exported preparation and commit helpers', () => {
    const auditOutbox = topLevelFunctions(parse(WRITER_FILES.auditOutbox));
    const toolHelpers = topLevelFunctions(parse(WRITER_FILES.toolHelpers));

    expect(auditOutbox).toContainEqual({ name: 'prepareState', exported: false });
    expect(toolHelpers).toContainEqual({
      name: 'commitPreparedStateWithArtifactsAlreadyLocked',
      exported: false,
    });
  });

  it('pins updateReviewAssurance as a workspace method, not a function export', () => {
    const file = parse(WORKSPACE_FILE);
    const contexts = new Set<string>();

    const visit = (node: ts.Node): void => {
      if (
        (ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) &&
        node.name.getText(file) === 'updateReviewAssurance'
      ) {
        contexts.add(ts.isMethodSignature(node) ? 'interface' : 'implementation');
      }
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(file) === 'updateReviewAssurance' &&
        ts.isObjectLiteralExpression(node.parent) &&
        ts.isReturnStatement(node.parent.parent)
      ) {
        contexts.add('factory');
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    expect([...contexts].sort()).toEqual(['factory', 'implementation', 'interface']);
    expect(topLevelFunctions(file).map(({ name }) => name)).not.toContain('updateReviewAssurance');
  });

  it('pins every production SessionState.safeParse call site by enclosing function', () => {
    const expected: Record<string, Record<string, number>> = {
      [WRITER_FILES.persistence]: { validateStateJson: 1, writeStateAlreadyLocked: 1 },
      [WRITER_FILES.auditOutbox]: { prepareState: 2, prepareAuditOperations: 1 },
      [WRITER_FILES.toolHelpers]: { commitPreparedStateWithArtifactsAlreadyLocked: 1 },
    };

    const actual: Record<string, Record<string, number>> = {};
    for (const rel of Object.values(WRITER_FILES)) {
      const perFile: Record<string, number> = {};
      actual[rel] = perFile;
      for (const site of safeParseSites(parse(rel))) {
        perFile[site.fn] = (perFile[site.fn] ?? 0) + 1;
      }
    }

    expect(actual).toEqual(expected);
    const total = Object.values(actual).reduce(
      (sum, perFile) => sum + Object.values(perFile).reduce((fileSum, count) => fileSum + count, 0),
      0,
    );
    expect(total).toBe(6);
  });

  it('keeps the referenced legacy and task-class evidence owners present', () => {
    const scopeGuard = readFileSync(
      join(SRC_ROOT, 'architecture/__tests__/mutation-scope.test.ts'),
      'utf8',
    );
    const taskClassGuard = readFileSync(
      join(SRC_ROOT, 'integration/phase-tool-gate.test.ts'),
      'utf8',
    );

    expect(scopeGuard).toContain('A12:');
    expect(scopeGuard).toContain('mutation-legacy-baseline.json');
    expect(taskClassGuard).toContain('pins the full order and tie behaviour of maxTaskClass');
    expect(taskClassGuard).toContain('is commutative and idempotent for every pair');
  });
});
