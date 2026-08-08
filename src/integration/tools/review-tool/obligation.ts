/**
 * @module integration/tools/review-tool/obligation
 * @description Review obligation lifecycle — create, resolve, validate, consume.
 *
 * Extracted from simple-tools.ts for single-responsibility compliance.
 *
 * @version v1
 */

import { hashText } from '../../../shared/hashing.js';
export { fingerprintReviewInput } from './fingerprint.js';
import { fingerprintReviewInput } from './fingerprint.js';

import type { SessionState } from '../../../state/schema.js';
import type { ReviewFindings, ReviewObligation } from '../../../state/evidence.js';
import type { ReviewAssuranceState } from '../../../state/evidence-review.js';
import type { ReviewReferenceInput } from '../../../rails/review.js';
import {
  REVIEW_MANDATE_DIGEST,
  REVIEW_CRITERIA_VERSION,
  createReviewObligation,
  appendObligationWithAttempt,
  resolveFrozenReviewProfile,
  findLatestPendingReviewObligation,
  findReviewObligationById,
  consumeReviewObligation,
  validateStrictAttestation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
} from '../../review/assurance.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { validateChallengeConsistency } from '../../review/enforcement/challenge-consistency.js';
import { collectPreviouslyUsedChallengeIds } from '../../review/challenge-history.js';
import { buildHostTaskChallengeContract } from '../../review/host-task-policy.js';
import { formatBlocked, writeStateWithArtifacts } from '../helpers.js';
import { resolveChallengeClassificationEvidence } from '../review-obligation-classification.js';
import { type ResolvedBranchReviewSource } from '../../../adapters/gh-cli.js';
import type { ReviewToolArgs, StartedReviewResult } from './types.js';

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function buildRequiredReviewAttestationPayload(obligationId: string): {
  requiredReviewAttestation: {
    reviewedBy: string;
    mandateDigest: string;
    criteriaVersion: string;
    toolObligationId: string;
  };
  reviewerSubagentType: string;
  recovery: string[];
} {
  return {
    requiredReviewAttestation: {
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: obligationId,
    },
    reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
    recovery: [
      'Load the referenced content (PR diff via gh CLI, URL via webfetch, or use manual text).',
      `Call Task tool with subagent_type: "${REVIEWER_SUBAGENT_TYPE}" and provide the content in the prompt.`,
      'Pass the requiredReviewAttestation values to the subagent so it populates attestation.reviewedBy, attestation.mandateDigest, attestation.criteriaVersion, and attestation.toolObligationId exactly as provided.',
      'Instruct the subagent to return a complete ReviewFindings object (reviewMode, reviewedBy, reviewedAt, attestation, blockingIssues, majorRisks, missingVerification, scopeCreep, unknowns).',
      'Parse the subagent response as a ReviewFindings object - do NOT convert it to an array and do NOT drop attestation fields.',
      'Re-run flowguard_review with reviewFindings set to the complete ReviewFindings object. In strict mode, copied attestation fields alone are diagnostic context only; FlowGuard must persist matching ReviewInvocationEvidence before the findings satisfy governance.',
    ],
  };
}

export function formatBlockedWithAttestation(
  code: string,
  message: string,
  obligationId: string,
): string {
  if (code === 'HOST_SUBAGENT_TASK_REQUIRED') {
    return JSON.stringify({
      error: true,
      code,
      message,
      reviewObligationId: obligationId,
      requiredReviewAttestation: {
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: obligationId,
      },
      reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
      recovery: [
        `Call Task tool with subagent_type: "${REVIEWER_SUBAGENT_TYPE}" and provide the content plus requiredReviewAttestation.`,
        'After FlowGuard captures the Task evidence, re-run flowguard_review with reviewObligationId set to requiredReviewAttestation.toolObligationId and reviewVerdict matching the reviewer overallVerdict.',
        'Do not submit, copy, or alter reviewFindings in host-task mode.',
      ],
    });
  }
  return JSON.stringify({
    error: true,
    code,
    message,
    reviewObligationId: obligationId,
    ...buildRequiredReviewAttestationPayload(obligationId),
  });
}

