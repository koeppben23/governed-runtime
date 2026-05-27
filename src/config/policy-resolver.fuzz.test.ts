/**
 * @module config/policy-resolver.fuzz.test
 * @description Property-based fuzz tests for policy snapshot normalization.
 *
 * Generates arbitrary config objects and verifies:
 * - normalizePolicySnapshotWithMeta either returns a valid snapshot or throws PolicyConfigurationError
 * - Invalid mode strings always throw (never silently pass)
 * - Output snapshots have all required fields populated with defined values
 * - Malformed input never silently passes without normalized/reason evidence
 *
 * run control:
 *   FAST_CHECK_NUM_RUNS=100 npx vitest run --project fuzz
 *   FAST_CHECK_SEED=12345 npx vitest run --project fuzz
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/347
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { normalizePolicySnapshotWithMeta } from './policy-snapshot.js';
import { PolicyConfigurationError } from './policy-errors.js';

describe('policy resolver fuzz', () => {
  it('invalid mode string always throws PolicyConfigurationError, never silently passes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('invalid'),
          fc.constant('solo '),
          fc.constant('REGULATED'),
          fc.constant(''),
          fc.constant('team-ci-missing'),
          fc
            .string({ minLength: 1, maxLength: 20 })
            .filter((s) => !['solo', 'team', 'team-ci', 'regulated'].includes(s)),
        ),
        (mode) => {
          expect(() => normalizePolicySnapshotWithMeta({ mode, hash: 'test' })).toThrow(
            PolicyConfigurationError,
          );
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('normalizePolicySnapshotWithMeta always returns valid snapshot or throws PolicyConfigurationError', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.object({ maxDepth: 3 }), fc.constant(null), fc.constant(undefined)),
        (rawSnapshot) => {
          try {
            const result = normalizePolicySnapshotWithMeta(rawSnapshot as Record<string, unknown>);
            const snap = result.snapshot;

            // Required fields must be strings with content
            expect(typeof snap.mode).toBe('string');
            expect(snap.mode.length).toBeGreaterThan(0);
            expect(typeof snap.hash).toBe('string');
            expect(snap.hash.length).toBeGreaterThan(0);
            expect(typeof snap.resolvedAt).toBe('string');

            // Governance fields must be defined, non-undefined
            expect(snap.requireHumanGates !== undefined).toBe(true);
            expect(typeof snap.requireHumanGates).toBe('boolean');
            expect(typeof snap.maxSelfReviewIterations).toBe('number');
            expect(typeof snap.allowSelfApproval).toBe('boolean');
            expect(snap.audit).toBeDefined();
            expect(snap.actorClassification).toBeDefined();
            expect(typeof snap.minimumActorAssuranceForApproval).toBe('string');
            expect(typeof snap.identityProviderMode).toBe('string');
            expect(typeof snap.enforceRiskClassification).toBe('boolean');
            expect(snap.selfReview).toBeDefined();
          } catch (err) {
            // Throwing PolicyConfigurationError is valid (fail-closed)
            if (!(err instanceof PolicyConfigurationError)) {
              throw err;
            }
          }
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('malformed input never silently passes — normalized flag or reason must be present when input is recycled', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.object({ maxDepth: 2, maxKeys: 5 }),
          fc.dictionary(fc.string({ minLength: 1 }), fc.anything()),
        ),
        (rawInput) => {
          try {
            const result = normalizePolicySnapshotWithMeta(rawInput as Record<string, unknown>);

            // The key invariant: if the input is missing a mode (null/undefined snapshot),
            // the output must be marked as normalized.
            if (rawInput === null || rawInput === undefined) {
              expect(result.normalized).toBe(true);
              expect(result.reason).toBe('incomplete_snapshot_normalized');
            }

            // If normalized, the reason field must give an explanation
            if (result.normalized) {
              expect(typeof result.reason).toBe('string');
              expect(result.reason!.length).toBeGreaterThan(0);
            }

            // Snapshot must always have a valid mode
            expect(['solo', 'team', 'team-ci', 'regulated']).toContain(result.snapshot.mode);
            expect(result.snapshot.hash).toBeDefined();
          } catch (err) {
            if (!(err instanceof PolicyConfigurationError)) {
              throw err;
            }
          }
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });
});
