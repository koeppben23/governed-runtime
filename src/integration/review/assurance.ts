/**
 * @module integration/review-assurance
 * @description SSOT helpers for strict independent-review obligations and evidence.
 */

import { randomUUID } from 'node:crypto';
import { hashText } from '../../shared/hashing.js';
export { hashText };
export { hashFindings } from './findings-hash.js';
import { hashFindings } from './findings-hash.js';

import type {
  ReviewAssuranceState,
  ReviewFindings,
  ReviewInvocationEvidence,
  ReviewInvocationMode,
  ReviewObligation,
  ReviewObligationType,
  ReviewProfile,
  ReviewProfileSource,
  PolicySnapshot,
  ReviewAttempt,
  ReviewAttemptDiscoveryContext,
  ReviewMaterial,
  FrozenReviewSubject,
  FrozenRepositoryAuthority,
} from '../../state/evidence.js';
import { hashCanonicalReviewContent, normalizeReviewContent } from '../../shared/review-subject.js';
import { deriveRepositoryRevisionProvenance } from '../../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { assessMinimumTaskClass, maxTaskClass } from '../phase-tool-gate.js';
import {
  challengeKindForObligation,
  DEFAULT_MAX_REVIEWER_OUTPUT_REPAIR_ATTEMPTS,
} from '../../config/policy-types.js';
import type { TaskClass } from '../../state/schema.js';
import type { ReviewSubjectScope } from '../../state/evidence-review.js';
// Static import - mandate content is a constant in ESM
import { REVIEWER_AGENT } from '../../templates/mandates.js';
export const REVIEW_CRITERIA_VERSION = 'p41-v1';
// Mandate digest - computed from actual REVIEWER_AGENT template at module load
export const REVIEW_MANDATE_DIGEST = hashText(REVIEWER_AGENT);
const defaultScope = (changedFiles: readonly string[] | undefined): ReviewSubjectScope =>
  changedFiles && changedFiles.length > 0
    ? { kind: 'repository_change', paths: [...changedFiles], revisions: ['head'] }
    : { kind: 'unavailable', reason: 'scope_not_resolved' };

function resolveSubjectScope(
  subjectDigest: string,
  explicitScope: ReviewSubjectScope | undefined,
  changedFiles: readonly string[] | undefined,
): ReviewSubjectScope {
  if (explicitScope?.kind !== 'artifact') return explicitScope ?? defaultScope(changedFiles);
  return {
    ...explicitScope,
    artifact: { ...explicitScope.artifact, digest: subjectDigest },
  };
}

function resolveSubjectDigest(input: {
  subjectDigest: string;
  reviewSubject?: FrozenReviewSubject;
}): string {
  return input.reviewSubject?.subjectDigest ?? input.subjectDigest;
}

export {
  emptyReviewAssurance,
  ensureReviewAssurance,
  createReviewAttempt,
  createAttemptForExistingObligation,
  latestReviewMaterial,
  appendReviewAttempt,
  resolveAttempt,
  resolveEvidenceAuthorizingAttempt,
  EVIDENCE_AUTHORIZING_ATTEMPT_STATUSES,
  findBindableAttempt,
  updateAttemptStatus,
  staleObligationAttempts,
} from './attempt-lifecycle.js';
import {
  ensureReviewAssurance,
  createReviewAttempt,
  appendReviewAttempt,
  staleObligationAttempts,
} from './attempt-lifecycle.js';

export function getReviewMandateDigest(): string {
  return REVIEW_MANDATE_DIGEST;
}

/**
 * Resolve the opaque observation capability of the attempt a reviewer Task
 * will bind to: the highest-ordinal attempt of the obligation. Returns null
 * when no attempt or capability exists (legacy attempts minted before the
 * frozen-repository-authority generation) — repository evidence is then
 * unavailable for the attempt.
 */
export function resolveAttemptObservationCapability(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
): string | null {
  const base = ensureReviewAssurance(assurance);
  const attempts = base.attempts.filter((a) => a.obligationId === obligationId);
  if (attempts.length === 0) return null;
  const latest = attempts.reduce((best, a) => (a.ordinal > best.ordinal ? a : best));
  return latest.observationCapability ?? null;
}