export function formatMissingContentAnalysis(
  obligationId: string,
  hostTaskRequired = false,
): string {
  if (hostTaskRequired) {
    return formatBlockedWithAttestation(
      'CONTENT_ANALYSIS_REQUIRED',
      `Content-aware /review requires subagent analysis. Call the ${REVIEWER_SUBAGENT_TYPE} subagent via Task tool, then re-run flowguard_review with the original content fields, reviewObligationId '${obligationId}', and reviewVerdict matching the captured reviewer verdict. Do not submit or copy reviewFindings in host-task mode.`,
      obligationId,
    );
  }
  return formatBlockedWithAttestation(
    'CONTENT_ANALYSIS_REQUIRED',
    `Content-aware /review requires subagent analysis. Call the ${REVIEWER_SUBAGENT_TYPE} subagent via Task tool to analyze the provided content, then re-run flowguard_review with the complete ReviewFindings object. Manual JSON/attestation copy alone is not sufficient in strict mode; FlowGuard must persist matching ReviewInvocationEvidence.`,
    obligationId,
  );
}

export function formatSubagentReviewNotInvoked(detail: string, obligationId: string): string {
  return formatBlockedWithAttestation(
    'SUBAGENT_REVIEW_NOT_INVOKED',
    `Supplied reviewFindings did not pass subagent attestation: ${detail}. Re-run the ${REVIEWER_SUBAGENT_TYPE} subagent with the requiredReviewAttestation values and submit the complete ReviewFindings object. Copied attestation fields are diagnostic context only until FlowGuard persists matching ReviewInvocationEvidence.`,
    obligationId,
  );
}

// ─── Input helpers ───────────────────────────────────────────────────────────

