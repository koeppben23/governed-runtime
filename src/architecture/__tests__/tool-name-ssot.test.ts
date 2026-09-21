/**
 * @module architecture/tool-name-ssot
 * @description Default-deny guard for the FlowGuard tool identity authority.
 *
 * Exactly one module owns the canonical tool vocabulary and its namespace
 * prefixes: `integration/tool-names.ts`. Every semantic consumer — comparison,
 * routing allowlist, identity argument, lifecycle key, audit-event name —
 * must use the exported constants; lower layers that may not import
 * `integration/` may store a tool name as data, but the guard proves that data
 * stays a member of the canonical vocabulary.
 *
 * Detection is STRUCTURAL: production files are parsed with the TypeScript
 * compiler API and only syntactic identity positions are inspected. Recovery
 * text, prompts, and templates legitimately contain prose like
 * `"Run flowguard_status ..."`, which is copy, not authority.
 *
 * Invariants:
 *   D1 No comparison (`===`/`!==`) or `case` label uses a `flowguard_*`
 *      string literal; identity comparisons must use the constants.
 *   D2 No array/`Set`/`Map` literal element and no string-literal property key
 *      uses a `flowguard_*` literal; allowlists must use the constants.
 *   D3 Known identity-argument positions (audit context resolution, audit
 *      reconciliation, before-mutation reconciliation, enforcement tracking,
 *      and logger service labels) never receive a `flowguard_*` literal —
 *      this is what rejects a phantom identity such as `flowguard_reconcile`.
 *      The position map is curated because identity provenance is not
 *      type-expressible; narrowed identity types complement it.
 *   D4 Property names matching `flowguard_*` must be canonical members: a
 *      lower-layer data key (policy actor classification) or a lifecycle map
 *      can never silently drift from a renamed tool.
 *   D5 An embedded `tool_call:flowguard_*` audit-event name must carry a
 *      canonical tool name.
 *   Prefix The exact literals `flowguard_` / `mcp__flowguard__` outside the
 *      authority are violations; the prefixes are part of the authority.
 *   V The authority is the only exemption — no consumer file is exempted.
 *
 * The `flowguard_executed` / `flowguard_observed` assertion-attestation
 * vocabulary is NOT a tool identity; it is explicitly excluded from the tool
 * detectors and pinned by negative fixtures.
 *
 * @version v1
 */

import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { ReviewSignalTool } from '../../integration/review/obligation-tools.js';
import * as toolNames from '../../integration/tool-names.js';
import {
  ALL_FLOWGUARD_TOOL_NAMES,
  FLOWGUARD_TOOL_NAMES,
  FLOWGUARD_TOOL_PREFIX,
  isFlowGuardToolName,
  isFlowGuardVerdictTool,
  MCP_FLOWGUARD_TOOL_PREFIX,
  TOOL_FLOWGUARD_STATUS,
} from '../../integration/tool-names.js';
import { collectProductionSources } from './production-source.js';

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole module permitted to define tool identities and prefixes. */
const AUTHORITY = 'integration/tool-names.ts';

/** Shape of any FlowGuard-namespaced identifier. */
const TOOL_NAME_PATTERN = /^flowguard_[a-z0-9_]+$/;

/** Attestation kinds that share the prefix but are NOT tool identities. */
const NON_TOOL_VOCABULARY: ReadonlySet<string> = new Set([
  'flowguard_executed',
  'flowguard_observed',
]);

/** Exact prefix literals that only the authority may define. */
const PREFIX_LITERALS: ReadonlySet<string> = new Set([
  FLOWGUARD_TOOL_PREFIX,
  MCP_FLOWGUARD_TOOL_PREFIX,
]);

/**
 * Curated identity-argument positions: callee name → argument index.
 *
 * Parameter typing cannot replace this scan. The audit pair legitimately
 * receives host tool identities (`task`, `bash`), and at every position a
 * type-valid but hardcoded canonical literal would still misattribute the
 * caller (e.g. `onFlowGuardToolAfter(state, 'flowguard_plan', ...)` from the
 * implement hook). Provenance is not expressible structurally, so any
 * `flowguard_*` literal at these positions stays a violation. The narrowed
 * identity types (`ReviewSignalTool`, `MutatingFlowGuardTool`) add
 * compile-time shape safety for new sinks but do not remove these entries.
 */
const IDENTITY_ARG_POSITIONS: ReadonlyMap<string, number> = new Map([
  ['resolveAuditContext', 1],
  ['reconcilePendingAuditOperations', 2],
  ['reconcileBeforeMutation', 2],
  ['onFlowGuardToolAfter', 1],
]);

