/**
 * @module architecture/topology-authority-ssot
 * @description Default-deny guard for the phase-progression and READY-routing
 * authority in `machine/topology.ts`.
 *
 * The topology owns three things consumers must not re-describe locally:
 *   1. the transition graph (`TRANSITIONS` / `resolveTransition`),
 *   2. the canonical forward progression per flow (`FLOW_PHASES`),
 *   3. the READY flow-selection targets (derived, never caller-supplied).
 *
 * Detection is structural (TypeScript compiler API over default-wide production
 * source, `production-source.ts`), so comments and formatting cannot evade it:
 *
 *   D1 `local-phase-rank-table` — an object literal that maps >= 2 phase names
 *      to numeric values (signed literals included, so `-1` counts) re-creates
 *      a rank authority.
 *   D2 `local-ready-flow-transition` — every `applyTransition(..., 'READY', ...)`
 *      (literal OR variable target) and every transition-shaped object literal
 *      with `from: 'READY'` plus `to`/`event` (shorthand properties included)
 *      is a flow-selection bypass. There is NO file-level exemption: the only
 *      admissible occurrence is inside `buildFlowSelectionTransition()` in
 *      `rails/types.ts`, and the guard additionally proves that this helper's
 *      target is bound to `resolveTransition('READY', event)`.
 *   D3 `local-flow-phase-enumeration` — an array literal (also inside
 *      `new Set([...])`) whose phase set fully contains a canonical
 *      `FLOW_PHASES` progression re-creates the ordering authority; order is
 *      irrelevant. `machine/topology.ts` (authority) and `state/schema.ts`
 *      (Phase vocabulary) are exempt. Legitimate subsets such as a command's
 *      allowed phases or the user-gate classification are not flagged.
 *
 * @version v2
 */

import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { FLOW_PHASES, TRANSITIONS } from '../../machine/topology.js';
import { collectProductionSources, type ProductionSourceFile } from './production-source.js';

const SRC_ROOT = join(process.cwd(), 'src');

/** D1 exemption: the topology is the rank authority (it currently defines none). */
const D1_AUTHORITY = new Set<string>(['machine/topology.ts']);

/** D3 exemption: the progression authority and the Phase vocabulary authority. */
const D3_AUTHORITY = new Set<string>(['machine/topology.ts', 'state/schema.ts']);

/** The single controlled derivation helper; only its AST subtree may construct a READY transition. */
const CONTROLLED_HELPER_FILE = 'rails/types.ts';
const CONTROLLED_HELPER_NAME = 'buildFlowSelectionTransition';

/** All phase names, derived from the graph — no third list. */
const PHASE_NAMES: ReadonlySet<string> = new Set<string>([...TRANSITIONS.keys()]);

/** Canonical progression sets, derived from the authority tuple. */
const PROGRESSIONS: readonly ReadonlySet<string>[] = Object.values(FLOW_PHASES).map(
  (phases) => new Set<string>(phases),
);

interface Violation {
  readonly rel: string;
  readonly line: number;
  readonly snippet: string;
  readonly rule: string;
}

type Detector = (sourceFile: ts.SourceFile, rel: string) => Violation[];

interface NodeRange {
  readonly start: number;
  readonly end: number;
}

function parse(content: string, rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visit(node: ts.Node, cb: (node: ts.Node) => void): void {
  cb(node);
  node.forEachChild((child) => visit(child, cb));
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  const name = node.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** Positive and negative numeric literals (`-1` is PrefixUnaryExpression in the AST). */
function isNumericValue(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node)) return true;
  return (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(node.operand)
  );
}

type ObjectPropertyEntry =
  | { readonly kind: 'assignment'; readonly initializer: ts.Expression }
  | { readonly kind: 'shorthand' };

/** Property map including shorthand assignments (`{ from, to, event }`). */
function objectPropertyEntries(node: ts.ObjectLiteralExpression): Map<string, ObjectPropertyEntry> {
  const entries = new Map<string, ObjectPropertyEntry>();
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property);
      if (name) entries.set(name, { kind: 'assignment', initializer: property.initializer });
    } else if (ts.isShorthandPropertyAssignment(property)) {
      entries.set(property.name.text, { kind: 'shorthand' });
    }
  }
  return entries;
}

