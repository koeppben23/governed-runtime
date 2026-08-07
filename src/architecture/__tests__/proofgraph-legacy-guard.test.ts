/**
 * @module architecture/proofgraph-legacy-guard
 * @description Enforce that proofgraph legacy terms are not reintroduced
 * after the assertion-only counterexample refactoring (PR 5).
 * PR 9 extends: gate purity, provider-switch prevention, legacy-text removal.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..');

const LEGACY_FILES = [
  'state/proofgraph.ts',
  'state/proofgraph-approval.ts',
  'state/evidence-validation.ts',
  'adapters/persistence.ts',
  'audit/proofgraph/counterexample-binder.ts',
  'audit/proofgraph/evaluate.ts',
  'integration/proofgraph/claim-contract.ts',
  'integration/proofgraph/materialize-contract.ts',
  'integration/tools/declare-contract.ts',
];

const GATE_FILES = [
  'audit/proofgraph/gate.ts',
  'audit/proofgraph/evaluate.ts',
  'audit/proofgraph/enforcement-projection.ts',
  'audit/proofgraph/assertion-evidence-binding.ts',
  'rails/review-decision.ts',
  'machine/guards.ts',
  'verification/executor.ts',
  'verification/assertion-extractor.ts',
  'verification/assertion-report-collector.ts',
];

const PROOFGRAPH_CORE_FILES = [
  'audit/proofgraph/evaluate.ts',
  'audit/proofgraph/gate.ts',
  'audit/proofgraph/enforcement-projection.ts',
  'audit/proofgraph/assertion-evidence-binding.ts',
  'audit/proofgraph/counterexample-binder.ts',
  'audit/proofgraph/executed-test-binder.ts',
  'audit/proofgraph/derive.ts',
];

const FORBIDDEN = [
  /counterexampleCheckId/,
  /LEGACY_PROVIDER_BY_PREFIX/,
  /migrateLegacyAssertion/,
  /migrateLegacyPlanClaims/,
  /LegacyPlanClaimZ/,
  /LegacyAssertionRequirementZ/,
  /LegacyStructuredAssertionEvidenceZ/,
  /mode:\s*z\.literal\('check'\)/,
  /mode === 'check'/,
  /mode:\s*'check'/,
];

const PROVIDER_SWITCH_PATTERNS = [
  /case\s+['"]vitest['"]/,
  /case\s+['"]jest['"]/,
  /case\s+['"]pytest['"]/,
  /case\s+['"]junit['"]/,
  /case\s+['"]go_test['"]/,
  /switch\s*\(\s*providerId/,
  /switch\s*\(\s*provider/,
  // Source-string heuristics (no longer used after PR 10)
  /"repo:mvnw"/,
  /"repo:gradlew"/,
  /"detectedStack:testFramework:"/,
  /`\$\{framework\}-fallback`/,
  /`\$\{framework\}-stdout`/,
];

const GATE_BOUNDARY_IMPORTS = [
  /assertion-parsers/,
  /toolchain-probe/,
  /verification-script-analysis/,
];

const LEGACY_RECOVERY = [/mode=check/];

describe('proofgraph legacy guard', () => {
  it('no files in scope contain legacy proofgraph terms', () => {
    const violations: string[] = [];
    for (const rel of LEGACY_FILES) {
      const content = readFileSync(join(SRC, rel), 'utf-8');
      for (const regex of FORBIDDEN) {
        if (regex.test(content)) {
          violations.push(`${rel}: ${regex}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('counterexample binder must not fall back to check-level outcome classification', () => {
    const content = readFileSync(join(SRC, 'audit/proofgraph/counterexample-binder.ts'), 'utf-8');
    const hasCheckLevelFallback = /toCounterexampleOutcome/.test(content);
    expect(hasCheckLevelFallback).toBe(false);
  });

  it('gate-participating files do not import assertion-parsers or toolchain-probe', () => {
    const violations: string[] = [];
    for (const rel of GATE_FILES) {
      const content = readFileSync(join(SRC, rel), 'utf-8');
      for (const regex of GATE_BOUNDARY_IMPORTS) {
        if (regex.test(content)) {
          violations.push(`${rel}: ${regex}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no provider switches in proofgraph core files', () => {
    const violations: string[] = [];
    for (const rel of PROOFGRAPH_CORE_FILES) {
      const content = readFileSync(join(SRC, rel), 'utf-8');
      for (const regex of PROVIDER_SWITCH_PATTERNS) {
        if (regex.test(content)) {
          violations.push(`${rel}: ${regex}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('state layer must not import from providers/', () => {
    const STATE_FILES = [
      'state/schema.ts',
      'state/proofgraph.ts',
      'state/proofgraph-primitives.ts',
      'state/proofgraph-approval.ts',
      'state/proofgraph-refs.ts',
      'state/evidence-validation.ts',
      'state/discovery-schemas.ts',
      'state/assertion-identity.ts',
    ];
    const violations: string[] = [];
    for (const rel of STATE_FILES) {
      const content = readFileSync(join(SRC, rel), 'utf-8');
      if (/import.*from.*['"]\.\.\/providers\//.test(content)) {
        violations.push(rel);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no mode=check recovery text in reason codes or proofgraph files', () => {
    const files = ['config/reasons-proofgraph.ts', ...PROOFGRAPH_CORE_FILES];
    const violations: string[] = [];
    for (const rel of files) {
      const content = readFileSync(join(SRC, rel), 'utf-8');
      for (const regex of LEGACY_RECOVERY) {
        if (regex.test(content)) {
          violations.push(`${rel}: ${regex}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('execution-subject resolution must not derive behavior from candidate.source or candidate.command', () => {
    const files = [
      'verification/execution-subject.ts',
      'verification/executor.ts',
      'integration/tools/run-check-tool.ts',
    ];
    const violations: string[] = [];
    for (const rel of files) {
      const content = readFileSync(join(SRC, rel), 'utf-8');
      if (
        /\.source\s*===\s*['"]/.test(content) ||
        /\.source\.startsWith/.test(content) ||
        /\.command\s*===\s*['"]/.test(content) ||
        /\.command\.includes/.test(content) ||
        /Object\.values\(.*scripts/.test(content) ||
        /isPackageScript/.test(content)
      ) {
        violations.push(
          `${rel}: derives semantic behavior from VerificationCandidate.source or .command`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