export function createReviewObligation(input: {
  obligationType: ReviewObligationType;
  iteration: number;
  planVersion: number;
  now: string;
  /**
   * Digest of the subject artifact (plan digest, implementation digest, or
   * reviewed content digest). Frozen at obligation creation so the host can
   * verify at binding time that the reviewer's evidence addresses exactly this
   * subject — not a different plan version or different branch. Never supplied
   * by or echoed from the reviewer.
   * Required. Obligations without an authoritative subjectDigest are fail-closed
   * rejected; no binding is possible without a proven subject identity.
   */
  subjectDigest: string;
  /** Frozen standalone content/repository subject, when this is a standalone review. */
  reviewSubject?: FrozenReviewSubject;
  /** Exact normalized artifact bytes frozen for host-task delivery. */
  reviewMaterial?: ReviewMaterial;
  /**
   * Mandatory review coverage profile frozen into the obligation at creation,
   * before any reviewer invocation. Defaults to the fail-closed 'core' baseline.
   */
  reviewProfile?: ReviewProfile;
  /** Provenance of the frozen profile. Defaults to 'policy_default'. */
  profileSource?: ReviewProfileSource;
  /**
   * Frozen session policy; without its challenge policy, enforcement is
   * disabled. The output-repair budget is frozen onto the obligation from the
   * snapshot at creation — the reissue gate never re-reads live config.
   */
  policySnapshot?: Pick<
    PolicySnapshot,
    'challengePolicy' | 'maxReviewerOutputRepairAttempts'
  > | null;
  /** Runtime paths classified by the canonical phase-tool gate. */
  changedFiles?: readonly string[];
  /** Explicit structured subject scope. Absent → derived from changedFiles only. */
  reviewSubjectScope?: ReviewSubjectScope;
  /**
   * Frozen repository authority for repository-governed obligations. The
   * persisted revision-provenance projection is derived CANONICALLY from this
   * authority (or from the frozen review subject) — never supplied as a
   * mutable runtime snapshot (e.g. `git rev-parse HEAD`).
   */
  repositoryAuthority?: FrozenRepositoryAuthority;
  /**
   * The author's declared task class. Used as a fail-closed FLOOR on the
   * challenge count so a high-risk change cannot collapse the requirement to 0
   * by declaring doc-only `targetPaths` (finding C1). The count is
   * `counts[max(computedFromChangedFiles, claimedTaskClass)]`. NOT supplied for
   * standalone /review, whose risk is the reviewed external diff, not the
   * session's own task-class claim.
   */
  claimedTaskClass?: TaskClass;
  metadata?: Record<string, unknown>;
  fingerprintVersion?: 'v1' | 'v2';
}): ReviewObligation {
  if (!input.subjectDigest || input.subjectDigest.length === 0) {
    throw new Error(
      'FAIL_CLOSED: createReviewObligation requires a non-empty subjectDigest. ' +
        'Obligations without an authoritative subject identity cannot produce bindable evidence.',
    );
  }
  const challengePolicy = input.policySnapshot?.challengePolicy;
  const subjectDigest = resolveSubjectDigest(input);
  const reviewSubjectScope = resolveSubjectScope(
    subjectDigest,
    input.reviewSubjectScope,
    input.changedFiles,
  );
  const requirements = challengePolicy
    ? {
        requiredChallengeCount:
          challengePolicy.counts[
            maxTaskClass(
              assessMinimumTaskClass(input.changedFiles ?? []).minimumTaskClass,
              input.claimedTaskClass ?? 'TRIVIAL',
            )
          ],
        requiredChallengeKind: challengeKindForObligation(input.obligationType),
        challengePolicyVersion: challengePolicy.version,
      }
    : {};
  return {
    obligationId: randomUUID(),
    obligationType: input.obligationType,
    iteration: input.iteration,
    planVersion: input.planVersion,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    createdAt: input.now,
    pluginHandshakeAt: null,
    status: 'pending',
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    // Fail-closed: freeze the mandatory 'core' baseline when no profile is
    // supplied. The profile is fixed here, before the reviewer is invoked.
    reviewProfile: input.reviewProfile ?? 'core',
    profileSource: input.profileSource ?? 'policy_default',
    ...requirements,
    subjectDigest,
    ...(input.reviewMaterial ? { reviewMaterial: input.reviewMaterial } : {}),
    reviewSubject: input.reviewSubject,
    metadata: input.metadata,
    ...(input.fingerprintVersion ? { fingerprintVersion: input.fingerprintVersion } : {}),
    reviewSubjectScope,
    repositoryRevisionProvenance: deriveRepositoryRevisionProvenance({
      repositoryAuthority: input.repositoryAuthority,
      reviewSubject: input.reviewSubject,
    }),
    ...(input.repositoryAuthority ? { repositoryAuthority: input.repositoryAuthority } : {}),
    // Frozen output-repair budget. The canonical policy default applies at
    // creation time only; the reissue gate reads this frozen value, never the
    // live config, so a later policy change cannot re-open a settled
    // obligation's repair window.
    maxReviewerOutputRepairAttempts: resolveFrozenOutputRepairBudget(input.policySnapshot),
  };
}

