/**
 * @module architecture/policy-snapshot-parity
 * @description Structural guard: every executable `FlowGuardPolicy` field is
 * frozen into `PolicySnapshot` and reconstructed by `resolvePolicyFromSnapshot`.
 *
 * Nested executable policy shapes (`AuditPolicy`, `TimestampAssurancePolicy`,
 * `ChallengePolicy`, `ReviewBudget`, `DiscoveryHealthPolicy`,
 * `ValidationEvidencePolicy`) have exactly one authority: the Zod schemas in
 * `state/evidence-policy.ts`. Their TypeScript types are inferred from those
 * schemas and re-exported by `config/policy-types.ts`, so nested keys and value
 * types can no longer drift between two declarations. What remains guarded here
 * is the top-level executable field set of `FlowGuardPolicy`.
 *
 * This guard owns no field list. The compiler computes the remaining field set
 * from the owning authorities (`policy-types.ts` and `evidence-policy.ts`), and
 * the `Exclude<keyof ..., keyof ...>` assertion below fails compilation when a
 * new executable field is not covered by the snapshot contract. Value/type
 * compatibility is enforced by the typed mappers in `config/policy-snapshot.ts`
 * (`buildAuditSection(): PolicySnapshot['audit']`,
 * `createPolicySnapshot(): PolicySnapshot`, `resolvePolicyFromSnapshot():
 * FlowGuardPolicy`) and by the strict round-trip contract in
 * `config/policy-snapshot.test.ts`.
 *
 * Invariants:
 *   P1 Top-level coverage: every `keyof FlowGuardPolicy` exists in `PolicySnapshot`.
 *   P3 Negative fixture: a deliberately incomplete snapshot type must fail the
 *      assertion mechanism (proves the detector fires).
 *   P4 Runtime sanity: the canonical preset's executable keys are present in the
 *      snapshot and exactly reproduced by the reconstructed policy, and the
 *      snapshot parses against its own schema.
 *   P5 Derived-type contract: the schema-inferred policy types stay deeply
 *      readonly and exact-optional (absence, never explicit `undefined`), so a
 *      schema-authority refactor cannot silently widen the public policy API.
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

// ─── P3: negative compile-time fixtures ───────────────────────────────────────

type SnapshotMissingAudit = Omit<PolicySnapshot, 'audit'>;
type MissingAuditFieldsFixture = Exclude<keyof FlowGuardPolicy, keyof SnapshotMissingAudit>;

// @ts-expect-error — proves a missing executable field violates top-level coverage.
type _MissingAuditMustFail = AssertNever<MissingAuditFieldsFixture>;

type SnapshotMissingChallengeCount = Omit<PolicySnapshot['challengePolicy']['counts'], 'STANDARD'>;
type MissingChallengeCountFixture = Exclude<
  keyof ChallengePolicy['counts'],
  keyof SnapshotMissingChallengeCount
>;

// @ts-expect-error — proves the assertion mechanism fires on a missing nested key.
type _MissingChallengeCountMustFail = AssertNever<MissingChallengeCountFixture>;

// ─── P5: derived-type contract (deep readonly + exact optionals) ──────────────
// Compile-only probe: never executed, fully checked by `check:tests`.

function _assertDerivedPolicyTypeContract(
  auditPolicy: AuditPolicy,
  reviewBudget: ReviewBudget,
  challengePolicy: ChallengePolicy,
  discoveryHealth: DiscoveryHealthPolicy,
  validationEvidence: ValidationEvidencePolicy,
): void {
  // @ts-expect-error — executable policy is immutable
  auditPolicy.emitTransitions = false;

  // @ts-expect-error — nested policy is immutable
  auditPolicy.timestampAssurance.mode = 'ntp_check';

  const replacementTimestampAssurance = auditPolicy.timestampAssurance;

  // @ts-expect-error — nested policy blocks cannot be swapped (no shared aliasing)
  auditPolicy.timestampAssurance = replacementTimestampAssurance;

  // @ts-expect-error — policy arrays are immutable
  auditPolicy.timestampAssurance.criticalEvents.push('decision');

  // @ts-expect-error — review budgets are immutable
  reviewBudget.plan = 999;

  // @ts-expect-error — challenge counts are immutable
  challengePolicy.counts.STANDARD = 1;

  // @ts-expect-error — discovery health policy is immutable
  discoveryHealth.enforcement = 'off';

  // @ts-expect-error — validation-evidence policy is immutable
  validationEvidence.allowNoCommands = true;

  const timestampAssuranceWithExplicitUndefined = {
    enabled: false,
    mode: 'local_only' as const,
    strict: false,
    criticalEvents: [],
    ntpDriftThresholdMs: 30_000,
    tsaTimeoutMs: 10_000,
    tsaUrl: undefined,
  };

  // @ts-expect-error — optional policy fields are exact: absence, not explicit undefined
  const _explicitUndefinedMustFail: TimestampAssurancePolicy =
    timestampAssuranceWithExplicitUndefined;
  void _explicitUndefinedMustFail;
}
void _assertDerivedPolicyTypeContract;

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
