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
import type { AssertionBindingReasonCode } from './assertion-evidence-binding.js';
import type {
  ClaimVerificationState,
  CounterexampleOutcome,
  SignalClass,
} from '../../state/proofgraph-primitives.js';
import { deriveProofGraph } from './derive.js';
import { isFreshCounterexample } from './evaluate.js';
import { bindExecutedTestEvidence } from './executed-test-binder.js';
import { bindCounterexamples } from './counterexample-binder.js';
import type { MutationProfileSummary, MutationSurvivor } from './mutation-report.js';

/** Adversarial outcome for one claim, with explicit revision freshness. */
export interface CounterexampleStatus {
  readonly claimId: string;
  readonly scenario: string;
  readonly outcome: CounterexampleOutcome;
  readonly boundDigest: string;
  /** True when bound to a superseded revision: it can neither contradict nor satisfy. */
  readonly stale: boolean;
}

/** Recorded mutation verdict for one opt-in profile. */
export interface MutationStatus {
  readonly profileId: string;
  readonly covered: boolean;
  readonly killedCount: number;
  readonly survivorCount: number;
  readonly survivors: readonly MutationSurvivor[];
}

/** A claim that is explicitly not established, with the reason it is not. */
export interface UnresolvedAssumption {
  readonly claimId: string;
  readonly statement: string;
  readonly signalClass: SignalClass;
  readonly critical: boolean;
  readonly verificationState: ClaimVerificationState;
  readonly reason: string;
}

/** Per-state claim tally plus critical-claim rollups and reviewer detail. */
export interface ProofGraphSummary {
  readonly projection: ProofGraphProjection;
  readonly counts: Readonly<Record<ClaimVerificationState, number>>;
  /** Number of claims marked critical. */
  readonly criticalClaimCount: number;
  /** Critical claims not in the PROVEN state (residual work / risk surface). */
  readonly criticalUnprovenCount: number;
  /** Executed adversarial outcomes with freshness (never only implied by state). */
  readonly counterexamples: readonly CounterexampleStatus[];
  /** Recorded mutation verdicts, empty when no mutation run was recorded. */
  readonly mutation: readonly MutationStatus[];
  /** Claims surfaced as unresolved: unsourced, contradicted, stale, or blocked. */
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
  /** Per-claim binding diagnostic reason codes from counterexample evaluation. */
  readonly claimDiagnostics: ReadonlyMap<string, AssertionBindingReasonCode>;
}

/**
 * Compact coverage summary for standard status surfaces.
 *
 * `coverage` describes the DECLARED CONTRACT only. A session can legitimately
 * report `NOT_DECLARED` while carrying claims: standalone review contributes
 * advisory hypotheses that are deliberately not part of any contract. The split
 * counts make that combination self-explanatory instead of contradictory (#762).
 */
export interface PersistedProofGraphSummary {
  /** Coverage of the certificate-bound contract, NOT of advisory hypotheses. */
  readonly coverage: 'NOT_DECLARED' | 'NOT_VERIFIED' | 'PROVEN';
  /** Total claims in the projection: contract claims plus advisory hypotheses. */
  readonly claimCount: number;
  readonly provenCount: number;
  readonly unprovenCount: number;
  /** Claims originating from a declared contract (subset of `claimCount`). */
  readonly contractClaimCount: number;
  /** Advisory review hypotheses with no governing authority (subset of `claimCount`). */
  readonly hypothesisCount: number;
}

/**
 * Summarize the persisted projection without executing providers. An empty graph
 * is never reported as healthy: it means no structured claims were declared.
 *
 * Coverage reflects the declared contract exclusively — advisory review
 * hypotheses are tallied separately and never affect the contract coverage
 * status. An empty declared contract (zero claims) is treated as NOT_VERIFIED,
 * not as vacuous-truth PROVEN.
 */