function report(sourceFile: ts.SourceFile, node: ts.Node, rel: string, rule: string): Violation {
  return {
    rel,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    snippet: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 140).trim(),
    rule,
  };
}

function reportAt(sourceFile: ts.SourceFile, offset: number, rel: string, rule: string): Violation {
  return {
    rel,
    line: sourceFile.getLineAndCharacterOfPosition(offset).line + 1,
    snippet: `${CONTROLLED_HELPER_NAME} must derive its target from resolveTransition('READY', event)`,
    rule,
  };
}

/** D1: object literal mapping >= 2 phase names to numeric values. */
function findPhaseRankTables(sourceFile: ts.SourceFile, rel: string): Violation[] {
  const out: Violation[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    let numericPhaseEntries = 0;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property);
      if (!name || !PHASE_NAMES.has(name)) continue;
      if (isNumericValue(property.initializer)) numericPhaseEntries += 1;
    }
    if (numericPhaseEntries >= 2) out.push(report(sourceFile, node, rel, 'local-phase-rank-table'));
  });
  return out;
}

function isResolveTransitionReadyCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
  if (node.expression.text !== 'resolveTransition') return false;
  const first = node.arguments[0];
  return first !== undefined && ts.isStringLiteralLike(first) && first.text === 'READY';
}

/** The AST range of the controlled helper, when this is its file. */
function controlledHelperRange(sourceFile: ts.SourceFile, rel: string): NodeRange | undefined {
  if (rel !== CONTROLLED_HELPER_FILE) return undefined;
  let range: NodeRange | undefined;
  visit(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === CONTROLLED_HELPER_NAME) {
      range = { start: node.getStart(sourceFile), end: node.getEnd() };
    }
  });
  return range;
}

function isInsideRange(node: ts.Node, range: NodeRange): boolean {
  return node.getStart() >= range.start && node.getEnd() <= range.end;
}

/**
 * Prove that the controlled helper binds its returned `to` to a
 * `resolveTransition('READY', ...)` result inside its own body.
 */
function helperDerivesFromTopology(sourceFile: ts.SourceFile, range: NodeRange): boolean {
  let derivedBinding: string | undefined;
  let readyTransitionObjects = 0;
  let returnedToIsDerived = false;

  visit(sourceFile, (node) => {
    if (!isInsideRange(node, range)) return;

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isResolveTransitionReadyCall(node.initializer)
    ) {
      derivedBinding = node.name.text;
    }

    if (!ts.isObjectLiteralExpression(node)) return;
    const entries = objectPropertyEntries(node);
    const from = entries.get('from');
    if (!from || from.kind !== 'assignment') return;
    if (!ts.isStringLiteralLike(from.initializer) || from.initializer.text !== 'READY') return;
    const to = entries.get('to');
    if (!to || !entries.has('event')) return;

    readyTransitionObjects += 1;
    if (derivedBinding === undefined) return;
    returnedToIsDerived =
      to.kind === 'shorthand' ||
      (to.kind === 'assignment' &&
        ts.isIdentifier(to.initializer) &&
        to.initializer.text === derivedBinding);
  });

  return readyTransitionObjects === 1 && returnedToIsDerived;
}

/** D2: locally materialized READY flow-selection transitions. */
function findLocalReadyFlowTransitions(sourceFile: ts.SourceFile, rel: string): Violation[] {
  const out: Violation[] = [];
  const helperRange = controlledHelperRange(sourceFile, rel);

  if (helperRange !== undefined && !helperDerivesFromTopology(sourceFile, helperRange)) {
    out.push(
      reportAt(sourceFile, helperRange.start, rel, 'controlled-helper-without-topology-derivation'),
    );
  }

  visit(sourceFile, (node) => {
    if (helperRange !== undefined && isInsideRange(node, helperRange)) return;

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'applyTransition'
    ) {
      const from = node.arguments[1];
      if (from && ts.isStringLiteralLike(from) && from.text === 'READY') {
        out.push(report(sourceFile, node, rel, 'local-ready-flow-transition'));
      }
      return;
    }

    if (!ts.isObjectLiteralExpression(node)) return;
    const entries = objectPropertyEntries(node);
    const from = entries.get('from');
    if (!from || from.kind !== 'assignment') return;
    if (!ts.isStringLiteralLike(from.initializer) || from.initializer.text !== 'READY') return;
    if (!entries.has('to') || !entries.has('event')) return;
    out.push(report(sourceFile, node, rel, 'local-ready-flow-transition'));
  });

  return out;
}