/** Freeze review bytes with the canonical standalone-content normalization and digest. */
export function freezeReviewMaterial(content: string): ReviewMaterial {
  const normalized = normalizeReviewContent(content);
  return { content: normalized, materialDigest: hashCanonicalReviewContent(normalized) };
}

export function resolveFrozenReviewProfile(
  policySnapshot: { reviewProfile?: string } | null | undefined,
): ReviewProfile {
  const raw = policySnapshot?.reviewProfile;
  return raw === 'core' || raw === 'full' ? raw : 'core';
}

/**
 * Frozen output-repair budget for an obligation. The canonical policy default
 * applies at creation time only; the reissue gate reads the frozen obligation
 * value, never the live config.
 */
function resolveFrozenOutputRepairBudget(
  policySnapshot:
    Pick<PolicySnapshot, 'challengePolicy' | 'maxReviewerOutputRepairAttempts'> | null | undefined,
): number {
  return (
    policySnapshot?.maxReviewerOutputRepairAttempts ?? DEFAULT_MAX_REVIEWER_OUTPUT_REPAIR_ATTEMPTS
  );
}

export function appendReviewObligation(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation | null,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  if (!obligation) return base;
  return {
    ...base,
    obligations: [...base.obligations, obligation],
  };
}

export function reviewObligationResponseFields(
  obligation: ReviewObligation | null,
  attemptId?: string | null,
): Record<string, unknown> {
  if (!obligation) return {};
  return {
    reviewObligation: {
      obligationId: obligation.obligationId,
      obligationType: obligation.obligationType,
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
      criteriaVersion: obligation.criteriaVersion,
      mandateDigest: obligation.mandateDigest,
      requiredChallengeCount: obligation.requiredChallengeCount,
      requiredChallengeKind: obligation.requiredChallengeKind,
    },
    reviewObligationId: obligation.obligationId,
    reviewObligationIteration: obligation.iteration,
    reviewObligationPlanVersion: obligation.planVersion,
    reviewCriteriaVersion: obligation.criteriaVersion,
    reviewMandateDigest: obligation.mandateDigest,
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind,
    ...(attemptId ? { reviewAttemptId: attemptId } : {}),
  };
}

export function findLatestObligation(
  obligations: ReviewObligation[],
  obligationType: ReviewObligationType,
  iteration: number,
  planVersion: number,
): ReviewObligation | null {
  for (let i = obligations.length - 1; i >= 0; i--) {
    const item = obligations[i];
    if (
      item &&
      item.obligationType === obligationType &&
      item.iteration === iteration &&
      item.planVersion === planVersion
    ) {
      return item;
    }
  }
  return null;
}

