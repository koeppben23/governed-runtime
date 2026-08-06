/**
 * @module integration/proofgraph/proof-summary-projectors
 * @description Compact ProofGraph summary projectors for review cards.
 *
 * These read from SessionState and normalise into a CompactProofPresentation.
 * They live in integration/ so they can import from audit/ and state/ layers.
 * The presentation layer receives only the already-computed presentation object.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import { summarizePersistedProofGraph } from '../../audit/proofgraph/summary.js';
import type { ProofGraphGateDecision } from '../../audit/proofgraph/gate.js';
import { evaluateProofGraphGate } from '../../audit/proofgraph/gate.js';
import type {
  PlanClaimDeclarations,
  ArchitectureClaimDeclarations,
} from '../../state/proofgraph-approval.js';
import { authorizedCriticalPlanClaimIds } from '../../state/proofgraph-approval.js';

import type {
  CompactProofClaim,
  CompactProofPresentation,
  ClaimVerificationState,
} from '../../presentation/proof-summary.js';

// ─── Decision context ───────────────────────────────────────────────────────

type ProofDecisionContext = 'current_gate' | 'prospective_approval' | 'completion';

// ─── Claim reason (derived from verification state) ─────────────────────────

function claimReason(state: ClaimVerificationState): string | undefined {
  switch (state) {
    case 'CONTRADICTED':
      return 'Fresh adversarial evidence falsified this claim.';
    case 'BLOCKED':
      return 'A required evidence provider could not produce a usable verdict.';
    case 'STALE':
      return 'Previously recorded evidence is no longer current for the relevant revision or governed surface.';
    case 'UNPROVEN':
      return 'The available evidence does not establish this claim.';
    case 'NOT_VERIFIED':
      return 'Required evidence or provenance is missing, unavailable, or unresolved.';
    case 'PROVEN':
      return undefined;
  }
}

function claimRecovery(
  state: ClaimVerificationState,
  planDeclaration: { readonly expectedCheckId?: string } | undefined,
): readonly string[] | undefined {
  switch (state) {
    case 'CONTRADICTED':
      return [
        'Correct the implementation or revise the approved claim.',
        'Execute the required positive and adversarial evidence again.',
      ];
    case 'STALE': {
      const checkId = planDeclaration?.expectedCheckId;
      return checkId
        ? [`Re-run the required evidence checks (e.g. ${checkId}) against the current revision.`]
        : ['Re-run the required evidence against the current revision.'];
    }
    case 'BLOCKED':
      return ['Restore the unavailable or errored evidence provider and run it again.'];
    case 'UNPROVEN':
      return ['Provide successful required evidence for this claim.'];
    case 'NOT_VERIFIED':
      return ['Complete the missing or unresolved evidence requirements.'];
    case 'PROVEN':
      return undefined;
  }
}

// ─── Evidence freshness ─────────────────────────────────────────────────────

function deriveEvidenceFreshness(
  claims: readonly ProofClaim[],
): 'CURRENT' | 'STALE' | 'NOT_VERIFIED' {
  if (claims.length === 0) return 'NOT_VERIFIED';
  if (claims.some((c) => c.freshness?.stale === true)) return 'STALE';
  if (
    claims.some((c) => c.verificationState === 'NOT_VERIFIED' || c.verificationState === 'BLOCKED')
  )
    return 'NOT_VERIFIED';
  return 'CURRENT';
}

// ─── Headline priority ──────────────────────────────────────────────────────

const HEADLINE_ORDER: readonly ClaimVerificationState[] = [
  'CONTRADICTED',
  'BLOCKED',
  'STALE',
  'UNPROVEN',
  'NOT_VERIFIED',
  'PROVEN',
];

/** Only non-proven states are highlighted as problems. */
const HIGHLIGHT_ORDER: ReadonlyArray<Exclude<ClaimVerificationState, 'PROVEN'>> = [
  'CONTRADICTED',
  'BLOCKED',
  'STALE',
  'UNPROVEN',
  'NOT_VERIFIED',
];

function computeHeadlineStatus(
  claims: readonly ProofClaim[],
  gate: ProofGraphGateDecision,
): ClaimVerificationState {
  if (claims.length === 0) return 'NOT_VERIFIED';
  if (gate.gated) {
    if (gate.kind === 'facts_unproven') {
      const blockingIds = new Set(gate.blockingClaimIds);
      const blockingClaims = claims.filter((c) => blockingIds.has(c.claimId));
      for (const state of HIGHLIGHT_ORDER) {
        if (blockingClaims.some((c) => c.verificationState === state)) return state;
      }
      return 'NOT_VERIFIED';
    }
    return 'BLOCKED';
  }
  for (const state of HEADLINE_ORDER) {
    if (claims.some((c) => c.verificationState === state)) return state;
  }
  return 'PROVEN';
}

// ─── Highlighted claims ─────────────────────────────────────────────────────

function selectHighlightedClaims(
  claims: readonly ProofClaim[],
  planDeclarations:
    | {
        readonly claims: readonly { readonly claimId: string; readonly expectedCheckId?: string }[];
      }
    | undefined,
): CompactProofClaim[] {
  const planById = new Map((planDeclarations?.claims ?? []).map((d) => [d.claimId, d] as const));
  const results: CompactProofClaim[] = [];
  for (const state of HIGHLIGHT_ORDER) {
    for (const claim of claims) {
      if (claim.verificationState !== state || claim.claimId === results[0]?.claimId) continue;
      const planDecl = planById.get(claim.claimId);
      results.push({
        claimId: claim.claimId,
        statement: claim.statement,
        status: claim.verificationState,
        critical: claim.critical,
        reason: claimReason(claim.verificationState),
        recovery: claimRecovery(claim.verificationState, planDecl),
      });
      if (results.length >= 3) break;
    }
    if (results.length >= 3) break;
  }
  // Defensive: PROVEN must never appear in highlights regardless of order array changes.
  return results.filter((c) => c.status !== 'PROVEN');
}

