/**
 * @module architecture/fail-closed-decision-contract
 * @description Structural guard for fail-closed decisions.
 *
 * Invariants:
 *   F1 A denied decision REQUIRES `code` and `reason`; a missing field fails the
 *      build. An allowed decision cannot carry concrete denial metadata.
 *      Compile-time contracts plus proving `@ts-expect-error` fixtures.
 *   F2 Consumers must not re-open the contract with non-null assertions:
 *      a `NonNullExpression` on `.code` / `.reason` is rejected default-wide over
 *      production source. The detector unwraps parentheses and covers property
 *      access, string-literal element access, and template-literal element access,
 *      so `decision['code']!` or `(decision.code)!` cannot bypass it.
 *   F3 The scan is default-wide via `production-source.ts` with no allowlist.
 *
 * Compiler note: with `exactOptionalPropertyTypes` enabled (`tsconfig.json`),
 * an allowed decision cannot spell `code: undefined`, and a denied decision
 * cannot spell `code: undefined` or `reason: undefined`. A concrete denial code
 * is forbidden on allowed decisions regardless.
 *
 * @version v1
 */

import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { DeniedRiskClassificationDecision } from '../../integration/phase-tool-gate.js';
import type { GateDecision } from '../../shared/gate-decision.js';
import { collectProductionSources, type ProductionSourceFile } from './production-source.js';

const SRC_ROOT = join(process.cwd(), 'src');

// ─── F1: compile-time contracts (proven by `check`) ──────────────────────────

type TestCode = 'DENIED';

const _allowedDecision: GateDecision<TestCode> = { allowed: true };
const _deniedDecision: GateDecision<TestCode> = {
  allowed: false,
  code: 'DENIED',
  reason: 'reason',
};

// @ts-expect-error — denied decisions require a code
const _missingCodeMustFail: GateDecision<TestCode> = { allowed: false, reason: 'reason' };

// @ts-expect-error — denied decisions require a reason
const _missingReasonMustFail: GateDecision<TestCode> = { allowed: false, code: 'DENIED' };

type Decision = GateDecision<TestCode>;

// @ts-expect-error — denied decisions reject an explicit `code: undefined`
const _undefinedCodeMustFail: Decision = { allowed: false, code: undefined, reason: 'r' };

// @ts-expect-error — denied decisions reject an explicit `reason: undefined`
const _undefinedReasonMustFail: Decision = { allowed: false, code: 'DENIED', reason: undefined };

// @ts-expect-error — allowed decisions reject an explicit `code: undefined`
const _allowedUndefinedCodeMustFail: Decision = { allowed: true, code: undefined };

// @ts-expect-error — allowed decisions reject an explicit `reason: undefined`
const _allowedUndefinedReasonMustFail: Decision = { allowed: true, reason: undefined };

const pollutedAllowValue = { allowed: true as const, code: 'DENIED', reason: 'reason' };

// @ts-expect-error — an allowed decision cannot carry concrete denial metadata
const _pollutedAllowMustFail: GateDecision<TestCode> = pollutedAllowValue;

const _deniedRiskDecision: DeniedRiskClassificationDecision = {
  allowed: false,
  code: 'RISK_CLASSIFICATION_MISMATCH',
  reason: 'blocked',
  decisionId: 'risk-1',
  minimumTaskClass: 'HIGH-RISK',
  touchedSurfaces: [],
  riskTriggers: [],
  changedFiles: [],
};

const allowedRiskDecisionValue = {
  allowed: true as const,
  decisionId: 'risk-2',
  minimumTaskClass: 'TRIVIAL' as const,
  touchedSurfaces: [],
  riskTriggers: [],
  changedFiles: [],
};

// @ts-expect-error — an allowed risk decision is not a denied decision
const _allowedRiskDecisionMustFail: DeniedRiskClassificationDecision = allowedRiskDecisionValue;

interface Violation {
  readonly rel: string;
  readonly line: number;
  readonly snippet: string;
  readonly rule: string;
}

function parse(content: string, rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visit(node: ts.Node, cb: (node: ts.Node) => void): void {
  cb(node);
  node.forEachChild((child) => visit(child, cb));
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** `code`/`reason` accessed as a property or string/template-literal element. */
function denialMetadataName(expression: ts.Expression): string | undefined {
  const target = unwrapParentheses(expression);
  if (ts.isPropertyAccessExpression(target)) {
    return target.name.text === 'code' || target.name.text === 'reason'
      ? target.name.text
      : undefined;
  }
  if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    if (argument && ts.isStringLiteralLike(argument)) {
      return argument.text === 'code' || argument.text === 'reason' ? argument.text : undefined;
    }
  }
  return undefined;
}

/** F2: non-null assertions on denial metadata outside the type contract. */
function findNonNullDenialMetadataViolations(sourceFile: ts.SourceFile, rel: string): Violation[] {
  const out: Violation[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isNonNullExpression(node)) return;
    const name = denialMetadataName(node.expression);
    if (name === undefined) return;
    out.push({
      rel,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      snippet: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 120).trim(),
      rule: 'non-null-denial-metadata',
    });
  });
  return out;
}

const productionFiles = collectProductionSources(SRC_ROOT);

describe('fail-closed decision contract', () => {
  it('F1: denied decisions narrow to required code and reason at runtime', () => {
    const denied: GateDecision<TestCode> = { allowed: false, code: 'DENIED', reason: 'reason' };
    if (denied.allowed) throw new Error('unreachable');
    expect(typeof denied.code).toBe('string');
    expect(typeof denied.reason).toBe('string');
  });

  it('F2/F3: production code never uses non-null assertions on denial metadata', () => {
    const violations = productionFiles.flatMap((file) =>
      findNonNullDenialMetadataViolations(parse(file.content, file.rel), file.rel),
    );
    if (violations.length > 0) {
      console.error('Fail-closed decision violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  it('F3: the scan is default-wide and excludes test sources', () => {
    const rels = productionFiles.map((file) => file.rel);
    expect(rels).toContain('hooks/pre-tool-use.ts');
    expect(rels).toContain('integration/plugin-beforehooks.ts');
    expect(rels).toContain('integration/plugin-afterhooks.ts');
    expect(rels).not.toContain('architecture/__tests__/fail-closed-decision-contract.test.ts');
  });

  describe('negative fixtures — prove every detector', () => {
    const findAll = (content: string, rel = 'hooks/rogue.ts'): Violation[] =>
      findNonNullDenialMetadataViolations(parse(content, rel), rel);

    it('fires on property access, element access, and parenthesized access', () => {
      for (const fixture of [
        'const c = decision.code!;',
        'const c = decision.reason!;',
        "const c = decision['code']!;",
        'const c = decision[`reason`]!;',
        'const c = (decision.code)!;',
        'const c = ((decision.reason))!;',
      ]) {
        expect(
          findAll(fixture).some((v) => v.rule === 'non-null-denial-metadata'),
          fixture,
        ).toBe(true);
      }
    });

    it('does NOT fire on non-null receivers or non-metadata keys', () => {
      for (const fixture of [
        'const x = matched!.code;',
        'const x = items[0]!;',
        "const x = lookup('code')!;",
        'const x = decision.code;',
        'const x = decision.reason;',
      ]) {
        expect(findAll(fixture), fixture).toEqual([]);
      }
    });
  });
});
