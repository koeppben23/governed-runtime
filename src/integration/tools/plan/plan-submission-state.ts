/**
 * @module integration/tools/plan/plan-submission-state
 * @description Plan submission evidence, claim declarations, and persisted
 * plan state construction.
 *
 * Extracted from `plan.ts` along the submission-state boundary: building the
 * plan record, projecting submitted claim declarations and their diagnostics,
 * minting the plan review obligation attempt, and assembling the submitted
 * plan's session state.
 *
 * @version v1
 */

import { DISCOVERY_DRIFT_PROVIDER } from '../../discovery/discovery-drift-status.js';
import { randomUUID } from 'node:crypto';
import {
  freezeContextAuthorityAtHead,
  frozenAuthorityOrUndefined,
} from '../../../rails/repository-authority.js';
import { resolveAttemptDiscoveryOrBlock } from '../../review/discovery-attempt-context.js';
import { projectMarkdownHeadings } from '../../../shared/markdown-sections.js';
import { formatBlocked } from '../../blocked-result.js';

import type { SessionState } from '../../../state/schema.js';
import { IntegrationInvariantError } from '../../errors.js';
import { appendReviewObligation, createObligationAndAttempt } from '../../review/assurance.js';
import type { PlanEvidence } from '../../../state/evidence.js';
import { computeRecordDigest } from '../../../state/evidence-plan.js';
import { normalizePlanClaims } from '../../../state/proofgraph-approval.js';
import type { PlanExecutionScope } from './plan-types.js';
import { buildPlanReviewObligationInput } from './plan-response.js';

export function buildPlanEvidence(
  planBody: string,
  scope: PlanExecutionScope,
  lineage?: {
    planVersion: number;
    supersedesRecordDigest?: string | null;
    originatingReviewObligationId?: string | null;
    revisionReason?: string | null;
  },
): PlanEvidence {
  const contentDigest = scope.ctx.digest(planBody);
  const planVersion = lineage?.planVersion ?? 1;
  const supersedesRecordDigest = lineage?.supersedesRecordDigest ?? null;
  const originatingReviewObligationId = lineage?.originatingReviewObligationId ?? null;
  const revisionReason = lineage?.revisionReason ?? null;
  const revisionId = randomUUID();

  return {
    body: planBody,
    digest: contentDigest,
    sections: projectMarkdownHeadings(planBody),
    createdAt: scope.ctx.now(),
    revisionId,
    recordDigest: computeRecordDigest({
      contentDigest,
      planVersion,
      supersedesRecordDigest,
      originatingReviewObligationId,
      revisionReason,
      revisionId,
    }),
    planVersion,
    supersedesRecordDigest,
    originatingReviewObligationId,
    revisionReason,
    lineageStatus: 'verified' as const,
  };
}

/** Register the plan review obligation and its first attempt, when review applies. */
export async function createPlanReviewAttempt(
  scope: PlanExecutionScope,
  planEvidence: PlanEvidence,
  planVersion: number,
  classificationFiles?: readonly string[],
): Promise<
  | {
      kind: 'ok';
      attemptResult: ReturnType<typeof createObligationAndAttempt> | null;
    }
  | { kind: 'blocked'; message: string }
> {
  const freeze = await freezeContextAuthorityAtHead(scope.worktree);
  const authority = frozenAuthorityOrUndefined(freeze);
  // Repository-governed attempts are minted WITH their host-owned Discovery
  // snapshot (persistence coherence); a structural projection failure blocks
  // the submission before any state mutation.
  const discovery = await resolveAttemptDiscoveryOrBlock({
    state: scope.state,
    worktree: scope.worktree,
    repositoryGoverned: authority !== undefined,
    now: scope.ctx.now(),
    driftProvider: DISCOVERY_DRIFT_PROVIDER,
  });
  if (discovery.kind === 'blocked') {
    return {
      kind: 'blocked',
      message: formatBlocked('REVIEWER_CONTEXT_UNAVAILABLE', {
        reason: discovery.reason,
      }),
    };
  }
  const attemptResult = createObligationAndAttempt(
    scope.state.reviewAssurance,
    buildPlanReviewObligationInput(scope, planEvidence, planVersion, classificationFiles, {
      freeze,
      planClaimDeclarations: submittedPlanClaimDeclarations(scope),
    }),
    scope.ctx.now(),
    discovery.context,
  );
  return { kind: 'ok', attemptResult };
}