/** D3: local enumerations that fully contain a canonical flow progression. */
function findLocalFlowEnumerations(sourceFile: ts.SourceFile, rel: string): Violation[] {
  const out: Violation[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isArrayLiteralExpression(node)) return;
    const present = new Set<string>();
    for (const element of node.elements) {
      if (ts.isStringLiteralLike(element) && PHASE_NAMES.has(element.text)) {
        present.add(element.text);
      }
    }
    if (present.size === 0) return;
    for (const progression of PROGRESSIONS) {
      if ([...progression].every((phase) => present.has(phase))) {
        out.push(report(sourceFile, node, rel, 'local-flow-phase-enumeration'));
        return;
      }
    }
  });
  return out;
}

const DETECTORS: readonly Detector[] = [
  findPhaseRankTables,
  findLocalReadyFlowTransitions,
  findLocalFlowEnumerations,
];

/** Default-deny scan with the named authority exemptions applied. */
function scanFiles(files: readonly ProductionSourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    const sourceFile = parse(file.content, file.rel);
    if (!D1_AUTHORITY.has(file.rel)) {
      out.push(...findPhaseRankTables(sourceFile, file.rel));
    }
    out.push(...findLocalReadyFlowTransitions(sourceFile, file.rel));
    if (!D3_AUTHORITY.has(file.rel)) {
      out.push(...findLocalFlowEnumerations(sourceFile, file.rel));
    }
  }
  return out;
}

const productionFiles = collectProductionSources(SRC_ROOT);