export function findLatestPendingReviewObligation(
  assurance: ReviewAssuranceState | undefined,
  obligationType: ReviewObligationType,
  metadataFingerprint?: string,
  fingerprintVersion?: 'v1' | 'v2',
): ReviewObligation | null {
  const base = ensureReviewAssurance(assurance);
  const candidates = base.obligations.filter(
    (o) => o.obligationType === obligationType && o.status === 'pending',
  );
  // Fingerprint filter: when provided, only match obligations with the same
  // input fingerprint. For review obligations, fingerprinting is mandatory
  // because multiple review inputs can be pending simultaneously.
  // For plan/implement/architecture, there is at most one pending obligation
  // per type at a time, so broad matching is acceptable.
  if (metadataFingerprint) {
    return (
      candidates
        .filter(
          (o) =>
            o.metadata &&
            o.metadata.fingerprint === metadataFingerprint &&
            (fingerprintVersion === undefined ||
              (o.fingerprintVersion ?? 'v1') === fingerprintVersion),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .at(0) ?? null
    );
  }
  // Broad match: return the latest pending obligation of this type.
  // Only safe when fingerprinting is not required (plan, implement, architecture).
  const broad = candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return broad.at(0) ?? null;
}

export function findReviewObligationById(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
): ReviewObligation | null {
  const base = ensureReviewAssurance(assurance);
  return base.obligations.find((o) => o.obligationId === obligationId) ?? null;
}

export function findLatestUnconsumedObligation(
  assurance: ReviewAssuranceState | undefined,
  obligationType: ReviewObligationType,
): ReviewObligation | null {
  const base = ensureReviewAssurance(assurance);
  return (
    base.obligations
      .filter(
        (o) =>
          o.obligationType === obligationType && o.status !== 'consumed' && o.consumedAt === null,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .at(0) ?? null
  );
}

export function consumeReviewObligation(
  assurance: ReviewAssuranceState,
  obligation: ReviewObligation | null,
  now: string,
  acceptedInvocationId?: string | null,
): ReviewAssuranceState {
  if (!obligation) return assurance;
  const invocationId = acceptedInvocationId ?? obligation.invocationId;
  return {
    ...assurance,
    obligations: assurance.obligations.map((item) => {
      if (item.obligationId !== obligation.obligationId) return item;
      return {
        ...item,
        status: 'consumed' as const,
        consumedAt: now,
      };
    }),
    invocations: assurance.invocations.map((invocation) => {
      if (!invocationId || invocation.invocationId !== invocationId) {
        return invocation;
      }
      return {
        ...invocation,
        consumedByObligationId: obligation.obligationId,
      };
    }),
  };
}

export function findAcceptedInvocationForFindings(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation | null,
  findings: ReviewFindings | null | undefined,
): ReviewInvocationEvidence | null {
  if (!obligation || !findings) return null;
  const findingsHash = hashFindings(findings);
  const base = ensureReviewAssurance(assurance);

  if (obligation.invocationId) {
    return (
      base.invocations.find(
        (invocation) =>
          invocation.invocationId === obligation.invocationId &&
          invocation.obligationId === obligation.obligationId &&
          invocation.childSessionId === findings.reviewedBy.sessionId &&
          invocation.findingsHash === findingsHash &&
          invocation.consumedByObligationId === null,
      ) ?? null
    );
  }

  return (
    base.invocations.find(
      (invocation) =>
        invocation.obligationId === obligation.obligationId &&
        invocation.invocationMode === 'host_subagent_task' &&
        invocation.hostVisible === true &&
        invocation.childSessionId === findings.reviewedBy.sessionId &&
        invocation.findingsHash === findingsHash &&
        invocation.consumedByObligationId === null,
    ) ?? null
  );
}

/** Create an obligation and its initial attempt atomically.
 *
 * The attempt is persisted alongside the obligation at creation time,
 * BEFORE the reviewer subagent is invoked. This satisfies the core
 * security invariant that attempts are invocation envelopes, not
 * post-hoc callback records.
 *
 * Existing non-bound attempts for the same obligation are staled.
 */
export function createObligationAndAttempt(
  assurance: ReviewAssuranceState | undefined,
  obligationInput: Parameters<typeof createReviewObligation>[0],
  now: string,
  repositoryDiscovery: ReviewAttemptDiscoveryContext = { kind: 'not_applicable' },
): { assurance: ReviewAssuranceState; obligation: ReviewObligation; attempt: ReviewAttempt } {
  const obligation = createReviewObligation(obligationInput);
  const ordinal =
    (ensureReviewAssurance(assurance).attempts?.filter(
      (a) => a.obligationId === obligation.obligationId,
    ).length ?? 0) + 1;
  const attempt = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligationInput.subjectDigest,
    reviewMaterial: obligation.reviewMaterial,
    ordinal,
    origin: { kind: 'initial' },
    repositoryDiscovery,
    now,
  });
  const withObligation = appendReviewObligation(assurance, obligation);
  const withAttempt = appendReviewAttempt(withObligation, attempt);
  const deduped = staleObligationAttempts(
    withAttempt,
    obligation.obligationId,
    attempt.attemptId,
    now,
  );
  return { assurance: deduped, obligation, attempt };
}