export function currentClaimSubmissionDiagnostics(scope: PlanExecutionScope) {
  return scope.args.claims
    ? scope.claimSubmissionDiagnostics
    : scope.state.plan?.claimSubmissionDiagnostics;
}

/** The declaration set a plan submission writes: fresh normalized claims or the carried-over set. */
export function submittedPlanClaimDeclarations(
  scope: PlanExecutionScope,
): import('../../../state/proofgraph-approval.js').PlanClaimDeclarations | undefined {
  const submittedClaims = scope.args.claims;
  if (!submittedClaims) return scope.state.plan?.claimDeclarations;
  const normalizedClaims = normalizePlanClaims(submittedClaims);
  if (normalizedClaims === undefined) {
    throw new IntegrationInvariantError(
      'PROOFGRAPH_CLAIM_NORMALIZATION_UNAVAILABLE',
      'normalizing submitted plan claims produced no canonical declarations',
    );
  }
  return {
    flow: 'plan',
    version: 'v2' as const,
    claims: normalizedClaims,
  };
}

export function appendClaimSubmissionHistory(scope: PlanExecutionScope, planVersion: number) {
  const history = scope.state.plan?.claimSubmissionHistory ?? [];
  if (!scope.args.claims || !scope.claimSubmissionDiagnostics) return history;
  return [...history, { planVersion, ...scope.claimSubmissionDiagnostics }];
}

export function buildPlanSubmissionState(
  scope: PlanExecutionScope,
  planEvidence: PlanEvidence,
  planVersion: number,
  attempt: Extract<Awaited<ReturnType<typeof createPlanReviewAttempt>>, { kind: 'ok' }>,
): SessionState {
  const history = scope.state.plan ? [scope.state.plan.current, ...scope.state.plan.history] : [];
  const nextObligation = attempt.attemptResult?.obligation ?? null;

  return {
    ...scope.state,
    plan: {
      current: planEvidence,
      history,
      // Host-captured review findings are append-only and are only ever
      // written by handlePlanReview from the resolved structured evidence.
      reviewFindings: scope.state.plan?.reviewFindings,
      claimDeclarations: submittedPlanClaimDeclarations(scope),
      claimSubmissionDiagnostics: currentClaimSubmissionDiagnostics(scope),
      claimSubmissionHistory: appendClaimSubmissionHistory(scope, planVersion),
      reviewCompletion: 'pending',
    },
    // #428: a new plan invalidates any prior validation evidence. Without this
    // reset, a stale failed-check result (passed:false) survives the re-plan and
    // makes VALIDATION re-entry fire CHECK_FAILED → PLAN before any check is
    // re-executed — an infinite PLAN→PLAN_REVIEW→VALIDATION→PLAN cycle that
    // auto-advance now (correctly) fails closed on. Clearing validation returns
    // VALIDATION to the "checks pending" WAIT state so checks must be re-run.
    validation: [],
    selfReview: {
      iteration: 0,
      reviewCycle: scope.state.reviewCycles.plan,
      maxIterations: scope.maxPlanReviewIterations,
      prevDigest: null,
      currDigest: planEvidence.digest,
      revisionDelta: 'major',
      verdict: 'changes_requested',
    },
    reviewAssurance:
      attempt.attemptResult?.assurance ??
      appendReviewObligation(scope.state.reviewAssurance, nextObligation),
    error: null,
  };
}
