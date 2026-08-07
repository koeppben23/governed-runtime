/**
 * @module proofgraph
 * @description FlowGuard ProofGraph domain schemas (v1).
 *
 * A compact, persisted, claim-centric projection: each critical change claim
 * carries provenance (an approved authority reference), typed digest-bound
 * evidence references, counterexample references, and an evaluated
 * verification state with explicit residual uncertainty.
 *
 * Design constraints:
 * - A claim's governing `provenance` ({@link ClaimAuthorityRef}) is a different
 *   type from its `evidence` ({@link ClaimEvidenceRef}); a validation attempt is
 *   evidence and can never be governing provenance.
 * - Only compact summaries, digests, and stable references live here; large
 *   provider artifacts are stored outside session state.
 * - `ProofClaim` is the EVALUATED shape (`DeclaredClaim` + `verificationState`
 *   + computed `freshness`). The evaluator is the sole authority that assigns a
 *   verification state; a declaration never asserts one.
 *
 * ProofGraph extends existing review/validation authorities. It does not create
 * a parallel policy, state-transition, or review-decision registry.
 *
 * @version v1
 */

import { z } from 'zod';
import { ClaimAuthorityRef, ClaimEvidenceRef } from './proofgraph-refs.js';
import {
  SignalClass,
  ClaimVerificationState,
  ProofProviderKind,
  CounterexampleOutcome,
  AdversarialEvidenceKind,
  Freshness,
} from './proofgraph-primitives.js';
import { AssertionIdentity } from './assertion-identity.js';

/** Persisted ProofGraph projection schema version. */
export const PROOFGRAPH_SCHEMA_VERSION = 'proofgraph.v1' as const;

/**
 * Policy-required evidence classes for a claim (the evaluator input). A claim
 * cannot be `PROVEN` unless every required positive provider kind has a fresh
 * pass AND every required adversarial category is satisfied. Empty arrays mean
 * "no explicit requirement" (any fresh pass proves, no adversarial needed).
 */
export const RequiredEvidence = z
  .object({
    positive: z.array(ProofProviderKind),
    adversarial: z.array(AdversarialEvidenceKind),
  })
  .readonly();
export type RequiredEvidence = z.infer<typeof RequiredEvidence>;

/**
 * Counterexample binding requirement for a claim.
 *
 * Binds a dedicated verification check to one concrete provider-scoped
 * assertion. Only a matching failed assertion can contradict the claim.
 * Check-level outcomes alone never produce a counterexample contradiction.
 */
export const CounterexampleRequirement = z
  .object({
    checkId: z.string().min(1),
    assertion: AssertionIdentity,
  })
  .strict()
  .readonly();
export type CounterexampleRequirement = z.infer<typeof CounterexampleRequirement>;

/**
 * Shared shape between a declared claim (evaluator input) and an evaluated
 * claim (evaluator output). `provenance` is mandatory as a value but may be
 * `null` — a `null` provenance is surfaced as `NOT_VERIFIED`, never proven.
 */
const proofClaimBase = {
  /** Stable claim identifier. */
  claimId: z.string().uuid(),
  /** The behavioral statement or forbidden state being asserted. */
  statement: z.string().min(1),
  /** How strongly the claim is grounded; only `fact` may block under policy. */
  signalClass: SignalClass,
  /** Whether the claim is critical (subject to stricter evidence gating). */
  critical: z.boolean(),
  /** Approved GOVERNING source (ticket/plan-ADR/canonical authority). `null` ⇒ unproven assumption. */
  provenance: ClaimAuthorityRef.nullable(),
  /** Digest-bound positive EVIDENCE references (never governing provenance). */
  evidenceRefs: z.array(ClaimEvidenceRef),
  /** Digest-bound falsification/counterexample EVIDENCE references. */
  counterexampleRefs: z.array(ClaimEvidenceRef),
  /** Policy-required evidence classes; absent ⇒ no explicit requirement. */
  requiredEvidence: RequiredEvidence.optional(),
  /** Optional counterexample requirement (check-level or assertion-level). */
  counterexampleRequirement: CounterexampleRequirement.optional(),
  /** Optional confidence in [0, 1] for advisory (non-fact) signals. */
  confidence: z.number().min(0).max(1).optional(),
} as const;

/** A claim declaration — the evaluator input (no verification state). */
export const DeclaredClaim = z.object(proofClaimBase).readonly();
export type DeclaredClaim = z.infer<typeof DeclaredClaim>;

/** An evaluated claim — declaration plus assigned verification state and freshness. */
export const ProofClaim = z
  .object({
    ...proofClaimBase,
    verificationState: ClaimVerificationState,
    freshness: Freshness.optional(),
  })
  .readonly();
export type ProofClaim = z.infer<typeof ProofClaim>;

// ─── Binding Diagnostic Codes ────────────────────────────────────────────────

export const AssertionBindingReasonCodeSchema = z.enum([
  'check_mismatch',
  'evidence_missing',
  'check_only_evidence',
  'provider_mismatch',
  'assertion_mismatch',
]);
export type AssertionBindingReasonCode = z.infer<typeof AssertionBindingReasonCodeSchema>;

/** Compact, persisted ProofGraph projection. */
export const ProofGraphProjection = z
  .object({
    version: z.literal(PROOFGRAPH_SCHEMA_VERSION),
    claims: z.array(ProofClaim),
    evaluatedAt: z.string().datetime(),
    /** Per-claim binding diagnostic codes from counterexample evaluation. */
    claimDiagnostics: z.record(z.string().uuid(), AssertionBindingReasonCodeSchema).optional(),
  })
  .readonly();
export type ProofGraphProjection = z.infer<typeof ProofGraphProjection>;

