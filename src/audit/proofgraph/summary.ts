/**
 * @module audit/proofgraph/summary
 * @description Compose a session's ProofGraph into a compact, presentable summary.
 *
 * This is the single pure entry point for "evaluate the ProofGraph for a
 * session": it binds executed-test evidence from the validation ledger, merges
 * caller-supplied evidence (structural/schema surfaces, mutation), derives the
 * projection via the deterministic evaluator, and tallies claim states.
 * It has no side effects and never gates a workflow — a consumer (e.g. the
 * status tool) presents it as advisory. Callers that need I/O or live registries
 * pass their results in via {@link ExternalProofEvidence}; this module never
 * reads the filesystem itself.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofGraphProjection, ProofProviderResult } from '../../state/proofgraph.js';
import type { ClaimVerificationState } from '../../state/proofgraph-primitives.js';
import { deriveProofGraph } from './derive.js';
import { bindExecutedTestEvidence } from './executed-test-binder.js';
import { bindCounterexamples } from './counterexample-binder.js';

/** Per-state claim tally plus critical-claim rollups. */
export interface ProofGraphSummary {
  readonly projection: ProofGraphProjection;
  readonly counts: Readonly<Record<ClaimVerificationState, number>>;
  /** Number of claims marked critical. */
  readonly criticalClaimCount: number;
  /** Critical claims not in the PROVEN state (residual work / risk surface). */
  readonly criticalUnprovenCount: number;
}

/**
 * Evidence supplied by callers that own I/O or live registries (e.g. structural
 * surfaces). This module stays pure: it never reads the filesystem or evaluates
 * registries itself.
 */
export interface ExternalProofEvidence {
  /** Additional provider results (e.g. structural/schema, mutation). */
  readonly providerResults?: readonly ProofProviderResult[];
  /** Current digest per surface id, for `surface_set` freshness resolution. */
  readonly surfaceDigests?: Readonly<Record<string, string>>;
}

function emptyCounts(): Record<ClaimVerificationState, number> {
  return { PROVEN: 0, UNPROVEN: 0, CONTRADICTED: 0, STALE: 0, BLOCKED: 0, NOT_VERIFIED: 0 };
}

/**
 * Summarize the ProofGraph for a session.
 *
 * @param state       Session state (contract claims + validation ledger + impl digest).
 * @param evaluatedAt ISO-8601 timestamp (caller-supplied for determinism).
 * @param external    Optional caller-supplied evidence and surface digests.
 */
export function summarizeProofGraph(
  state: SessionState,
  evaluatedAt: string,
  external: ExternalProofEvidence = {},
): ProofGraphSummary {
  const providerResults = [
    ...bindExecutedTestEvidence(state, evaluatedAt),
    ...(external.providerResults ?? []),
  ];
  const counterexamples = bindCounterexamples(state, evaluatedAt);
  const projection = deriveProofGraph(
    state,
    providerResults,
    counterexamples,
    evaluatedAt,
    external.surfaceDigests ?? {},
  );

  const counts = emptyCounts();
  let criticalClaimCount = 0;
  let criticalUnprovenCount = 0;
  for (const claim of projection.claims) {
    counts[claim.verificationState] += 1;
    if (claim.critical) {
      criticalClaimCount += 1;
      if (claim.verificationState !== 'PROVEN') criticalUnprovenCount += 1;
    }
  }

  return { projection, counts, criticalClaimCount, criticalUnprovenCount };
}