/**
 * Append an obligation AND its initial attempt to the assurance state atomically.
 *
 * This is the simplest integration point for call sites that currently call
 * `appendReviewObligation`. The attempt is created BEFORE any reviewer subagent
 * is invoked, satisfying the core security invariant.
 *
 * @returns Updated assurance state with obligation and attempt persisted.
 */
export function appendObligationWithAttempt(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation,
  now: string,
  repositoryDiscovery: ReviewAttemptDiscoveryContext = { kind: 'not_applicable' },
): { assurance: ReviewAssuranceState; attemptId: string } {
  const base = ensureReviewAssurance(assurance);
  const ordinal =
    (base.attempts?.filter((a) => a.obligationId === obligation.obligationId).length ?? 0) + 1;
  const attempt = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    reviewMaterial: obligation.reviewMaterial,
    ordinal,
    origin: { kind: 'initial' },
    repositoryDiscovery,
    now,
  });
  const withObligation = { ...base, obligations: [...base.obligations, obligation] };
  const withAttempt = appendReviewAttempt(withObligation, attempt);
  return {
    assurance: staleObligationAttempts(
      withAttempt,
      obligation.obligationId,
      attempt.attemptId,
      now,
    ),
    attemptId: attempt.attemptId,
  };
}

export function buildInvocationEvidence(input: {
  obligationId: string;
  obligationType: ReviewObligationType;
  /** Frozen mandate generation of the bound obligation, never live runtime defaults. */
  mandateDigest: string;
  /** Frozen criteria generation of the bound obligation, never live runtime defaults. */
  criteriaVersion: string;
  parentSessionId: string;
  childSessionId: string;
  invocationMode: ReviewInvocationMode;
  hostVisible: boolean;
  promptHash: string;
  findingsHash: string;
  invokedAt: string;
  fulfilledAt?: string;
  source?: 'host-orchestrated' | 'agent-submitted-attested';
  reviewOutputMode?: 'structured_output' | 'text_compat';
  structuredOutputUsed?: boolean;
  reviewAssuranceLevel?: 'structured_high' | 'structured_recovered' | 'text_compat_lower';
  extractionMethod?: 'direct_json' | 'json_fence' | 'outermost_braces';
  modelCapabilityError?: string;
  /** Captured verdict from the reviewer's actual output (host-task authoritative). */
  capturedVerdict?: string;
  /** Complete raw findings from the reviewer's output (host-task only).
   *  Enables evidence-based findings resolution without agent reconstruction. */
  capturedRawFindings?: Record<string, unknown>;
  /** Independent host-captured reviewer corroboration (native_subagent_attested only). */
  hostCapturedAgentId?: string;
  hostCapturedAgentType?: typeof REVIEWER_SUBAGENT_TYPE;
  hostCaptureSource?: 'subagent_stop_hook' | 'post_tool_use_hook';
  /** Resolved full head commit SHA (branch reviews only). */
  resolvedBranchSha?: string | null;
  /** Resolved full base commit SHA (branch reviews only). */
  resolvedBaseSha?: string | null;
  /** SHA-256 digest of the extracted/reviewed content (branch reviews only). */
  reviewedContentDigest?: string | null;
  /** Persisted attempt ID bound at evidence-assembly time. */
  attemptId?: string;
}): ReviewInvocationEvidence {
  const reviewOutputMode = input.reviewOutputMode ?? 'structured_output';
  const structuredOutputUsed =
    input.structuredOutputUsed ?? reviewOutputMode === 'structured_output';
  const reviewAssuranceLevel =
    input.reviewAssuranceLevel ??
    (reviewOutputMode === 'text_compat' ? 'text_compat_lower' : 'structured_high');
  return {
    invocationId: randomUUID(),
    obligationId: input.obligationId,
    obligationType: input.obligationType,
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    agentType: REVIEWER_SUBAGENT_TYPE,
    invocationMode: input.invocationMode,
    hostVisible: input.hostVisible,
    promptHash: input.promptHash,
    mandateDigest: input.mandateDigest,
    criteriaVersion: input.criteriaVersion,
    findingsHash: input.findingsHash,
    invokedAt: input.invokedAt,
    fulfilledAt: input.fulfilledAt ?? null,
    consumedByObligationId: null,
    source: input.source,
    reviewOutputMode,
    structuredOutputUsed,
    reviewAssuranceLevel,
    resolvedBranchSha: input.resolvedBranchSha ?? null,
    resolvedBaseSha: input.resolvedBaseSha ?? null,
    reviewedContentDigest: input.reviewedContentDigest ?? null,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...buildOptionalInvocationFields(input),
  };
}

