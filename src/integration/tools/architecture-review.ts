/**
 * @module integration/tools/architecture-review
 * @description Mode B — ADR review/verdict flow.
 *
 * @version v1
 */

import type { ToolContext } from './helpers.js';
import {
  formatBlocked,
  formatAutoAdvanceOverflow,
  enrichWithWorkflowDirective,
  toPresentationFindingRelation,
  writeStateWithArtifacts,
} from './helpers.js';

import type { SessionState } from '../../state/schema.js';
import { evaluate } from '../../machine/evaluate.js';
import { autoAdvance } from '../../rails/types.js';
import type { AutoAdvanceResult } from '../../rails/types.js';

import type {
  ArchitectureReviewCompletion,
  LoopVerdict,
  RevisionDelta,
  ReviewFindings,
} from '../../state/evidence.js';
import { validateAdrSections } from '../../state/evidence.js';

import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  consumeReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  findLatestObligation,
  findLatestUnconsumedObligation,
  freezeReviewMaterial,
  resolveFrozenReviewProfile,
} from '../review/assurance.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from '../review/dispatch-authority.js';
import type { ReviewDispatchAuthority } from '../review/dispatch-authority.js';
import { buildFrozenReviewMaterialContent } from '../review/reviewer-context.js';

import { resolveStructuredEffectiveFindings } from './review-validation.js';
import { collectPreviouslyUsedChallengeIds } from '../review/challenge-history.js';
import { buildReviewChallengeContract } from '../review/challenge-contract.js';

import { PHASE_LABELS, buildArchitectureReviewCard } from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';
import { readConfig } from '../../adapters/persistence-config.js';
import { resolveWorkflowDirective } from '../../machine/workflow-directive.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { TOOL_FLOWGUARD_ARCHITECTURE } from '../tool-names.js';
import { normalizeArchitectureClaims } from '../../state/proofgraph-approval.js';
import { projectArchitectureProofStatus } from '../proofgraph/proof-summary-projectors.js';

import {
  type ArchitectureArgs,
  type ArchitectureSession,
  buildArchitectureReviewInstruction,
} from './architecture-shared.js';
import { resolvePreImplementationChallengeClassification } from './pre-implementation-challenge.js';
import {
  freezeContextAuthorityAtHead,
  freezeOutcomeRecord,
  frozenAuthorityOrUndefined,
  type RepositoryAuthorityFreezeResult,
} from '../../rails/repository-authority.js';
import { resolveAttemptDiscoveryOrBlock } from '../review/discovery-attempt-context.js';
import { repositoryEvidenceUnavailableField } from '../review/observation-access.js';
import { hasFrozenRepositoryAuthority } from '../../state/evidence.js';
import type { ReviewAttemptDiscoveryContext } from '../../state/evidence.js';

// ─── Mode-B Internal Types ────────────────────────────────────────────────

type ResolvedReview = {
  pendingObligation: ReturnType<typeof findLatestUnconsumedObligation>;
  expectedIteration: number;
  expectedPlanVersion: number;
  assuranceBase: ReturnType<typeof ensureReviewAssurance>;
  effectiveFindings: ReviewFindings;
  evidenceInvocationId: string;
};

type AdrRevision = {
  currentAdr: NonNullable<SessionState['architecture']>;
  prevDigest: string;
  revisionDelta: RevisionDelta;
};

type AdvancedArchitectureState = Extract<AutoAdvanceResult, { kind: 'advanced' }>;

type ReviewResultContext = {
  args: ArchitectureArgs;
  session: ArchitectureSession;
  review: ResolvedReview;
  revision: AdrRevision;
  advanced: AdvancedArchitectureState;
  iteration: number;
};

// ═══════════════════════════════════════════════════════════════════════════
// Mode B: Self-Review Verdict
// ═══════════════════════════════════════════════════════════════════════════

function validateReviewEntryState(state: SessionState): string | null {
  if (state.phase !== 'ARCHITECTURE') {
    return formatBlocked('COMMAND_NOT_ALLOWED', { command: '/architecture', phase: state.phase });
  }
  if (!state.architecture) return formatBlocked('NO_ARCHITECTURE');
  if (!state.selfReview) return formatBlocked('ARCHITECTURE_REVIEW_LOOP_REQUIRED');
  return null;
}