export function buildReviewReferenceInput(args: {
  inputOrigin?: ReviewReferenceInput['inputOrigin'];
  references?: ReviewReferenceInput['references'];
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): ReviewReferenceInput | undefined {
  const hasContent =
    args.inputOrigin || args.references || args.text || args.prNumber || args.branch || args.url;
  if (!hasContent) return undefined;
  return {
    inputOrigin: args.inputOrigin,
    references: args.references,
    text: args.text,
    prNumber: args.prNumber,
    branch: args.branch,
    url: args.url,
  };
}

export function hasReviewContentInput(args: {
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): boolean {
  return hasConcreteContentField(args);
}

// ─── Canonical Source Validation ──────────────────────────────────────────────

/**
 * Result of canonical review-content source validation.
 *
 * This is the single authority that decides whether a `/review` call carries a
 * concrete content source.  It replaces the split between
 * `buildReviewReferenceInput` (which considers `inputOrigin` + `references`)
 * and `hasReviewContentInput` (which does not), so a declaration of intent
 * (`inputOrigin=branch`) that lacks the corresponding content field (`branch`)
 * is never silently treated as „no content“.
 */
export type ReviewContentSourceResult =
  | { readonly kind: 'valid' }
  | { readonly kind: 'none' }
  | { readonly kind: 'incomplete'; readonly blockCode: string; readonly blockMessage: string };

/**
 * Validate that a content-aware `/review` call carries at least one concrete
 * content source when `inputOrigin` or `references` are declared.
 *
 * `inputOrigin` and `references` are provenance metadata — they do **not**
 * load content by themselves.  Ungated metadata combined with no concrete
 * field (branch, text, prNumber, url) is an incomplete source and must be
 * blocked rather than treated as a content-free review.
 *
 * Calls with concrete content fields but no provenance metadata
 * (inputOrigin/references absent) are treated as implicit content-aware
 * reviews: the content is present, it just was not declared with origin
 * metadata.
 */
export function validateReviewContentSource(args: {
  inputOrigin?: string;
  references?: unknown;
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): ReviewContentSourceResult {
  if (hasConcreteContentField(args)) return { kind: 'valid' };

  const declared = hasDeclaredContentField(args);
  const signal = hasImplicitContentSignal(args);

  // Neither a content field nor provenance metadata — genuine content-free review.
  if (!declared && !signal) return { kind: 'none' };

  const labelParts = [
    signal && args.inputOrigin ? `inputOrigin=${args.inputOrigin}` : '',
    signal ? 'references' : '',
  ]
    .filter(Boolean)
    .join(', ');

  return {
    kind: 'incomplete',
    blockCode: 'REVIEW_CONTENT_SOURCE_INCOMPLETE',
    blockMessage: formatBlocked('REVIEW_CONTENT_SOURCE_INCOMPLETE', {
      label: labelParts || 'content field declared but empty or invalid',
    }),
  };
}

function hasConcreteContentField(args: {
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): boolean {
  return (
    (typeof args.text === 'string' && args.text.trim().length > 0) ||
    (typeof args.prNumber === 'number' && args.prNumber > 0) ||
    (typeof args.branch === 'string' && args.branch.trim().length > 0) ||
    (typeof args.url === 'string' && args.url.trim().length > 0)
  );
}

function hasDeclaredContentField(args: {
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): boolean {
  return (
    args.text !== undefined ||
    args.prNumber !== undefined ||
    args.branch !== undefined ||
    args.url !== undefined
  );
}

export function hasImplicitContentSignal(args: {
  inputOrigin?: string;
  references?: unknown;
}): boolean {
  const hasInputOrigin = typeof args.inputOrigin === 'string' && args.inputOrigin.trim().length > 0;
  const hasReferences =
    args.references !== undefined &&
    Array.isArray(args.references) &&
    (args.references as unknown[]).length > 0;
  return hasInputOrigin || hasReferences;
}

// ─── Branch Review Provenance ────────────────────────────────────────────────

export {
  BranchReviewSourceSchema,
  BranchReviewProvenanceSchema,
  ReviewProvenanceError,
  getRequiredBranchReviewSource,
  getRequiredBranchReviewProvenance,
  type RequiredBranchReviewSource,
  type RequiredBranchReviewProvenance,
} from '../../review/review-provenance.js';

function fingerprintVersionOf(obligation: ReviewObligation): 'v1' | 'v2' {
  return obligation.fingerprintVersion ?? 'v1';
}

export function matchesReviewObligationInput(
  obligation: ReviewObligation,
  args: ReviewToolArgs,
): boolean {
  const inputFingerprint = obligation.metadata?.inputFingerprint;
  return (
    typeof inputFingerprint === 'string' &&
    inputFingerprint === fingerprintReviewInput(args, fingerprintVersionOf(obligation))
  );
}

/** Option A continuation: re-supply the immutable source alongside identity and verdict. */
export function validateHostTaskContinuationInput(
  obligation: ReviewObligation,
  args: ReviewToolArgs,
): string | null {
  if (!hasReviewContentInput(args)) {
    return formatBlocked('REVIEW_OBLIGATION_INPUT_MISMATCH', {
      obligationId: obligation.obligationId,
      reason:
        'A host-task continuation must include the original immutable review content fields, reviewObligationId, and reviewVerdict.',
    });
  }
  if (!matchesReviewObligationInput(obligation, args)) {
    return formatBlocked('REVIEW_OBLIGATION_INPUT_MISMATCH', {
      obligationId: obligation.obligationId,
      reason: 'The supplied review input does not match the host-task review obligation.',
    });
  }
  return null;
}

// ─── Obligation lifecycle ────────────────────────────────────────────────────

/**
 * Persist a new obligation together with its attempt.
 *
 * Returns the assurance state that was actually written. Callers MUST layer
 * further updates onto this value, never onto the pre-write snapshot they read
 * at transaction start: that snapshot has no attempt, and re-deriving from it
 * silently drops the attempt record the host needs to bind reviewer evidence.
 */
export async function persistReviewObligation(
  sessDir: string,
  state: SessionState,
  obligation: ReviewObligation,
): Promise<{ attemptId: string; assurance: ReviewAssuranceState }> {
  const result = appendObligationWithAttempt(
    state.reviewAssurance,
    obligation,
    obligation.createdAt,
  );
  await writeStateWithArtifacts(sessDir, {
    ...state,
    reviewAssurance: result.assurance,
  });
  return { attemptId: result.attemptId, assurance: result.assurance };
}

interface NewReviewObligationInput {
  readonly state: SessionState;
  readonly args: ReviewToolArgs;
  readonly now: string;
  readonly worktree: string | undefined;
  readonly resolvedSource: ResolvedBranchReviewSource | undefined;
  readonly fingerprint: string;
  readonly inputFingerprint: string;
  readonly fingerprintVersion: 'v2';
}

async function createNewReviewObligation(
  input: NewReviewObligationInput,
): Promise<{ obligation?: ReviewObligation; blocked?: string }> {
  const classification = await resolveChallengeClassificationEvidence(input.state, input.worktree, {
    targetPaths: input.args.targetPaths,
    branch: input.args.branch,
    base: input.args.base,
    prNumber: input.args.prNumber,
  });
  if (classification.kind === 'unavailable') {
    return {
      blocked: formatBlocked('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', {
        reason: classification.reason,
      }),
    };
  }
  const resolvedTargetPaths =
    classification.kind === 'available' ? [...classification.changedFiles] : undefined;
  const metadata: Record<string, unknown> = {
    fingerprint: input.fingerprint,
    inputFingerprint: input.inputFingerprint,
  };
  if (resolvedTargetPaths) {
    metadata.targetPaths = resolvedTargetPaths;
  }
  if (input.args.branch && input.resolvedSource) {
    metadata.branch = input.args.branch;
    metadata.baseBranch = input.resolvedSource.baseBranch;
    metadata.resolvedBranchSha = input.resolvedSource.resolvedBranchSha;
    metadata.resolvedBaseSha = input.resolvedSource.resolvedBaseSha;
  }
  return {
    obligation: createReviewObligation({
      obligationType: 'review',
      iteration: 1,
      planVersion: 1,
      now: input.now,
      subjectDigest: input.fingerprint,
      reviewProfile: resolveFrozenReviewProfile(input.state.policySnapshot),
      profileSource: 'policy_default',
      policySnapshot: input.state.policySnapshot,
      changedFiles: resolvedTargetPaths,
      // No claimedTaskClass floor here: a standalone /review assesses an EXTERNAL
      // PR/branch/content whose risk is the reviewed diff itself (changedFiles),
      // not the session's own task-class claim. The C1 floor applies only to the
      // author's own change (plan/architecture/implement).
      metadata,
      fingerprintVersion: input.fingerprintVersion,
    }),
  };
}

export async function ensureMissingAnalysisObligation(
  sessDir: string,
  state: SessionState,
  args: ReviewToolArgs,
  now: string,
  context: Pick<NewReviewObligationInput, 'worktree' | 'resolvedSource'>,
): Promise<{
  message: string | null;
  obligation?: ReviewObligation;
  attemptId?: string;
  /** Set only when this call wrote state; authoritative over the caller's snapshot. */
  assurance?: ReviewAssuranceState;
}> {
  const sourceResult = validateReviewContentSource(args);
  if (sourceResult.kind === 'none') return { message: null };
  if (sourceResult.kind === 'incomplete') {
    return { message: sourceResult.blockMessage };
  }

  if (!hasReviewContentInput(args)) return { message: null };

  const fingerprint = fingerprintReviewInput(
    {
      ...args,
      resolvedBranchSha: context.resolvedSource?.resolvedBranchSha,
      resolvedBaseSha: context.resolvedSource?.resolvedBaseSha,
    },
    'v2',
  );
  const inputFingerprint = fingerprintReviewInput(args, 'v2');
  const existing = findLatestPendingReviewObligation(
    state.reviewAssurance,
    'review',
    fingerprint,
    'v2',
  );
  const verdictFirstCall = args.reviewVerdict !== undefined && existing === null;
  if (!verdictFirstCall && args.reviewFindings !== undefined) return { message: null };
  if (!existing) {
    return createAndPrepareMissingAnalysisObligation({
      sessDir,
      state,
      args,
      now,
      context,
      fingerprint,
      inputFingerprint,
      fingerprintVersion: 'v2',
    });
  }
  return {
    message: formatMissingContentAnalysis(
      existing.obligationId,
      state.policySnapshot?.reviewInvocationPolicy === 'host_task_required',
    ),
    obligation: existing,
  };
}

interface MissingAnalysisObligationInput {
  readonly sessDir: string;
  readonly context: Pick<NewReviewObligationInput, 'worktree' | 'resolvedSource'>;
  readonly state: SessionState;
  readonly args: ReviewToolArgs;
  readonly now: string;
  readonly fingerprint: string;
  readonly inputFingerprint: string;
  readonly fingerprintVersion: 'v2';
}

async function createAndPrepareMissingAnalysisObligation(
  input: MissingAnalysisObligationInput,
): Promise<{
  message: string | null;
  obligation?: ReviewObligation;
  attemptId?: string;
  assurance?: ReviewAssuranceState;
}> {
  const created = await createNewReviewObligation({
    state: input.state,
    args: input.args,
    now: input.now,
    fingerprint: input.fingerprint,
    inputFingerprint: input.inputFingerprint,
    fingerprintVersion: input.fingerprintVersion,
    ...input.context,
  });
  if (created.blocked) return { message: created.blocked };
  const obligation = created.obligation!;
  const persisted = await persistReviewObligation(input.sessDir, input.state, obligation);
  return {
    message: formatMissingContentAnalysis(
      obligation.obligationId,
      input.state.policySnapshot?.reviewInvocationPolicy === 'host_task_required',
    ),
    obligation,
    attemptId: persisted.attemptId,
    assurance: persisted.assurance,
  };
}

function isActiveReviewObligation(
  obligation: ReviewObligation | null,
): obligation is ReviewObligation {
  return (
    obligation?.obligationType === 'review' &&
    obligation.status !== 'consumed' &&
    obligation.status !== 'blocked'
  );
}

function validateSuppliedReviewObligation(input: {
  suppliedObligationId: string | undefined;
  obligation: ReviewObligation | null;
  attestationObligationId: string | undefined;
  args: ReviewToolArgs;
}): string | null {
  const { suppliedObligationId, obligation, attestationObligationId, args } = input;
  if (!suppliedObligationId) return null;
  let code = 'REVIEW_OBLIGATION_NOT_FOUND';
  let message: string | null = null;
  if (!isActiveReviewObligation(obligation)) {
    message = 'The supplied reviewObligationId does not identify an active review obligation.';
  } else if (!matchesReviewObligationInput(obligation, args)) {
    code = 'REVIEW_OBLIGATION_INPUT_MISMATCH';
    message = 'The supplied review input does not match reviewObligationId.';
  } else if (attestationObligationId && suppliedObligationId !== attestationObligationId) {
    message = 'reviewObligationId does not match reviewFindings.attestation.toolObligationId.';
  }
  return message
    ? JSON.stringify({
        error: true,
        code,
        message,
        obligationId: suppliedObligationId,
      })
    : null;
}

export async function resolveSubmittedReviewObligation(
  sessDir: string,
  state: SessionState,
  args: ReviewToolArgs,
  now: string,
  worktree: string | undefined,
): Promise<{ obligation: ReviewObligation | null; blocked?: string }> {
  const findings = args.reviewFindings as Record<string, unknown>;
  const attToolObligationId = (findings.attestation as Record<string, unknown> | undefined)
    ?.toolObligationId as string | undefined;
  const suppliedObligationId = args.reviewObligationId;
  const obligationById = suppliedObligationId
    ? findReviewObligationById(state.reviewAssurance, suppliedObligationId)
    : attToolObligationId
      ? findReviewObligationById(state.reviewAssurance, attToolObligationId)
      : null;
  const suppliedBlock = validateSuppliedReviewObligation({
    suppliedObligationId,
    obligation: obligationById,
    attestationObligationId: attToolObligationId,
    args,
  });
  if (suppliedBlock) {
    return {
      obligation: null,
      blocked: suppliedBlock,
    };
  }
  const fingerprint = fingerprintReviewInput(args, 'v2');
  let obligation =
    obligationById ??
    findLatestPendingReviewObligation(state.reviewAssurance, 'review', fingerprint, 'v2');

  if (!obligation) {
    const created = await createNewReviewObligation({
      state,
      args,
      now,
      worktree,
      resolvedSource: undefined,
      fingerprint,
      inputFingerprint: fingerprint,
      fingerprintVersion: 'v2',
    });
    if (created.blocked) return { obligation: null, blocked: created.blocked };
    obligation = created.obligation!;
    await persistReviewObligation(sessDir, state, obligation);
    return {
      obligation,
      blocked: formatSubagentReviewNotInvoked(
        'no review obligation found — a fresh obligation has been created. Re-submit your findings with the toolObligationId from the returned requiredReviewAttestation.',
        obligation.obligationId,
      ),
    };
  }
  return { obligation };
}

export function validateSubmittedReviewFindings(
  state: SessionState,
  args: ReviewToolArgs,
  obligation: ReviewObligation,
): string | null {
  if (obligation.status === 'consumed') {
    return formatSubagentReviewNotInvoked(
      'this review obligation has already been consumed. Start a fresh /review to create a new obligation.',
      obligation.obligationId,
    );
  }

  const findings = args.reviewFindings as Record<string, unknown>;
  if ((findings.reviewMode as string) !== 'subagent') {
    return formatSubagentReviewNotInvoked(
      `reviewMode is not "subagent" — findings did not come from the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      obligation.obligationId,
    );
  }

  // Fail-closed on the third LoopVerdict: a reviewer that declared the
  // content unreviewable MUST NOT let the standalone /review complete with a
  // passing report. This mirrors the plan/implement/architecture tool-layer
  // guard (review-validation.ts) and the SDK gate (content-review-pipeline.ts),
  // keeping all review flows symmetric and fail-closed.
  if ((findings.overallVerdict as string) === 'unable_to_review') {
    return formatSubagentReviewNotInvoked(
      'reviewer returned overallVerdict "unable_to_review" — the content was declared unreviewable; this obligation is consumed and cannot pass review',
      obligation.obligationId,
    );
  }

  const challengeConsistency = validateChallengeConsistency({
    overallVerdict: findings.overallVerdict as 'accept' | 'changes_requested' | 'unable_to_review',
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind ?? 'implementation_challenge',
    challenges: findings.challenges as Parameters<
      typeof validateChallengeConsistency
    >[0]['challenges'],
    // Obligation-scope + evidence binding for content challenges (findings
    // B3/B5): a content challenge must carry the active obligation id and cite
    // the canonical content ref, not a fabricated digest.
    expectedObligationId: obligation.obligationId,
    allowedEvidenceRefs: buildHostTaskChallengeContract(state, obligation)?.evidenceRefs,
    resolutionVerdicts: findings.challengeResolutionVerdicts as Parameters<
      typeof validateChallengeConsistency
    >[0]['resolutionVerdicts'],
    previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(state),
  });
  if (!challengeConsistency.ok) {
    return formatSubagentReviewNotInvoked(
      `${challengeConsistency.code}: ${JSON.stringify(challengeConsistency.details)}`,
      obligation.obligationId,
    );
  }

  const verdict = validateStrictAttestation(
    findings as unknown as Parameters<typeof validateStrictAttestation>[0],
    {
      obligationId: obligation.obligationId,
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
    },
  );
  return verdict
    ? formatSubagentReviewNotInvoked(
        `validateStrictAttestation returned ${verdict}`,
        obligation.obligationId,
      )
    : null;
}

export function consumeValidatedReviewObligation(
  result: StartedReviewResult,
  obligation: ReviewObligation | null,
  args: ReviewToolArgs,
  now: string,
  consumption?: {
    readonly acceptedInvocationId?: string | null;
    readonly effectiveReviewFindings?: ReviewFindings;
  },
): StartedReviewResult {
  if (!obligation) return result;
  return {
    ...result,
    state: {
      ...result.state,
      standaloneReviewFindings: [
        ...(result.state.standaloneReviewFindings ?? []),
        ...((consumption?.effectiveReviewFindings ?? args.reviewFindings)
          ? [consumption?.effectiveReviewFindings ?? args.reviewFindings!]
          : []),
      ],
      reviewAssurance: consumeReviewObligation(
        ensureReviewAssurance(result.state.reviewAssurance),
        obligation,
        now,
        consumption?.acceptedInvocationId ??
          findAcceptedInvocationForFindings(
            result.state.reviewAssurance,
            obligation,
            args.reviewFindings,
          )?.invocationId,
      ),
    },
  };
}