describe('topology authority SSOT (default-deny)', () => {
  it('D1-D3: no production module re-describes phase ranks, READY routing, or flow progressions', () => {
    const violations = scanFiles(productionFiles);
    if (violations.length > 0) {
      console.error('Topology authority violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  it('scan is default-wide and excludes test sources', () => {
    const rels = productionFiles.map((file) => file.rel);
    expect(rels).toContain('machine/topology.ts');
    expect(rels).toContain('audit/completeness.ts');
    expect(rels).toContain('rails/review.ts');
    expect(rels).not.toContain('architecture/__tests__/topology-authority-ssot.test.ts');
  });

  describe('negative fixtures — prove every detector', () => {
    const findAll = (content: string, rel = 'rails/rogue.ts'): Violation[] =>
      DETECTORS.flatMap((detector) => detector(parse(content, rel), rel));

    it('D1 fires on signed numeric phase ranks and not on string labels', () => {
      expect(
        findAll('const rank = { PLAN: -2, PLAN_REVIEW: -1, VALIDATION: 0 };').some(
          (v) => v.rule === 'local-phase-rank-table',
        ),
      ).toBe(true);
      expect(
        findAll('const rank = { PLAN: 1, PLAN_REVIEW: 2, VALIDATION: 3 };').some(
          (v) => v.rule === 'local-phase-rank-table',
        ),
      ).toBe(true);
      expect(findAll("const labels = { PLAN: 'plan', PLAN_REVIEW: 'review' };")).toEqual([]);
      expect(findAll('const single = { PLAN: -1 };')).toEqual([]);
    });

    it('D2 fires on a READY transition literal and on a literal applyTransition', () => {
      expect(
        findAll(
          "const tr = { from: 'READY', to: 'PEER_REVIEW', event: 'PEER_REVIEW_SELECTED', at };",
        ).some((v) => v.rule === 'local-ready-flow-transition'),
      ).toBe(true);
      expect(
        findAll("applyTransition(state, 'READY', 'PEER_REVIEW', 'PEER_REVIEW_SELECTED', at);").some(
          (v) => v.rule === 'local-ready-flow-transition',
        ),
      ).toBe(true);
    });

    it('D2 fires on variable targets and shorthand properties (no opaque bypass)', () => {
      const variableTarget = [
        "const target = 'PEER_REVIEW';",
        "applyTransition(state, 'READY', target, 'PEER_REVIEW_SELECTED', at);",
      ].join('\n');
      expect(findAll(variableTarget).some((v) => v.rule === 'local-ready-flow-transition')).toBe(
        true,
      );

      const shorthand = [
        "const to = 'PEER_REVIEW';",
        "const event = 'PEER_REVIEW_SELECTED';",
        "const tr = { from: 'READY', to, event, at };",
      ].join('\n');
      expect(findAll(shorthand).some((v) => v.rule === 'local-ready-flow-transition')).toBe(true);
    });

    it('D2 does NOT fire on non-READY applyTransition calls', () => {
      expect(findAll('applyTransition(state, state.phase, target, event, at);')).toEqual([]);
      expect(
        findAll("applyTransition(state, 'IMPL_VALIDATION', 'IMPL_REVIEW', event, at);"),
      ).toEqual([]);
    });

    it('D2 allows only the derived helper subtree and only with the topology binding', () => {
      const derivedHelper = [
        'function buildFlowSelectionTransition(event, at) {',
        "  const to = resolveTransition('READY', event);",
        '  if (to === undefined) return undefined;',
        "  return { from: 'READY', to, event, at };",
        '}',
      ].join('\n');
      expect(findAll(derivedHelper, 'rails/types.ts')).toEqual([]);

      // A rogue transition literal elsewhere in the same file still fires.
      const rogueSibling = [
        derivedHelper,
        "const rogue = { from: 'READY', to: 'ARCHITECTURE', event: 'ARCHITECTURE_SELECTED' };",
      ].join('\n');
      expect(
        findAll(rogueSibling, 'rails/types.ts').some(
          (v) => v.rule === 'local-ready-flow-transition',
        ),
      ).toBe(true);
    });

    it('D2 fires when the controlled helper does not bind to the topology resolver', () => {
      const unboundHelper = [
        'function buildFlowSelectionTransition(event, at) {',
        "  const to = 'PEER_REVIEW';",
        "  return { from: 'READY', to, event, at };",
        '}',
      ].join('\n');
      const violations = findAll(unboundHelper, 'rails/types.ts');
      expect(
        violations.some((v) => v.rule === 'controlled-helper-without-topology-derivation'),
      ).toBe(true);
    });

    it('D3 fires on a local copy of a canonical progression (order and extras irrelevant)', () => {
      expect(
        findAll("new Set(['ARCHITECTURE', 'ARCH_REVIEW', 'ARCH_COMPLETE']);").some(
          (v) => v.rule === 'local-flow-phase-enumeration',
        ),
      ).toBe(true);
      expect(
        findAll("const archPhases = ['ARCH_COMPLETE', 'ARCHITECTURE', 'ARCH_REVIEW'];").some(
          (v) => v.rule === 'local-flow-phase-enumeration',
        ),
      ).toBe(true);
      expect(
        findAll("['ARCHITECTURE', 'ARCH_REVIEW', 'ARCH_COMPLETE', 'ABORTED'];").some(
          (v) => v.rule === 'local-flow-phase-enumeration',
        ),
      ).toBe(true);
    });

    it('D3 does NOT fire on legitimate subsets or user-gate classifications', () => {
      expect(findAll("new Set<Phase>(['TICKET', 'PLAN']);")).toEqual([]);
      expect(findAll("['PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW'];")).toEqual([]);
      expect(findAll("['READY', 'ABORTED'];")).toEqual([]);
    });

    it('authority paths are exempt; the same content elsewhere is a violation', () => {
      const fullPhaseEnum = [
        'export const Phase = z.enum([',
        "  'READY', 'TICKET', 'PLAN', 'PLAN_REVIEW', 'VALIDATION', 'IMPLEMENTATION',",
        "  'IMPL_VALIDATION', 'IMPL_REVIEW', 'EVIDENCE_REVIEW', 'EXPORT_READY', 'COMPLETE',",
        "  'ARCHITECTURE', 'ARCH_REVIEW', 'ARCH_COMPLETE', 'PEER_REVIEW', 'PEER_REVIEW_COMPLETE',",
        "  'REJECTED', 'ABORTED',",
        ']);',
      ].join('\n');
      expect(
        scanFiles([{ rel: 'state/schema.ts', content: fullPhaseEnum }]).some(
          (v) => v.rule === 'local-flow-phase-enumeration',
        ),
      ).toBe(false);
      expect(
        scanFiles([{ rel: 'rails/rogue.ts', content: fullPhaseEnum }]).some(
          (v) => v.rule === 'local-flow-phase-enumeration',
        ),
      ).toBe(true);
    });
  });
});