function getObligationExpectation(
  pendingObligation: ReturnType<typeof findLatestUnconsumedObligation>,
  state: SessionState,
): { expectedIteration: number; expectedPlanVersion: number } {
  if (!pendingObligation) {
    return { expectedIteration: state.selfReview!.iteration, expectedPlanVersion: 1 };
  }
  return {
    expectedIteration: pendingObligation.iteration,
    expectedPlanVersion: pendingObligation.planVersion,
  };
}

function resolveArchitectureReview(
  args: ArchitectureArgs,
  context: ToolContext,
  session: ArchitectureSession,
): ResolvedReview | string {
  const { state } = session;
  const assuranceBase = ensureReviewAssurance(state.reviewAssurance);
  const pendingObligation = findLatestUnconsumedObligation(assuranceBase, 'architecture');
  const { expectedIteration, expectedPlanVersion } = getObligationExpectation(
    pendingObligation,
    state,
  );
  const resolved = resolveStructuredEffectiveFindings({
    pendingObligation,
    expected: {
      obligationType: 'architecture',
      iteration: expectedIteration,
      planVersion: expectedPlanVersion,
    },
    input: {
      reviewerUnavailable: args.reviewerUnavailable,
      verdict: args.reviewVerdict,
    },
    state: {
      assurance: state.reviewAssurance,
      sessionId: context.sessionID,
      // Bind design-challenge evidence to the ADR's canonical allowed refs
      // (finding B3): a fabricated section/digest must not satisfy a challenge.
      allowedChallengeEvidenceRefs: buildReviewChallengeContract(state, pendingObligation ?? null)
        ?.evidenceRefs,
      previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(state),
    },
  });

  if (resolved.kind === 'blocked') return resolved.blocked;

  const findingsBlocked = validateResolvedFindings(
    resolved.effectiveFindings,
    args.reviewVerdict,
    pendingObligation?.obligationId,
  );
  if (findingsBlocked) return findingsBlocked;

  return {
    pendingObligation,
    expectedIteration,
    expectedPlanVersion,
    assuranceBase,
    effectiveFindings: resolved.effectiveFindings,
    evidenceInvocationId: resolved.evidenceInvocationId,
  };
}

function validateResolvedFindings(
  effectiveFindings: ReviewFindings,
  submittedVerdict: LoopVerdict | undefined,
  obligationId: string | undefined,
): string | null {
  if (effectiveFindings.overallVerdict === 'unable_to_review') {
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', { obligationId: obligationId ?? 'unknown' });
  }
  if (effectiveFindings.overallVerdict !== submittedVerdict) {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      submittedVerdict: submittedVerdict ?? 'unknown',
      findingsVerdict: effectiveFindings.overallVerdict,
    });
  }
  return null;
}

function applyAdrRevision(
  args: ArchitectureArgs,
  session: ArchitectureSession,
): AdrRevision | string {
  const { state, ctx } = session;
  const verdict = args.reviewVerdict as LoopVerdict;
  const prevDigest = state.architecture!.digest;
  let currentAdr = state.architecture!;
  let revisionDelta: RevisionDelta = 'none';

  if (verdict !== 'changes_requested') return { currentAdr, prevDigest, revisionDelta };

  const revisedText = args.adrText?.trim();
  if (!revisedText) return formatBlocked('EMPTY_ADR_TEXT');
  const missingSections = validateAdrSections(revisedText);
  if (missingSections.length > 0) {
    return formatBlocked('MISSING_ADR_SECTIONS', { sections: missingSections.join(', ') });
  }

  const revisedDigest = ctx.digest(revisedText);
  revisionDelta = revisedDigest === prevDigest ? 'none' : 'minor';
  currentAdr = {
    ...currentAdr,
    adrText: revisedText,
    digest: revisedDigest,
    ...(args.claims
      ? {
          claimDeclarations: {
            flow: 'architecture' as const,
            claims: normalizeArchitectureClaims(args.claims)!,
          },
        }
      : {}),
    // A revision makes a prior human approval attest to a superseded ADR.
    approvalCertificate: undefined,
  };
  return { currentAdr, prevDigest, revisionDelta };
}

