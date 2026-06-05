/**
 * @module audit/tamper-evidence.fuzz
 * @description Deep-run (nightly) variant of the audit tamper-evidence property
 * invariants (#435). Identical invariants to `tamper-evidence.property.test.ts`,
 * but in the FUZZ project so `npm run test:fuzz:deep` exercises them at high
 * `numRuns` (e.g. 10,000) via the nightly workflow. The unit variant gates
 * `npm test`/release at the default run count; this variant widens the search.
 *
 * Both variants delegate ALL logic to the single shared, fast-check-free harness
 * (`tamper-evidence-harness.ts`) — no duplicated hashing or generation logic;
 * only the thin fast-check wiring differs per Vitest project glob.
 *
 * run control:
 *   npm run test:fuzz                       # default numRuns (100), seed 12345
 *   npm run test:fuzz:deep                  # FAST_CHECK_NUM_RUNS=10000
 *   FAST_CHECK_SEED=12345 npm run test:fuzz # reproduce a counterexample
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/435
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  buildRichEvent,
  collectLeafPaths,
  isExcludedPath,
  mutatedChainVerifies,
  pristineChainVerifies,
  imprintDigest,
  mutateLeaf,
  canonical,
  chainHashOf,
  deepReorderKeys,
  type RichEventParams,
  type ChainedAuditEventForTest,
} from './tamper-evidence-harness.js';

const FC_OPTIONS = {
  numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
  seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
  endOnFailure: true,
} as const;

const paramsArb: fc.Arbitrary<RichEventParams> = fc.record({
  idHex: fc.string({ minLength: 1, maxLength: 12 }),
  phase: fc.constantFrom('PLAN', 'VALIDATION', 'IMPLEMENTATION', 'COMPLETE', 'REVIEW'),
  eventName: fc.constantFrom('decision:DEC-1', 'transition:APPROVE', 'tool_call:run'),
  minute: fc.integer({ min: 0, max: 59 }),
  actor: fc.constantFrom('human', 'machine', 'system'),
  rationale: fc.string({ maxLength: 40 }),
  decisionSequence: fc.integer({ min: 0, max: 100_000 }),
  autoAdvanced: fc.boolean(),
  audience: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 3 }),
  issuer: fc.string({ minLength: 1, maxLength: 12 }),
});

function pick<T>(items: readonly T[], selector: number): T {
  return items[selector % items.length]!;
}

describe('audit tamper-evidence property invariants — deep fuzz (#435)', () => {
  it('P-A (C1): any single-leaf mutation at any depth breaks chain verification', () => {
    fc.assert(
      fc.property(paramsArb, fc.integer({ min: 0, max: 1_000_000 }), (params, selector) => {
        const event = buildRichEvent(params);
        const path = pick(collectLeafPaths(event), selector);
        expect(mutatedChainVerifies(event, path)).toBe(false);
      }),
      FC_OPTIONS,
    );
  });

  it('P-B (C2): mutating a non-excluded content leaf changes the canonical digest', () => {
    fc.assert(
      fc.property(paramsArb, fc.integer({ min: 0, max: 1_000_000 }), (params, selector) => {
        const event = buildRichEvent(params);
        const contentPaths = collectLeafPaths(event).filter((p) => !isExcludedPath(p));
        const path = pick(contentPaths, selector);
        expect(imprintDigest(mutateLeaf(event, path))).not.toBe(imprintDigest(event));
      }),
      FC_OPTIONS,
    );
  });

  it("P-B' (C2): mutating any imprint-excluded field leaves the canonical digest unchanged", () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        const event = buildRichEvent(params);
        const baseline = imprintDigest(event);
        const excludedPaths = collectLeafPaths(event).filter(isExcludedPath);
        for (const path of excludedPaths) {
          expect(imprintDigest(mutateLeaf(event, path))).toBe(baseline);
        }
        expect(excludedPaths.length).toBeGreaterThan(0);
      }),
      FC_OPTIONS,
    );
  });

  it('P-C (S1): deep object-key reorder (arrays preserved) is canonicalization-stable', () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        const event = buildRichEvent(params);
        const reordered = deepReorderKeys(event) as ChainedAuditEventForTest;
        expect(canonical(reordered)).toBe(canonical(event));
        expect(chainHashOf(reordered)).toBe(chainHashOf(event));
        expect(imprintDigest(reordered)).toBe(imprintDigest(event));
        expect(pristineChainVerifies(reordered)).toBe(true);
      }),
      FC_OPTIONS,
    );
  });
});
