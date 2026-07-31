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
 * - Evidence references reuse the canonical digest-bound reference vocabulary
 *   (`ReviewChallengeEvidenceRef`) rather than duplicating it.
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
import { ReviewChallengeEvidenceRef } from './evidence-review.js';
import {
  SignalClass,
  ClaimVerificationState,
  ProofProviderKind,
  ProofProviderStatus,
  CounterexampleOutcome,
  Freshness,
} from './proofgraph-primitives.js';

/** Persisted ProofGraph projection schema version. */
export const PROOFGRAPH_SCHEMA_VERSION = 'proofgraph.v1' as const;

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
  /** Approved-source reference (ticket/plan/ADR/impl). `null` ⇒ unproven assumption. */
  provenance: ReviewChallengeEvidenceRef.nullable(),
  /** Digest-bound positive evidence references. */
  evidenceRefs: z.array(ReviewChallengeEvidenceRef),
  /** Digest-bound falsification/counterexample references. */
  counterexampleRefs: z.array(ReviewChallengeEvidenceRef),
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
 * A reproducible executable provider result, bound to an implementation
 * revision. Records provider identity/version, the bound digest, an
 * exit/result status, an output/result digest, and a timestamp — a filename or
 * test name alone is insufficient evidence.
 */
export const ProofProviderResult = z
  .object({
    claimId: z.string().uuid(),
    providerKind: ProofProviderKind,
    providerVersion: z.string().min(1),
    /** Implementation digest the result is bound to. */
    boundDigest: z.string().min(1),
    status: ProofProviderStatus,
    /** SHA-256 of the provider output. */
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executedAt: z.string().datetime(),
    detail: z.string(),
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