function buildReviewedState(
  revision: AdrRevision,
  review: ResolvedReview,
  args: ArchitectureArgs,
  session: ArchitectureSession,
): SessionState {
  const { state, policy, ctx } = session;
  const iteration = state.selfReview!.iteration + 1;
  // Only host-captured effective findings are ever appended.
  const existingReviewFindings = state.architecture!.reviewFindings;
  const newReviewFindings = [...(existingReviewFindings ?? []), review.effectiveFindings];
  const strictObligation = findLatestObligation(
    review.assuranceBase.obligations,
    'architecture',
    review.expectedIteration,
    review.expectedPlanVersion,
  );
  const consumedAssurance = consumeReviewObligation(
    review.assuranceBase,
    strictObligation,
    ctx.now(),
    review.evidenceInvocationId,
  );

  return {
    ...state,
    architecture: {
      ...revision.currentAdr,
      reviewCompletion: resolveArchitectureReviewCompletion(
        iteration,
        policy.reviewBudget.architecture,
        revision.revisionDelta,
        args.reviewVerdict as LoopVerdict,
      ),
      reviewFindings: newReviewFindings,
    },
    selfReview: {
      iteration,
      reviewCycle: state.reviewCycles.architecture,
      maxIterations: policy.reviewBudget.architecture,
      prevDigest: revision.prevDigest,
      currDigest: revision.currentAdr.digest,
      revisionDelta: revision.revisionDelta,
      verdict: args.reviewVerdict as LoopVerdict,
    },
    reviewAssurance: {
      ...consumedAssurance,
    },
    error: null,
  };
}

function resolveArchitectureReviewCompletion(
  iteration: number,
  maxIterations: number,
  revisionDelta: RevisionDelta,
  verdict: LoopVerdict,
): ArchitectureReviewCompletion {
  const reviewerAccepted = revisionDelta === 'none' && verdict === 'accept';
  if (reviewerAccepted) return 'reviewer_accepted';
  if (iteration >= maxIterations) return 'review_exhausted';
  return 'pending';
}

function autoAdvanceArchitectureState(
  nextState: SessionState,
  session: ArchitectureSession,
): AutoAdvanceResult {
  const { policy, ctx } = session;
  return autoAdvance(nextState, (s: SessionState) => evaluate(s, policy), ctx);
}

export async function handleAdrReview(
  args: ArchitectureArgs,
  context: ToolContext,
  session: ArchitectureSession,
): Promise<string> {
  const blocked = validateReviewEntryState(session.state);
  if (blocked) return blocked;
  const review = resolveArchitectureReview(args, context, session);
  if (typeof review === 'string') return review;
  const revision = applyAdrRevision(args, session);
  if (typeof revision === 'string') return revision;

  const reviewedState = buildReviewedState(revision, review, args, session);
  const advanced = autoAdvanceArchitectureState(reviewedState, session);
  // #428: fail closed on overflow BEFORE persistence — no partially-advanced write.
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  return persistAndFormatReviewResult({ args, session, review, revision, advanced, iteration: 0 });
}

async function persistAndFormatReviewResult(input: ReviewResultContext): Promise<string> {
  const iteration = input.session.state.selfReview!.iteration + 1;
  const completion = input.advanced.state.architecture?.reviewCompletion;
  const verdict = input.args.reviewVerdict as LoopVerdict;
  const context = { ...input, iteration };

  if (completion === 'review_exhausted') {
    getAdapterLogger().warn(
      TOOL_FLOWGUARD_ARCHITECTURE,
      'ADR review exhausted at iteration limit without reviewer approval',
      {
        sessDir: input.session.sessDir,
        iteration,
        maxIterations: input.session.policy.reviewBudget.architecture,
        lastVerdict: verdict,
        phase: input.advanced.state.phase,
        adrDigest: input.revision.currentAdr.digest,
      },
    );
  }

  if (completion === 'reviewer_accepted' || completion === 'review_exhausted') {
    return persistAndFormatConvergedReview(context);
  }
  return persistAndFormatNonConvergedReview(context, verdict);
}

async function persistAndFormatConvergedReview(input: ReviewResultContext): Promise<string> {
  const { session, review, revision, advanced, iteration } = input;
  await writeStateWithArtifacts(session.sessDir, advanced.state);
  const reviewLabel = 'Independent review';
  const completion = advanced.state.architecture?.reviewCompletion;
  const status =
    completion === 'review_exhausted'
      ? `${reviewLabel} reached the iteration limit (${iteration}/${session.policy.reviewBudget.architecture}) ` +
        'without reviewer approval. Human approval is required.'
      : `${reviewLabel} accepted the ADR at iteration ${iteration}. Human approval is required.`;
  const resp: Record<string, unknown> = {
    phase: advanced.state.phase,
    status,
    adrId: revision.currentAdr.id,
    adrDigest: revision.currentAdr.digest,
    selfReviewIteration: iteration,
    _audit: { transitions: advanced.transitions },
  };
  attachLatestReview(resp, review, iteration);
  await attachReviewCard({
    resp,
    reviewFindings: review.effectiveFindings,
    session,
    revision,
    finalState: advanced.state,
    iteration,
    reviewCompletion: completion,
    reviewedIdentity: resolveArchReviewedIdentity(review),
  });
  return JSON.stringify(enrichWithWorkflowDirective(resp, advanced.state));
}