// Identity sinks are compile-time narrow: host tools and phantom identities
// cannot reach the review-tracking boundary at all.
// @ts-expect-error — host tools carry no review signal
const _hostToolIsNotReviewSignal: ReviewSignalTool = 'bash';
// @ts-expect-error — a phantom identity is not a review-signal tool
const _phantomIdentityIsNotReviewSignal: ReviewSignalTool = 'flowguard_reconcile';

/** Logger methods whose first argument is the service/tool label. */
const LOGGER_METHODS: ReadonlySet<string> = new Set(['warn', 'info', 'debug', 'error']);

interface Violation {
  readonly rule: string;
  readonly line: number;
  readonly snippet: string;
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function isToolLiteral(value: string | undefined): value is string {
  return value !== undefined && TOOL_NAME_PATTERN.test(value) && !NON_TOOL_VOCABULARY.has(value);
}

function isCanonical(value: string): boolean {
  return ALL_FLOWGUARD_TOOL_NAMES.has(value as (typeof FLOWGUARD_TOOL_NAMES)[number]);
}

/**
 * The text of a property name in every identity-bearing spelling:
 * `flowguard_x:`, `'flowguard_x':`, and `['flowguard_x']:`. A computed name
 * whose expression is not a string literal (`[TOOL_FLOWGUARD_STATUS]:`) is the
 * canonical computed-key form and intentionally yields `undefined`.
 */
function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

/** Whether the property name is a bare literal, i.e. avoidable by a constant. */
function isLiteralPropertyName(name: ts.PropertyName): boolean {
  return (
    ts.isStringLiteralLike(name) ||
    (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
  );
}

/** Analyze one source text and report every structural identity violation. */
function analyze(sourceText: string): Violation[] {
  const sourceFile = ts.createSourceFile('analysis.ts', sourceText, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  const report = (rule: string, node: ts.Node): void => {
    violations.push({
      rule,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      snippet: node.getText(sourceFile).slice(0, 120),
    });
  };

  const checkIdentityArgument = (argument: ts.Expression | undefined): void => {
    if (argument !== undefined && TOOL_NAME_PATTERN.test(stringLiteralValue(argument) ?? '')) {
      report('D3', argument);
    }
  };

  const visit = (node: ts.Node): void => {
    // D1 — comparisons and switch labels.
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        for (const side of [node.left, node.right]) {
          if (isToolLiteral(stringLiteralValue(side))) report('D1', side);
        }
      }
    }
    if (ts.isCaseClause(node) && isToolLiteral(stringLiteralValue(node.expression))) {
      report('D1', node.expression);
    }

    // D2 — local collections and string-keyed maps.
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (isToolLiteral(stringLiteralValue(element))) report('D2', element);
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyNameText(node.name);
      if (isLiteralPropertyName(node.name) && isToolLiteral(name)) report('D2', node.name);
    }

    // D3 — identity-argument positions.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const index = IDENTITY_ARG_POSITIONS.get(callee.text);
        if (index !== undefined) checkIdentityArgument(node.arguments[index]);
      } else if (ts.isPropertyAccessExpression(callee) && LOGGER_METHODS.has(callee.name.text)) {
        checkIdentityArgument(node.arguments[0]);
      }
    }

    // D4 — property names must be canonical members.
    if (ts.isPropertyAssignment(node)) {
      const name = propertyNameText(node.name);
      if (name !== undefined && isToolLiteral(name) && !isCanonical(name)) {
        report('D4', node.name);
      }
    }

    // D5 — embedded audit-event identity.
    const literal = stringLiteralValue(node);
    if (literal !== undefined) {
      const embedded = /^tool_call:([a-z0-9_]+)$/.exec(literal)?.[1];
      if (embedded !== undefined && TOOL_NAME_PATTERN.test(embedded) && !isCanonical(embedded)) {
        report('D5', node);
      }
      // Prefix authority.
      if (PREFIX_LITERALS.has(literal)) report('PREFIX', node);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function formatViolations(rel: string, violations: readonly Violation[]): string[] {
  return violations.map((v) => `${rel}:${v.line} [${v.rule}] ${v.snippet}`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('tool identity SSOT (default-deny)', () => {
  it('finds the authority in the production scan and no semantic literal outside it', () => {
    const sources = collectProductionSources(SRC_ROOT);
    expect(sources.length).toBeGreaterThan(200);
    expect(sources.some(({ rel }) => rel === AUTHORITY)).toBe(true);

    const violations = sources
      .filter(({ rel }) => rel !== AUTHORITY)
      .flatMap(({ rel, content }) => formatViolations(rel, analyze(content)));
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('pins the canonical vocabulary and its derived views', () => {
    expect(FLOWGUARD_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(new Set(FLOWGUARD_TOOL_NAMES).size).toBe(FLOWGUARD_TOOL_NAMES.length);
    expect(ALL_FLOWGUARD_TOOL_NAMES.size).toBe(FLOWGUARD_TOOL_NAMES.length);

    // Every exported TOOL_FLOWGUARD_* constant is a member of the tuple.
    const exported = Object.entries(toolNames).filter(
      ([name, value]) => name.startsWith('TOOL_FLOWGUARD_') && typeof value === 'string',
    );
    expect(exported.length).toBe(FLOWGUARD_TOOL_NAMES.length);
    for (const [name, value] of exported) {
      expect(FLOWGUARD_TOOL_NAMES, `${name} missing from FLOWGUARD_TOOL_NAMES`).toContain(value);
    }

    // Tuple and prefix are one authority: no canonical identity may live
    // outside the declared namespace.
    for (const toolName of FLOWGUARD_TOOL_NAMES) {
      expect(toolName, toolName).toMatch(TOOL_NAME_PATTERN);
      expect(toolName.startsWith(FLOWGUARD_TOOL_PREFIX), toolName).toBe(true);
    }

    expect(isFlowGuardToolName(TOOL_FLOWGUARD_STATUS)).toBe(true);
    expect(isFlowGuardToolName('flowguard_fake')).toBe(false);
    expect(isFlowGuardVerdictTool(TOOL_FLOWGUARD_STATUS)).toBe(false);
    expect(isFlowGuardVerdictTool('flowguard_fake')).toBe(false);
  });

  describe('negative fixtures — prove every detector fires', () => {
    it('D1 rejects comparison and case identities', () => {
      expect(analyze(`if (toolName === 'flowguard_status') {}`).map((v) => v.rule)).toEqual(['D1']);
      expect(analyze(`if (toolName !== 'flowguard_plan') {}`).map((v) => v.rule)).toEqual(['D1']);
      expect(
        analyze(`switch (toolName) { case 'flowguard_hydrate': break; }`).map((v) => v.rule),
      ).toEqual(['D1']);
    });

    it('D2 rejects local allowlists and string-keyed maps', () => {
      expect(
        analyze(`const allowed = new Set(['flowguard_status', 'flowguard_run_check']);`).map(
          (v) => v.rule,
        ),
      ).toEqual(['D2', 'D2']);
      expect(analyze(`const map = { 'flowguard_status': true };`).map((v) => v.rule)).toEqual([
        'D2',
      ]);
      expect(analyze(`const map = { ['flowguard_status']: true };`).map((v) => v.rule)).toEqual([
        'D2',
      ]);
    });

    it('D3 rejects literals in identity-argument positions', () => {
      expect(
        analyze(`resolveAuditContext(deps, 'flowguard_fake', {}, sessionId);`).map((v) => v.rule),
      ).toEqual(['D3']);
      expect(
        analyze(`reconcilePendingAuditOperations(deps, sessionId, 'flowguard_plan');`).map(
          (v) => v.rule,
        ),
      ).toEqual(['D3']);
      expect(analyze(`logger.warn('flowguard_status', 'message');`).map((v) => v.rule)).toEqual([
        'D3',
      ]);
      expect(
        analyze(`resolveAuditContext(deps, toolName, {}, sessionId);`).map((v) => v.rule),
      ).toEqual([]);
    });

    it('D4 rejects non-canonical property names, including computed keys', () => {
      expect(analyze(`const policy = { flowguard_fake: 'human' };`).map((v) => v.rule)).toEqual([
        'D4',
      ]);
      expect(analyze(`const policy = { ['flowguard_fake']: 'human' };`).map((v) => v.rule)).toEqual(
        ['D2', 'D4'],
      );
    });

    it('D5 rejects non-canonical embedded audit-event names', () => {
      expect(analyze(`const event = 'tool_call:flowguard_fake';`).map((v) => v.rule)).toEqual([
        'D5',
      ]);
    });

    it('rejects the raw prefix literals', () => {
      expect(analyze(`if (toolName.startsWith('flowguard_')) {}`).map((v) => v.rule)).toEqual([
        'PREFIX',
      ]);
      expect(analyze(`const prefix = 'mcp__flowguard__';`).map((v) => v.rule)).toEqual(['PREFIX']);
    });
  });

  describe('non-fail fixtures — semantics, not string grep', () => {
    it('does not flag prose, embedded canonical events, attestations, or canonical data keys', () => {
      const source = [
        `const message = 'Run flowguard_status to inspect the session';`,
        `const event = 'tool_call:flowguard_run_check';`,
        `const attestations = ['flowguard_executed', 'flowguard_observed'];`,
        `const detail = { kind: 'tool_call', tool: 'flowguard_ticket', success: true };`,
        `const actorClassification = { flowguard_decision: 'human' };`,
      ].join('\n');
      expect(analyze(source)).toEqual([]);
    });
  });
});