// ─── Count tallies ──────────────────────────────────────────────────────────

function tallyClaims(claims: readonly ProofClaim[]) {
  let provenCount = 0;
  let contradictedCount = 0;
  let blockedCount = 0;
  let staleCount = 0;
  let unprovenCount = 0;
  let notVerifiedCount = 0;
  let criticalCount = 0;
  for (const c of claims) {
    if (c.critical) criticalCount += 1;
    switch (c.verificationState) {
      case 'PROVEN':
        provenCount += 1;
        break;
      case 'CONTRADICTED':
        contradictedCount += 1;
        break;
      case 'BLOCKED':
        blockedCount += 1;
        break;
      case 'STALE':
        staleCount += 1;
        break;
      case 'UNPROVEN':
        unprovenCount += 1;
        break;
      case 'NOT_VERIFIED':
        notVerifiedCount += 1;
        break;
    }
  }
  return {
    criticalCount,
    provenCount,
    contradictedCount,
    blockedCount,
    staleCount,
    unprovenCount,
    notVerifiedCount,
  };
}

// ─── Projectors ─────────────────────────────────────────────────────────────

export function projectPlanProofObligations(
  declarations: PlanClaimDeclarations | undefined,
): CompactProofPresentation | null {
  const claims = declarations?.claims;
  if (!claims || claims.length === 0) return null;
  const normalized = claims;
  const criticalCount = claims.filter((c) => c.critical).length;
  const falsificationReady = normalized.filter(
    (c) => c.critical && c.counterexampleRequirement?.checkId,
  ).length;
  const missingFalsification = criticalCount - falsificationReady;
  return {
    kind: 'declaration',
    flow: 'plan',
    claimCount: claims.length,
    criticalCount,
    ...(falsificationReady > 0 ? { falsificationReadyCount: falsificationReady } : {}),
    ...(missingFalsification > 0 ? { missingFalsificationCount: missingFalsification } : {}),
  };
}

export function projectArchitectureDecisionClaims(
  declarations: ArchitectureClaimDeclarations | undefined,
): CompactProofPresentation | null {
  const claims = declarations?.claims;
  if (!claims || claims.length === 0) return null;
  return {
    kind: 'declaration',
    flow: 'architecture',
    claimCount: claims.length,
    criticalCount: claims.filter((c) => c.critical).length,
  };
}

function primReason(gate: ProofGraphGateDecision): { primaryReason?: string } {
  if (!gate.gated || gate.kind === 'facts_unproven') return {};
  switch (gate.kind) {
    case 'evaluation_unavailable':
      return {
        primaryReason:
          'The ProofGraph evaluator could not produce a verdict — a required input (implementation, plan, or risk assessment) is missing or invalid.',
      };
    case 'risk_assessment_stale':
      return {
        primaryReason:
          'The implementation risk assessment is outdated and must be refreshed before the gate can clear.',
      };
    case 'critical_fact_required':
      return {
        primaryReason:
          'At least one mandatory critical claim is undeclared. Declare the claim in your plan first.',
      };
    case 'clear':
      return {};
    default:
      return {
        primaryReason: 'Evidence gate is blocking: the required proof is not established.',
      };
  }
}

function resolveGate(state: SessionState, opts?: { gate?: ProofGraphGateDecision }) {
  return (
    opts?.gate ??
    evaluateProofGraphGate({
      projection: state.proofGraph,
      authorizedCriticalClaimIds: authorizedCriticalPlanClaimIds(state.plan),
      implementationDigest: state.implementation?.digest,
      riskAssessment: state.implementationRiskAssessment,
    })
  );
}

function buildEvaluationResult(
  state: SessionState,
  gateResult: ProofGraphGateDecision,
  decisionContext: ProofDecisionContext,
): CompactProofPresentation {
  const claims = state.proofGraph?.claims ?? [];
  const summary = summarizePersistedProofGraph(state);
  const tallies = tallyClaims(claims);
  const result: CompactProofPresentation = {
    kind: 'evaluation',
    claimCount: summary.claimCount,
    coverage: summary.coverage,
    headlineStatus: computeHeadlineStatus(claims, gateResult),
    ...primReason(gateResult),
    highlightedClaims: selectHighlightedClaims(claims, state.plan?.claimDeclarations),
    evidenceFreshness: deriveEvidenceFreshness(claims),
    revisionDigest: state.implementation?.digest,
    decisionContext: decisionContext,
    ...tallies,
    criticalCount: tallies.criticalCount,
    provenCount: tallies.provenCount,
    contradictedCount: tallies.contradictedCount,
    blockedCount: tallies.blockedCount,
    staleCount: tallies.staleCount,
    unprovenCount: tallies.unprovenCount,
    notVerifiedCount: tallies.notVerifiedCount,
  };
  return result;
}

export function projectImplementationProofStatus(
  state: SessionState,
  opts?: { gate?: ProofGraphGateDecision; decisionContext?: ProofDecisionContext },
): CompactProofPresentation | null {
  const claims = state.proofGraph?.claims ?? [];
  if (claims.length === 0) return null;
  const gateResult = resolveGate(state, opts);
  const context =
    opts?.decisionContext ??
    (opts?.gate ? ('current_gate' as const) : ('prospective_approval' as const));
  return buildEvaluationResult(state, gateResult, context);
}

export function projectCompletionProofStatus(state: SessionState): CompactProofPresentation | null {
  return projectImplementationProofStatus(state, { decisionContext: 'completion' });
}
