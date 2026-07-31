/**
 * @module proofgraph-primitives
 * @description Foundation enums and scalar types for FlowGuard ProofGraph.
 *
 * ProofGraph makes each critical change claim traceable from approved intent
 * through executed evidence to a review outcome. These primitives depend only
 * on Zod and the shared signal vocabulary — no dependency on other state
 * modules — so they remain a stable, reusable base.
 *
 * A `PROVEN` claim state means: all policy-required, fresh, revision-bound
 * evidence for that claim succeeded. It does NOT assert objective correctness
 * or the absence of any undiscovered failure. Residual uncertainty is explicit
 * (`UNPROVEN`, `CONTRADICTED`, `STALE`, `BLOCKED`, `NOT_VERIFIED`).
 *
 * @version v1
 */

import { z } from 'zod';
import { SignalClass } from './evidence-signal.js';

export { SignalClass };

/**
 * Evaluated verification state of a claim.
 *
 * - `PROVEN`: at least one fresh, revision-bound provider result passed.
 * - `UNPROVEN`: declared with provenance, but not proven (no evidence, or a
 *   provider reported a failing verdict).
 * - `CONTRADICTED`: an executed counterexample falsified the claim.
 * - `STALE`: the only passing evidence is bound to a non-current implementation
 *   revision, so it cannot satisfy a gate.
 * - `BLOCKED`: a required provider errored (execution problem, not a verdict).
 * - `NOT_VERIFIED`: provenance is missing, or a required provider was
 *   unavailable — never a pass-by-fallback.
 */
export const ClaimVerificationState = z.enum([
  'PROVEN',
  'UNPROVEN',
  'CONTRADICTED',
  'STALE',
  'BLOCKED',
  'NOT_VERIFIED',
]);
export type ClaimVerificationState = z.infer<typeof ClaimVerificationState>;

/**
 * Provider result status.
 *
 * `fail` (a verdict) and `error` (an execution problem) are deliberately
 * distinct, and `unavailable` (provider missing) is distinct from both, so a
 * missing provider and a failed provider are never conflated.
 */
export const ProofProviderStatus = z.enum(['pass', 'fail', 'error', 'unavailable']);
export type ProofProviderStatus = z.infer<typeof ProofProviderStatus>;

/** Deliberately small initial set of executable evidence provider kinds. */
export const ProofProviderKind = z.enum([
  'executed_test',
  'structural_assertion',
  'schema_compare',
  'fault_injection',
]);
export type ProofProviderKind = z.infer<typeof ProofProviderKind>;

/** Outcome of an executed falsification scenario against a claim. */
export const CounterexampleOutcome = z.enum(['supported', 'contradicted', 'not_verified']);
export type CounterexampleOutcome = z.infer<typeof CounterexampleOutcome>;

/**
 * Revision-freshness of a claim's binding evidence.
 *
 * `stale` is `true` when `boundDigest` no longer matches the current
 * implementation revision — such evidence cannot satisfy a critical gate.
 */
export const Freshness = z
  .object({
    boundDigest: z.string().min(1),
    evaluatedAt: z.string().datetime(),
    stale: z.boolean(),
  })
  .readonly();
export type Freshness = z.infer<typeof Freshness>;