/**
 * Direct producer identity for the architecture Mode-B response: the
 * pending obligation was resolved BEFORE the verdict was applied and the
 * effective findings were bound against exactly that obligation. An
 * attestation contradicting it is an inconsistency that must never be
 * projected as reviewed identity.
 */
function resolveArchReviewedIdentity(review: ResolvedReview): {
  reviewedDigest?: string;
  reviewedObligationId?: string;
} {
  const pending = review.pendingObligation;
  const findings = review.effectiveFindings;
  if (!pending || !findings) return {};
  const attestationId = findings.attestation?.toolObligationId;
  if (attestationId && attestationId !== pending.obligationId) {
    getAdapterLogger().warn('review', 'arch_reviewed_identity_attestation_mismatch', {
      obligationId: pending.obligationId,
      attestationObligationId: attestationId,
    });
    return {};
  }
  return {
    reviewedDigest: pending.subjectDigest,
    reviewedObligationId: pending.obligationId,
  };
}

function attachLatestReview(
  resp: Record<string, unknown>,
  review: ResolvedReview,
  hostIteration: number,
): void {
  const reviewFindings = review.effectiveFindings;
  if (!reviewFindings) return;
  resp.latestReview = {
    iteration: hostIteration,
    planVersion: review.expectedPlanVersion,
    overallVerdict: reviewFindings.overallVerdict,
    blockingIssueCount: reviewFindings.blockingIssues.length,
    majorRiskCount: reviewFindings.majorRisks.length,
    missingVerificationCount: reviewFindings.missingVerification.length,
    reviewMode: reviewFindings.reviewMode,
    reviewedAt: reviewFindings.reviewedAt,
    reviewerIteration: reviewFindings.iteration,
    reviewedPlanVersion: reviewFindings.planVersion,
    ...resolveArchReviewedIdentity(review),
  };
}

async function attachReviewCard(input: {
  resp: Record<string, unknown>;
  reviewFindings: ReviewFindings | undefined;
  session: ArchitectureSession;
  revision: AdrRevision;
  finalState: SessionState;
  iteration: number;
  reviewCompletion: ArchitectureReviewCompletion | undefined;
  reviewedIdentity: { reviewedDigest?: string; reviewedObligationId?: string };
}): Promise<void> {
  const { resp, reviewFindings, session, revision, finalState, iteration } = input;
  const directive = resolveWorkflowDirective(finalState);
  const latestReview = resp.latestReview as Record<string, unknown> | undefined;
  const reviewCardInput = {
    phase: finalState.phase,
    phaseLabel: PHASE_LABELS[finalState.phase],
    adrTitle: revision.currentAdr.title,
    adrId: revision.currentAdr.id,
    adrDigest: revision.currentAdr.digest,
    adrText: revision.currentAdr.adrText,
    iteration,
    ...(typeof latestReview?.overallVerdict === 'string'
      ? { overallVerdict: latestReview.overallVerdict }
      : {}),
    ...(reviewFindings
      ? {
          blockingIssues: reviewFindings.blockingIssues.map((finding) => ({
            severity: finding.severity,
            category: finding.category,
            message: finding.message,
            relation: toPresentationFindingRelation(finding.relation),
          })),
          majorRisks: reviewFindings.majorRisks.map((finding) => ({
            severity: finding.severity,
            category: finding.category,
            message: finding.message,
            relation: toPresentationFindingRelation(finding.relation),
          })),
          missingVerification: [...reviewFindings.missingVerification],
          scopeCreep: [...reviewFindings.scopeCreep],
          unknowns: [...reviewFindings.unknowns],
        }
      : {}),
    directive,
    isApproved: finalState.architecture?.status === 'accepted',
    ...(input.reviewCompletion !== undefined ? { reviewCompletion: input.reviewCompletion } : {}),
    proofSummary: projectArchitectureProofStatus(finalState),
    ...(input.reviewedIdentity.reviewedDigest !== undefined
      ? { reviewedDigest: input.reviewedIdentity.reviewedDigest }
      : {}),
    ...(input.reviewedIdentity.reviewedObligationId !== undefined
      ? { reviewedObligationId: input.reviewedIdentity.reviewedObligationId }
      : {}),
  };
  // Cards and artifacts are canonical Unicode; only host-visible Markdown uses preferences.
  resp.reviewCard = buildArchitectureReviewCard(reviewCardInput);
  resp.presentation = {
    markdown: buildArchitectureReviewCard(reviewCardInput, {
      glyphProfile: (await readConfig(session.worktree)).presentation.opencode.glyphProfile,
    }),
  };
  const artifactErr = await materializeReviewCardArtifact(
    session.sessDir,
    'architecture-review-card',
    resp.reviewCard as string,
    finalState,
    revision.currentAdr.digest,
  );
  if (artifactErr) resp.artifactWarning = artifactErr;
}

