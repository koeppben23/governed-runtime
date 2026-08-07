/**
 * @module architecture/proofgraph-legacy-guard
 * @description Enforce that proofgraph legacy terms are not reintroduced
 * after the assertion-only counterexample refactoring (PR 5).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..');

const FILES = [
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

describe('proofgraph legacy guard', () => {
  it('no files in scope contain legacy proofgraph terms', () => {
    const violations: string[] = [];
    for (const rel of FILES) {
      const content = readFileSync(join(SRC, rel), 'utf-8');
      for (const regex of FORBIDDEN) {
        if (regex.test(content)) {
          violations.push(`${rel}: ${regex}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
