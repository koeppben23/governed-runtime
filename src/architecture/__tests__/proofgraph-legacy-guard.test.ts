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
});