function findPriorArchTargetPaths(
  assurance: NonNullable<SessionState['reviewAssurance']>,
): string[] | undefined {
  const obligations = [...assurance.obligations].reverse();
  const lastArch = obligations.find((o) => o.obligationType === 'architecture');
  const paths = lastArch?.metadata?.targetPaths;
  if (!Array.isArray(paths)) return undefined;
  const stringPaths: string[] = paths.filter((p: unknown): p is string => typeof p === 'string');
  return stringPaths.length === paths.length ? stringPaths : undefined;
}

/** Obligation metadata carrying the resolved target paths, when any were resolved. */
function targetPathsMetadata(resolved: readonly string[] | undefined): Record<string, unknown> {
  return resolved && resolved.length > 0 ? { targetPaths: [...resolved] } : {};
}

function frozenArchitectureReviewMaterial(
  state: SessionState,
  artifact: string,
  subjectDigest: string,
) {
  return freezeReviewMaterial(
    buildFrozenReviewMaterialContent({ obligationType: 'architecture', state, artifact }),
    subjectDigest,
  );
}

async function persistAndFormatNonConvergedReview(
  input: ReviewResultContext,
  verdict: LoopVerdict,
): Promise<string> {
  const { args, session, review, revision, advanced, iteration } = input;
  // Recover the prior obligation's paths and union them with any fresh author
  // targetPaths. Classification derives the rest from persisted discovery risk
  // surfaces (shared SSOT with Mode A) and NEVER dead-ends: an ADR revision that
  // carries no diff and no detected surface classifies as TRIVIAL, not a block.
  const priorTargetPaths = findPriorArchTargetPaths(
    ensureReviewAssurance(advanced.state.reviewAssurance),
  );
  const targetPaths = [...new Set([...(priorTargetPaths ?? []), ...(args.targetPaths ?? [])])];
  const classification = await resolvePreImplementationChallengeClassification(
    advanced.state,
    session.worktree,
    targetPaths,
  );
  const resolvedTargetPaths =
    classification.kind === 'available' ? [...classification.changedFiles] : undefined;
  const freeze = await freezeContextAuthorityAtHead(session.worktree);
  const nextObligation = createNextArchitectureReviewObligation({
    state: advanced.state,
    session,
    review,
    revision,
    iteration,
    resolvedTargetPaths,
    freeze,
  });
  // Repository-governed attempts are minted WITH their host-owned Discovery
  // snapshot (persistence coherence); a structural projection failure blocks
  // the re-review dispatch before any state mutation.
  const discovery = await resolveAttemptDiscoveryOrBlock({
    state: advanced.state,
    worktree: session.worktree,
    repositoryGoverned: nextObligation ? hasFrozenRepositoryAuthority(nextObligation) : false,
    now: session.ctx.now(),
    ...(nextObligation ? { obligationId: nextObligation.obligationId } : {}),
  });
  if (discovery.kind === 'blocked') {
    return formatBlocked('REVIEWER_CONTEXT_UNAVAILABLE', {
      ...(discovery.obligationId ? { obligationId: discovery.obligationId } : {}),
      reason: discovery.reason,
    });
  }
  const { stateToPersist } = persistableArchitectureReviewState(
    advanced.state,
    nextObligation,
    session.ctx.now(),
    discovery.context,
  );
  const persisted = await writeStateWithArtifacts(session.sessDir, stateToPersist);
  const authority = resolveReviewDispatchAuthority(
    persisted.reviewAssurance,
    nextObligation.obligationId,
  );
  if (authority.kind === 'blocked') {
    return formatBlocked(authority.code, { reason: authority.reason });
  }
  const resp = buildNonConvergedReviewResponse({
    session,
    review,
    revision,
    advanced,
    iteration,
    verdict,
    authority: authority.authority,
    persisted,
  });
  return JSON.stringify(enrichWithWorkflowDirective(resp, stateToPersist));
}

