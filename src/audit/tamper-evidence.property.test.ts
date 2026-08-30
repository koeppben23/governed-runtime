/**
 * @module audit/tamper-evidence.property.test
 * @description Property-based tamper-evidence invariants for audit verification
 * (#435), run in the UNIT project so they gate `npm test` and `release:verify`.
 *
 * Proves the C1/C2 guarantee GENERALLY rather than by example: for any audit
 * event and any single-field mutation at any nesting depth (including array
 * elements), recomputation/verification MUST fail; and structurally-equal but
 * key-reordered events MUST still verify. Complements (does not replace) the
 * example tests in `canonical-digest.test.ts` and the chain-structure fuzz in
 * `state/evidence-audit.fuzz.test.ts`.
 *
 * All hashing/serialization is delegated to the production authorities via the
 * shared, fast-check-free harness (no duplicated hashing logic). The deep-run
 * variant lives in `tamper-evidence.fuzz.test.ts`.
 *
 * Determinism: fixed seed → reproducible counterexamples; fast-check shrinking
 * reports the minimal offending (params, path). Fail-closed: a passing verify
 * on a mutated event is a hard test failure.
 *
 * run control:
 *   FAST_CHECK_NUM_RUNS=100 npx vitest run --project unit src/audit/tamper-evidence.property.test.ts
 *   FAST_CHECK_SEED=12345 npx vitest run --project unit src/audit/tamper-evidence.property.test.ts
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
} from './__tests__/tamper-evidence-harness.js';

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

/** Pick the path at `selector % paths.length` (stable indexing for shrinking). */
function pick<T>(items: readonly T[], selector: number): T {
  return items[selector % items.length]!;
}

describe('audit tamper-evidence property invariants (#435)', () => {
  it('baseline: a freshly built event verifies (sanity for the generator)', () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        const event = buildRichEvent(params);
        expect(pristineChainVerifies(event)).toBe(true);
      }),
      FC_OPTIONS,
    );
  });

  it('P-A (C1): any single CONTENT-leaf mutation breaks chain verification', () => {
    // Authority fields (chainHash/prevHash/auditSequence/recordedAt/
    // semanticEventDigest/timestampEvidence) are append-lock stamped, not
    // producer content; their mutation coverage lives in the dedicated
    // hash-authority unit tests (audit-integrity.test.ts). Every CONTENT
    // leaf is bound by the semanticEventDigest authority, so a mutated event
    // that still verifies is a hard failure.
    fc.assert(
      fc.property(paramsArb, fc.integer({ min: 0, max: 1_000_000 }), (params, selector) => {
        const event = buildRichEvent(params);
        const contentPaths = collectLeafPaths(event).filter((p) => !isExcludedPath(p));
        expect(contentPaths.length).toBeGreaterThan(0);
        const path = pick(contentPaths, selector);
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
        expect(contentPaths.length).toBeGreaterThan(0);
        const path = pick(contentPaths, selector);
        const before = imprintDigest(event);
        const after = imprintDigest(mutateLeaf(event, path));
        expect(after).not.toBe(before);
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
        // Characterize the production strip-set: EVERY excluded leaf is digest-invariant.
        for (const path of excludedPaths) {
          expect(imprintDigest(mutateLeaf(event, path))).toBe(baseline);
        }
        // And there is at least one excluded leaf (the event actually carries them).
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
        // Same canonical serialization, chain hash, and digest ⇒ still verifies.
        expect(canonical(reordered)).toBe(canonical(event));
        expect(chainHashOf(reordered)).toBe(chainHashOf(event));
        expect(imprintDigest(reordered)).toBe(imprintDigest(event));
        expect(pristineChainVerifies(reordered)).toBe(true);
      }),
      FC_OPTIONS,
    );
  });
});
