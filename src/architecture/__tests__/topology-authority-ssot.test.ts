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
 *      to numeric values (any variable name) re-creates a rank authority.
 *   D2 `local-ready-flow-transition` — outside the controlled helper surface:
 *      every `applyTransition(..., 'READY', ...)` (literal OR variable target)
 *      and every transition-shaped object literal with `from: 'READY'` plus
 *      `to`/`event` is a flow-selection bypass. The only admissible object is
 *      `rails/types.ts`'s `buildFlowSelectionTransition`, which must derive the
 *      target from `resolveTransition('READY', event)` (asserted below).
 *   D3 `local-flow-phase-enumeration` — an array literal (also inside
 *      `new Set([...])`) whose phase set fully contains a canonical
 *      `FLOW_PHASES` progression re-creates the ordering authority; order is
 *      irrelevant. `machine/topology.ts` (authority) and `state/schema.ts`
 *      (Phase vocabulary) are exempt. Legitimate subsets such as a command's
 *      allowed phases or the user-gate classification are not flagged.
 *
 * @version v1
 */

import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { FLOW_PHASES, TRANSITIONS } from '../../machine/topology.js';
import { collectProductionSources, type ProductionSourceFile } from './production-source.js';

const SRC_ROOT = join(process.cwd(), 'src');

/** D1 exemption: the topology is the rank authority (it currently defines none). */
const D1_AUTHORITY = new Set<string>(['machine/topology.ts']);

/** D2 exemption: the topology plus the single controlled derivation helper. */
const D2_ALLOWED = new Set<string>(['machine/topology.ts', 'rails/types.ts']);

/** D3 exemption: the progression authority and the Phase vocabulary authority. */
const D3_AUTHORITY = new Set<string>(['machine/topology.ts', 'state/schema.ts']);

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

function report(sourceFile: ts.SourceFile, node: ts.Node, rel: string, rule: string): Violation {
  return {
    rel,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    snippet: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 140).trim(),
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
      if (ts.isNumericLiteral(property.initializer)) numericPhaseEntries += 1;
    }
    if (numericPhaseEntries >= 2) out.push(report(sourceFile, node, rel, 'local-phase-rank-table'));
  });
  return out;
}

/** D2: locally materialized READY flow-selection transitions. */
function findLocalReadyFlowTransitions(sourceFile: ts.SourceFile, rel: string): Violation[] {
  const out: Violation[] = [];
  visit(sourceFile, (node) => {
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
    const initializers = new Map<string, ts.Expression>();
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property);
      if (name) initializers.set(name, property.initializer);
    }
    const from = initializers.get('from');
    if (!from || !ts.isStringLiteralLike(from) || from.text !== 'READY') return;
    if (!initializers.has('to') || !initializers.has('event')) return;
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
    if (!D2_ALLOWED.has(file.rel)) {
      out.push(...findLocalReadyFlowTransitions(sourceFile, file.rel));
    }
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

  it('D2 exemption is honest: the helper derives READY targets from resolveTransition', () => {
    const helper = productionFiles.find((file) => file.rel === 'rails/types.ts');
    expect(helper, 'rails/types.ts must exist').toBeTruthy();
    const sourceFile = parse(helper!.content, helper!.rel);
    let derivesFromTopology = false;
    visit(sourceFile, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'resolveTransition'
      ) {
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first) && first.text === 'READY') {
          derivesFromTopology = true;
        }
      }
    });
    expect(derivesFromTopology).toBe(true);
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

    it('D1 fires on a numeric phase-rank object and not on string labels', () => {
      expect(
        findAll('const rank = { PLAN: 1, PLAN_REVIEW: 2, VALIDATION: 3 };').some(
          (v) => v.rule === 'local-phase-rank-table',
        ),
      ).toBe(true);
      expect(findAll("const labels = { PLAN: 'plan', PLAN_REVIEW: 'review' };")).toEqual([]);
      expect(findAll('const single = { COMPLETE: 1 };')).toEqual([]);
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

    it('D2 fires on the variable-target bypass (literal from, variable to)', () => {
      const bypass = [
        "const target = 'PEER_REVIEW';",
        "applyTransition(state, 'READY', target, 'PEER_REVIEW_SELECTED', at);",
      ].join('\n');
      expect(findAll(bypass).some((v) => v.rule === 'local-ready-flow-transition')).toBe(true);

      const literalBypass = [
        "const target = 'PEER_REVIEW';",
        "const tr = { from: 'READY', to: target, event: 'PEER_REVIEW_SELECTED', at };",
      ].join('\n');
      expect(findAll(literalBypass).some((v) => v.rule === 'local-ready-flow-transition')).toBe(
        true,
      );
    });

    it('D2 does NOT fire on the controlled derivation or on non-READY applyTransition', () => {
      const derived = [
        "const to = resolveTransition('READY', event);",
        "const tr = { from: 'READY', to, event, at };",
      ].join('\n');
      expect(findAll(derived)).toEqual([]);
      expect(findAll('applyTransition(state, state.phase, target, event, at);')).toEqual([]);
      expect(
        findAll("applyTransition(state, 'IMPL_VALIDATION', 'IMPL_REVIEW', event, at);"),
      ).toEqual([]);
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

      const readyLiteral = "const tr = { from: 'READY', to: 'TICKET', event: 'TICKET_SELECTED' };";
      expect(scanFiles([{ rel: 'machine/topology.ts', content: readyLiteral }])).toEqual([]);
      expect(
        scanFiles([{ rel: 'rails/rogue.ts', content: readyLiteral }]).some(
          (v) => v.rule === 'local-ready-flow-transition',
        ),
      ).toBe(true);
    });
  });
});