function buildOptionalInvocationFields(input: {
  extractionMethod?: 'direct_json' | 'json_fence' | 'outermost_braces';
  modelCapabilityError?: string;
  capturedVerdict?: string;
  capturedRawFindings?: Record<string, unknown>;
  hostCapturedAgentId?: string;
  hostCapturedAgentType?: typeof REVIEWER_SUBAGENT_TYPE;
  hostCaptureSource?: 'subagent_stop_hook' | 'post_tool_use_hook';
}): Record<string, unknown> {
  return {
    ...(input.extractionMethod ? { extractionMethod: input.extractionMethod } : {}),
    ...(input.modelCapabilityError ? { modelCapabilityError: input.modelCapabilityError } : {}),
    ...(input.capturedVerdict ? { capturedVerdict: input.capturedVerdict } : {}),
    ...(input.capturedRawFindings ? { capturedRawFindings: input.capturedRawFindings } : {}),
    ...(input.hostCapturedAgentId ? { hostCapturedAgentId: input.hostCapturedAgentId } : {}),
    ...(input.hostCapturedAgentType ? { hostCapturedAgentType: input.hostCapturedAgentType } : {}),
    ...(input.hostCaptureSource ? { hostCaptureSource: input.hostCaptureSource } : {}),
  };
}

export function hasEvidenceReuse(
  invocations: ReviewInvocationEvidence[],
  childSessionId: string,
  findingsHash: string,
): boolean {
  return invocations.some(
    (item) => item.childSessionId === childSessionId || item.findingsHash === findingsHash,
  );
}

export function appendInvocationEvidence(
  assurance: ReviewAssuranceState,
  invocation: ReviewInvocationEvidence,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  return { ...base, invocations: [...base.invocations, invocation] };
}

export function fulfillObligation(
  assurance: ReviewAssuranceState,
  obligationId: string,
  invocationId: string,
  now: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  const obligation = base.obligations.find((item) => item.obligationId === obligationId);
  if (!obligation) throw new Error(`Review obligation not found: ${obligationId}`);
  if (obligation.status !== 'pending') {
    if (obligation.status === 'fulfilled' && obligation.invocationId === invocationId) return base;
    throw new Error(`Cannot fulfill review obligation in status ${obligation.status}`);
  }
  return {
    ...base,
    obligations: base.obligations.map((item) =>
      item.obligationId !== obligationId
        ? item
        : { ...item, status: 'fulfilled' as const, invocationId, fulfilledAt: now },
    ),
  };
}

export function validateStrictAttestation(
  findings: ReviewFindings,
  expected: {
    obligationId: string;
    iteration: number;
    planVersion: number;
  },
): 'SUBAGENT_MANDATE_MISSING' | 'SUBAGENT_MANDATE_MISMATCH' | null {
  const att = findings.attestation;
  if (!att) return 'SUBAGENT_MANDATE_MISSING';

  if (
    att.mandateDigest !== REVIEW_MANDATE_DIGEST ||
    att.criteriaVersion !== REVIEW_CRITERIA_VERSION ||
    att.toolObligationId !== expected.obligationId ||
    att.iteration !== expected.iteration ||
    att.planVersion !== expected.planVersion ||
    att.reviewedBy !== REVIEWER_SUBAGENT_TYPE
  ) {
    return 'SUBAGENT_MANDATE_MISMATCH';
  }

  return null;
}