export function summarizePersistedProofGraph(state: SessionState): PersistedProofGraphSummary {
  const claims = state.proofGraph?.claims ?? [];
  const provenCount = claims.filter((claim) => claim.verificationState === 'PROVEN').length;
  const unprovenCount = claims.length - provenCount;
  const contractClaimIds = new Set((state.proofContract?.claims ?? []).map((c) => c.claimId));
  const contractClaims = claims.filter((c) => contractClaimIds.has(c.claimId));
  const contractProven = contractClaims.filter((c) => c.verificationState === 'PROVEN').length;
  const contractClaimCount = state.proofContract?.claims.length ?? 0;
  return {
    coverage:
      state.proofContract === undefined
        ? 'NOT_DECLARED'
        : contractClaimCount === 0
          ? 'NOT_VERIFIED'
          : contractProven === contractClaims.length && contractClaims.length > 0
            ? 'PROVEN'
            : 'NOT_VERIFIED',
    claimCount: claims.length,
    provenCount,
    unprovenCount,
    contractClaimCount,
    hypothesisCount: claims.filter((claim) => claim.signalClass === 'hypothesis').length,
  };
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
  /** Recorded mutation verdicts, surfaced verbatim in the projection. */
  readonly mutationSummaries?: readonly MutationProfileSummary[];
}

function emptyCounts(): Record<ClaimVerificationState, number> {
  return { PROVEN: 0, UNPROVEN: 0, CONTRADICTED: 0, STALE: 0, BLOCKED: 0, NOT_VERIFIED: 0 };
}

/** Why a claim is not established, in reviewer-facing terms. */
function unresolvedReason(claim: ProofGraphProjection['claims'][number]): string | null {
  if (claim.provenance === null) {
    return 'no approved governing authority; recorded as an assumption';
  }
  switch (claim.verificationState) {
    case 'CONTRADICTED':
      return 'an executed counterexample falsified the claim at the current revision';
    case 'BLOCKED':
      return 'a required provider errored and could not produce a verdict';
    case 'NOT_VERIFIED':
      return 'required evidence is missing, unavailable, or unresolved';
    case 'STALE':
      return 'the only passing evidence is bound to a superseded revision/surface';
    case 'UNPROVEN':
      return 'declared but not established by required evidence';
    case 'PROVEN':
      return null;
  }
}

/** The evaluator owns ClaimVerificationState; enforcement owns governance interpretation. */

function diagnosticsAsRecord(
  diagnostics: ReadonlyMap<string, AssertionBindingReasonCode>,
): Readonly<Record<string, AssertionBindingReasonCode>> {
  const record: Record<string, AssertionBindingReasonCode> = {};
  for (const [key, value] of diagnostics) {
    record[key] = value;
  }
  return record;
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
  const { counterexamples: executedCounterexamples, diagnostics } = bindCounterexamples(
    state,
    evaluatedAt,
  );
  const projection = deriveProofGraph(
    state,
    providerResults,
    executedCounterexamples,
    evaluatedAt,
    {
      currentSurfaceDigests: external.surfaceDigests ?? {},
      claimDiagnostics: diagnosticsAsRecord(diagnostics),
    },
  );

  const counts = emptyCounts();
  let criticalClaimCount = 0;
  let criticalUnprovenCount = 0;
  const unresolvedAssumptions: UnresolvedAssumption[] = [];
  for (const claim of projection.claims) {
    counts[claim.verificationState] += 1;
    if (claim.critical) {
      criticalClaimCount += 1;
      if (claim.verificationState !== 'PROVEN') criticalUnprovenCount += 1;
    }
    const reason = unresolvedReason(claim);
    if (reason !== null) {
      unresolvedAssumptions.push({
        claimId: claim.claimId,
        statement: claim.statement,
        signalClass: claim.signalClass,
        critical: claim.critical,
        verificationState: claim.verificationState,
        reason,
      });
    }
  }

  const currentDigest = state.implementation?.digest ?? null;
  const counterexamples: CounterexampleStatus[] = executedCounterexamples.map((c) => ({
    claimId: c.claimId,
    scenario: c.scenario,
    outcome: c.outcome,
    boundDigest: c.boundDigest,
    stale: !isFreshCounterexample(c, currentDigest),
  }));

  const mutation: MutationStatus[] = (external.mutationSummaries ?? []).map((m) => ({
    profileId: m.profileId,
    covered: m.covered,
    killedCount: m.killedCount,
    survivorCount: m.survivorCount,
    survivors: m.survivors,
  }));

  return {
    projection,
    counts,
    criticalClaimCount,
    criticalUnprovenCount,
    counterexamples,
    mutation,
    unresolvedAssumptions,
    claimDiagnostics: diagnostics,
  };
}
