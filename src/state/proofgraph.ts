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
  ProofProviderStatus,
  CounterexampleOutcome,
  AdversarialEvidenceKind,
  Freshness,
} from './proofgraph-primitives.js';

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

/** Compact, persisted ProofGraph projection. */
export const ProofGraphProjection = z
  .object({
    version: z.literal(PROOFGRAPH_SCHEMA_VERSION),
    claims: z.array(ProofClaim),
    evaluatedAt: z.string().datetime(),
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

/** Reproducible provider input: the exact command or a deterministic assertion input. */
export const ProofProviderInput = z
  .object({
    command: z.string().min(1).optional(),
    assertion: z.string().min(1).optional(),
  })
  .readonly();
export type ProofProviderInput = z.infer<typeof ProofProviderInput>;

/** Stable source/test location and identifier of a provider result. */
export const ProofProviderSource = z
  .object({
    location: z.string().min(1),
    stableId: z.string().min(1),
  })
  .readonly();
export type ProofProviderSource = z.infer<typeof ProofProviderSource>;

/**
 * A reproducible executable provider result. Records the minimum metadata
 * needed to re-run and machine-check it: a stable provider id + version, the
 * exact reproducible `input`, the `source`/stable id, a digest `binding` to the
 * surface it covers, an exit/result status, an output/result digest, and a
 * timestamp. `detail` is display-only and never substitutes for these fields.
 *
 * `input.command`/`source`/`binding`/`resultDigest` are populated for executed
 * (pass/fail/error) results; a `status: 'unavailable'` result (a required
 * provider that could not run) omits `source`, `binding`, and `resultDigest`.
 */
export const ProofProviderResult = z
  .object({
    claimId: z.string().uuid(),
    providerKind: ProofProviderKind,
    /** Stable provider identity (e.g. 'executed-test'), distinct from its version. */
    providerId: z.string().min(1),
    providerVersion: z.string().min(1),
    /** Exact reproducible input (command or deterministic assertion). */
    input: ProofProviderInput,
    /** Source/test location + stable identifier (absent only when unavailable). */
    source: ProofProviderSource.optional(),
    /** Digest binding to the covered surface (absent only when unavailable). */
    binding: ProofProviderBinding.optional(),
    status: ProofProviderStatus,
    /** SHA-256 of the provider output (absent when unavailable). */
    resultDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    executedAt: z.string().datetime(),
    /** Display-only detail; never a substitute for the canonical fields above. */
    detail: z.string().optional(),
  })
  .readonly();
export type ProofProviderResult = z.infer<typeof ProofProviderResult>;

/** An executed falsification scenario and its outcome, bound to a revision. */
export const ProofCounterexample = z
  .object({
    claimId: z.string().uuid(),
    scenario: z.string().min(1),
    outcome: CounterexampleOutcome,
    boundDigest: z.string().min(1),
    executedAt: z.string().datetime(),
  })
  .readonly();
export type ProofCounterexample = z.infer<typeof ProofCounterexample>;
