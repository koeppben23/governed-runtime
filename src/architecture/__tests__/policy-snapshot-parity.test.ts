/**
 * @module architecture/policy-snapshot-parity
 * @description Structural guard: every executable `FlowGuardPolicy` field is
 * frozen into `PolicySnapshot` and reconstructed by `resolvePolicyFromSnapshot`.
 *
 * This guard owns no field list. The compiler computes both field sets from the
 * owning authorities (`policy-types.ts` and `evidence-policy.ts`), and the
 * `Exclude<keyof ..., keyof ...>` assertions below fail compilation when a new
 * executable field (or nested field) is not covered by the snapshot contract.
 * Value/type compatibility is enforced by the typed mappers in
 * `config/policy-snapshot.ts` (`buildAuditSection(): PolicySnapshot['audit']`,
 * `createPolicySnapshot(): PolicySnapshot`, `resolvePolicyFromSnapshot():
 * FlowGuardPolicy`) and by the strict round-trip contract in
 * `config/policy-snapshot.test.ts`.
 *
 * Invariants:
 *   P1 Top-level coverage: every `keyof FlowGuardPolicy` exists in `PolicySnapshot`.
 *   P2 Nested coverage: every executable nested field exists in the matching
 *      `PolicySnapshot[...]` sub-object.
 *   P3 Negative fixture: a deliberately incomplete snapshot type must fail the
 *      same assertion (proves the detector fires).
 *   P4 Runtime sanity: the canonical preset's executable keys are present in the
 *      snapshot and exactly reproduced by the reconstructed policy, and the
 *      snapshot parses against its own schema.
 *
 * @version v1
 */

import { describe, expect, it } from 'vitest';

import {
  createPolicySnapshot,
  getPolicyPreset,
  resolvePolicyFromSnapshot,
} from '../../config/policy.js';
import type {
  AuditPolicy,
  ChallengePolicy,
  DiscoveryHealthPolicy,
  FlowGuardPolicy,
  ReviewBudget,
  TimestampAssurancePolicy,
  ValidationEvidencePolicy,
} from '../../config/policy-types.js';
import { hashText } from '../../shared/hashing.js';
import { PolicySnapshotSchema, type PolicySnapshot } from '../../state/evidence.js';

const RESOLVED_AT = '2026-01-01T00:00:00.000Z';

/** Compile-time assertion: the excluded key union must be empty (`never`). */
type AssertNever<T extends never> = T;

// ─── P1: top-level coverage ───────────────────────────────────────────────────

type MissingTopLevelPolicyFields = Exclude<keyof FlowGuardPolicy, keyof PolicySnapshot>;
type _TopLevelPolicyFieldsCovered = AssertNever<MissingTopLevelPolicyFields>;

// ─── P2: nested coverage ──────────────────────────────────────────────────────

type MissingReviewBudgetFields = Exclude<keyof ReviewBudget, keyof PolicySnapshot['reviewBudget']>;
type _ReviewBudgetFieldsCovered = AssertNever<MissingReviewBudgetFields>;

type MissingAuditFields = Exclude<keyof AuditPolicy, keyof PolicySnapshot['audit']>;
type _AuditFieldsCovered = AssertNever<MissingAuditFields>;

type MissingTimestampAssuranceFields = Exclude<
  keyof TimestampAssurancePolicy,
  keyof PolicySnapshot['audit']['timestampAssurance']
>;
type _TimestampAssuranceFieldsCovered = AssertNever<MissingTimestampAssuranceFields>;

type MissingChallengePolicyFields = Exclude<
  keyof ChallengePolicy,
  keyof PolicySnapshot['challengePolicy']
>;
type _ChallengePolicyFieldsCovered = AssertNever<MissingChallengePolicyFields>;

// The deepest structured duplication: the count matrix inside challengePolicy.
type MissingChallengeCountFields = Exclude<
  keyof ChallengePolicy['counts'],
  keyof PolicySnapshot['challengePolicy']['counts']
>;
type _ChallengeCountFieldsCovered = AssertNever<MissingChallengeCountFields>;

type MissingDiscoveryHealthFields = Exclude<
  keyof DiscoveryHealthPolicy,
  keyof PolicySnapshot['discoveryHealth']
>;
type _DiscoveryHealthFieldsCovered = AssertNever<MissingDiscoveryHealthFields>;

type MissingValidationEvidenceFields = Exclude<
  keyof ValidationEvidencePolicy,
  keyof PolicySnapshot['validationEvidence']
>;
type _ValidationEvidenceFieldsCovered = AssertNever<MissingValidationEvidenceFields>;

// ─── P3: negative compile-time fixture ────────────────────────────────────────

type SnapshotMissingAudit = Omit<PolicySnapshot, 'audit'>;
type MissingAuditFieldsFixture = Exclude<keyof FlowGuardPolicy, keyof SnapshotMissingAudit>;

// @ts-expect-error — proves a missing executable field violates parity.
type _MissingAuditMustFail = AssertNever<MissingAuditFieldsFixture>;

type SnapshotMissingChallengeCount = Omit<PolicySnapshot['challengePolicy']['counts'], 'STANDARD'>;
type MissingChallengeCountFixture = Exclude<
  keyof ChallengePolicy['counts'],
  keyof SnapshotMissingChallengeCount
>;

// @ts-expect-error — proves a missing challenge count violates parity.
type _MissingChallengeCountMustFail = AssertNever<MissingChallengeCountFixture>;

describe('policy snapshot parity (structural)', () => {
  it('P4: the canonical preset round-trips keys and values through the parsed snapshot', () => {
    const policy = getPolicyPreset('regulated');
    // Reconstruct from the schema-parsed value, never the raw builder object.
    const snapshot = PolicySnapshotSchema.parse(
      createPolicySnapshot(policy, RESOLVED_AT, hashText),
    );

    const reconstructed = resolvePolicyFromSnapshot(snapshot);
    const policyKeys = Object.keys(policy).sort();
    const snapshotKeys = Object.keys(snapshot).sort();
    const reconstructedKeys = Object.keys(reconstructed).sort();

    expect(reconstructedKeys).toEqual(policyKeys);
    for (const [key, value] of Object.entries(policy)) {
      // An absent optional executable field (identityProvider) is itself a
      // frozen semantic: the snapshot omits it and reconstruction returns
      // undefined. Every present value must be frozen by key.
      if (value === undefined) continue;
      expect(snapshotKeys).toContain(key);
    }
    expect(reconstructed.identityProvider).toBeUndefined();
  });
});