/**
 * Digest binding of a provider result to the concrete surface it was computed
 * over. Freshness is evaluated against this binding, never omitted:
 *
 * - `implementation` / `plan`: bound to a revision digest; a result is fresh
 *   only while that digest is the current implementation/plan revision.
 * - `surface_set`: bound to a canonical digest over an explicit input surface
 *   (e.g. a set of registry/config source locations); fresh only while that
 *   surface's current digest still matches. Structural and schema assertions
 *   use this so they cannot prove indefinitely after their surface changes.
 */
export const ProofProviderBinding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('implementation'), digest: z.string().min(1) }).readonly(),
  z.object({ kind: z.literal('plan'), digest: z.string().min(1) }).readonly(),
  z
    .object({
      kind: z.literal('surface_set'),
      /** Stable identifier of the input surface (the freshness lookup key). */
      surfaceId: z.string().min(1),
      /** Canonical digest over the concrete input surface. */
      digest: z.string().min(1),
      /** Source locations that constitute the surface. */
      locations: z.array(z.string().min(1)).min(1),
    })
    .readonly(),
]);
export type ProofProviderBinding = z.infer<typeof ProofProviderBinding>;

/**
 * Provider input for an `unavailable` result: no execution occurred, so a
 * reproducible command/assertion may be absent.
 */
export const ProofProviderInput = z
  .object({
    command: z.string().min(1).optional(),
    assertion: z.string().min(1).optional(),
  })
  .readonly();
export type ProofProviderInput = z.infer<typeof ProofProviderInput>;

/**
 * Reproducible input for an EXECUTED provider result: EXACTLY ONE of an exact
 * command or a deterministic assertion input. A source filename or test name
 * alone is insufficient; an executed result with neither (or both) is rejected.
 */
export const ProofProviderExecutedInput = z.union([
  z.object({ command: z.string().min(1), assertion: z.never().optional() }).readonly(),
  z.object({ command: z.never().optional(), assertion: z.string().min(1) }).readonly(),
]);
export type ProofProviderExecutedInput = z.infer<typeof ProofProviderExecutedInput>;

/**
 * Stable source/test location and identifier of a provider result.
 *
 * `location` must describe WHERE the evidence comes from, and `stableId` must
 * identify the test/check STABLY across executions. A single execution-record id
 * belongs in `executionRecordId`, not here.
 */
export const ProofProviderSource = z
  .object({
    location: z.string().min(1),
    stableId: z.string().min(1),
  })
  .readonly();
export type ProofProviderSource = z.infer<typeof ProofProviderSource>;

/** SHA-256 hex digest of a provider's output. */
const Sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Fields every provider result carries, executed or not. */
const providerResultCommon = {
  claimId: z.string().uuid(),
  providerKind: ProofProviderKind,
  /** Stable provider identity (e.g. 'executed-test'), distinct from its version. */
  providerId: z.string().min(1),
  providerVersion: z.string().min(1),
  /**
   * Reference to the canonical execution record this result was bound from
   * (e.g. a ValidationAttempt id). This identifies ONE execution and is
   * deliberately separate from `source.stableId`, which identifies the stable
   * test/check across executions.
   */
  executionRecordId: z.string().uuid().optional(),
  executedAt: z.string().datetime(),
  /** Display-only detail; never a substitute for the canonical fields. */
  detail: z.string().optional(),
} as const;

/**
 * Fields an EXECUTED (pass/fail/error) provider result must carry: a reproducible
 * `input`, a `source`/stable id, a digest `binding` to the covered surface, and a
 * result digest. The schema — not just documentation — enforces this so
 * incomplete evidence cannot be constructed or persisted.
 */
const executedProviderShape = {
  ...providerResultCommon,
  input: ProofProviderExecutedInput,
  source: ProofProviderSource,
  binding: ProofProviderBinding,
  resultDigest: Sha256Digest,
} as const;

/**
 * A reproducible executable provider result, discriminated by `status`:
 *
 * - `pass` / `fail` / `error` (executed): require `input` (exactly one command
 *   or assertion), `source`, `binding`, and `resultDigest`.
 * - `unavailable` (a required provider that could not run): must NOT carry
 *   `source`, `binding`, or `resultDigest`.
 *
 * Every variant is `.strict()`: an unknown or variant-forbidden key is REJECTED,
 * never silently stripped. At this persistence/trust boundary a semantically
 * contradictory record (e.g. an `unavailable` result carrying a result digest)
 * must fail closed rather than normalize into a plausible-looking one.
 */
export const ProofProviderResult = z.discriminatedUnion('status', [
  z.object({ ...executedProviderShape, status: z.literal('pass') }).strict(),
  z.object({ ...executedProviderShape, status: z.literal('fail') }).strict(),
  z.object({ ...executedProviderShape, status: z.literal('error') }).strict(),
  z
    .object({
      ...providerResultCommon,
      input: ProofProviderInput,
      status: z.literal('unavailable'),
    })
    .strict(),
]);
export type ProofProviderResult = z.infer<typeof ProofProviderResult>;

/** An executed falsification scenario and its outcome, bound to a revision. */
export const ProofCounterexample = z
  .object({
    claimId: z.string().uuid(),
    /** The validation attempt that produced this counterexample. */
    attemptId: z.string().uuid(),
    /** The check kind that was executed (e.g. 'build', 'test'). */
    checkId: z.string().min(1),
    scenario: z.string().min(1),
    outcome: CounterexampleOutcome,
    boundDigest: z.string().min(1),
    executedAt: z.string().datetime(),
  })
  .readonly();
export type ProofCounterexample = z.infer<typeof ProofCounterexample>;
