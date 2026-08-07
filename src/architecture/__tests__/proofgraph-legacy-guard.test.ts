/**
 * @module architecture/proofgraph-legacy-guard
 * @description Enforce that proofgraph legacy terms are not reintroduced
 * after the assertion-only counterexample refactoring (PR 5).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { globSync } from 'tinyglobby';

const SRC_ROOT = resolve(import.meta.dirname, '..', '..');
const PROD_ROOT = join(SRC_ROOT, 'src');

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

const SCOPE_PATTERNS = [
  'state/proofgraph.ts',
  'state/proofgraph-approval.ts',
  'state/evidence-validation.ts',
  'adapters/persistence.ts',
  'audit/proofgraph/*.ts',
  'integration/proofgraph/*.ts',
  'integration/tools/declare-contract.ts',
];

describe('proofgraph legacy guard', () => {
  const files = SCOPE_PATTERNS.flatMap((pattern) => globSync(pattern, { cwd: PROD_ROOT }));

  it('no files in scope contain legacy proofgraph terms', () => {
    const violations: string[] = [];
    for (const rel of files) {
      const content = readFileSync(join(PROD_ROOT, rel), 'utf-8');
      for (const regex of FORBIDDEN) {
        if (regex.test(content)) {
          violations.push(`${rel}: ${regex}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