function buildNonConvergedReviewResponse(input: {
  readonly session: ArchitectureSession;
  readonly review: ResolvedReview;
  readonly revision: AdrRevision;
  readonly advanced: { readonly state: SessionState; readonly transitions: unknown };
  readonly iteration: number;
  readonly verdict: LoopVerdict;
  readonly authority: ReviewDispatchAuthority;
  readonly persisted: SessionState;
}): Record<string, unknown> {
  const { session, review, revision, advanced, iteration, verdict, authority } = input;
  const instruction = buildArchitectureReviewInstruction({
    authority,
    iteration,
    planVersion: review.expectedPlanVersion,
    subjectLabel: 'revised ADR text, ADR title, and ticket text',
    state: input.persisted,
  });
  return {
    phase: advanced.state.phase,
    status: `Independent review iteration ${iteration}/${session.policy.reviewBudget.architecture}. Verdict: ${verdict}.`,
    adrId: revision.currentAdr.id,
    adrDigest: revision.currentAdr.digest,
    selfReviewIteration: iteration,
    revisionDelta: revision.revisionDelta,
    reviewMode: 'subagent',
    ...reviewObligationResponseFields(authority),
    ...repositoryEvidenceUnavailableField(authority.obligation.repositoryEvidenceFreeze),
    reviewDispatch: instruction.reviewDispatch,
    reviewInvocation: instruction,
    _audit: { transitions: advanced.transitions },
  };
}

function createNextArchitectureReviewObligation(input: {
  state: SessionState;
  session: ArchitectureSession;
  review: ResolvedReview;
  revision: AdrRevision;
  iteration: number;
  resolvedTargetPaths: string[] | undefined;
  freeze: RepositoryAuthorityFreezeResult;
}) {
  const { state, session, review, revision, iteration, resolvedTargetPaths, freeze } = input;
  const subjectDigest = state.architecture?.digest ?? `arch-${review.expectedPlanVersion}`;
  return createReviewObligation({
    obligationType: 'architecture',
    iteration,
    reviewCycle: state.reviewCycles.architecture,
    planVersion: review.expectedPlanVersion,
    now: session.ctx.now(),
    subjectDigest,
    reviewMaterial: frozenArchitectureReviewMaterial(
      state,
      revision.currentAdr.adrText,
      subjectDigest,
    ),
    // The (possibly revised) ADR artifact is the review SUBJECT; changedFiles
    // below stay challenge-classification and repository-evidence context only.
    reviewSubjectScope: artifactReviewSubjectScope(
      'adr',
      revision.currentAdr.adrText,
      subjectDigest,
    ),
    reviewProfile: resolveFrozenReviewProfile(state.policySnapshot),
    profileSource: 'policy_default',
    policySnapshot: state.policySnapshot,
    changedFiles: resolvedTargetPaths,
    claimedTaskClass: state.claimedTaskClass,
    metadata: targetPathsMetadata(resolvedTargetPaths),
    // Frozen repository context (freeze-time resolution): architecture reviews may cite it only.
    repositoryAuthority: frozenAuthorityOrUndefined(freeze),
    // Durable freeze outcome: continuations, restarts, and re-emits render
    // the exact degradation cause from persisted state.
    repositoryEvidenceFreeze: freezeOutcomeRecord(freeze),
  });
}

function persistableArchitectureReviewState(
  state: SessionState,
  nextObligation: ReturnType<typeof createNextArchitectureReviewObligation>,
  now: string,
  repositoryDiscovery: ReviewAttemptDiscoveryContext = { kind: 'not_applicable' },
): { stateToPersist: SessionState; attemptId: string | null } {
  let archAttemptId: string | null = null;
  const stateToPersist = nextObligation
    ? (() => {
        const withAttempt = appendObligationWithAttempt(
          state.reviewAssurance,
          nextObligation,
          now,
          repositoryDiscovery,
        );
        archAttemptId = withAttempt.attemptId;
        return {
          ...state,
          reviewAssurance: withAttempt.assurance,
        };
      })()
    : state;
  return { stateToPersist, attemptId: archAttemptId };
}
