/**
 * @module integration/review-assurance
 * @description SSOT helpers for strict independent-review obligations and evidence.
 */

import { randomUUID } from 'node:crypto';
import { hashText } from '../../shared/hashing.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
export { hashText };

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
} from '../../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { assessMinimumTaskClass, maxTaskClass } from '../phase-tool-gate.js';
import { challengeKindForObligation } from '../../config/policy-types.js';
import type { TaskClass } from '../../state/schema.js';
import type {
  ReviewRepositoryRevisionProvenance,
  ReviewSubjectScope,
} from '../../state/evidence-review.js';

// Static import - mandate content is a constant in ESM
import { REVIEWER_AGENT } from '../../templates/mandates.js';
export const REVIEW_CRITERIA_VERSION = 'p40-v1';
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
export function getReviewMandateDigest(): string {
  return REVIEW_MANDATE_DIGEST;
}

export function emptyReviewAssurance(): ReviewAssuranceState {
  return { obligations: [], invocations: [], attempts: [] };
}

export function ensureReviewAssurance(
  assurance: ReviewAssuranceState | undefined,
): ReviewAssuranceState {
  return assurance ?? emptyReviewAssurance();
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
  /**
   * Mandatory review coverage profile frozen into the obligation at creation,
   * before any reviewer invocation. Defaults to the fail-closed 'core' baseline.
   */
  reviewProfile?: ReviewProfile;
  /** Provenance of the frozen profile. Defaults to 'policy_default'. */
  profileSource?: ReviewProfileSource;
  /** Frozen session policy; without its challenge policy, enforcement is disabled. */
  policySnapshot?: Pick<PolicySnapshot, 'challengePolicy'> | null;
  /** Runtime paths classified by the canonical phase-tool gate. */
  changedFiles?: readonly string[];
  /** Explicit structured subject scope. Absent → derived from changedFiles only. */
  reviewSubjectScope?: ReviewSubjectScope;
  repositoryRevisionProvenance?: ReviewRepositoryRevisionProvenance;
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
  const reviewSubjectScope = resolveSubjectScope(
    input.subjectDigest,
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
    subjectDigest: input.subjectDigest,
    metadata: input.metadata,
    ...(input.fingerprintVersion ? { fingerprintVersion: input.fingerprintVersion } : {}),
    reviewSubjectScope,
    repositoryRevisionProvenance: input.repositoryRevisionProvenance ?? {
      kind: 'unavailable',
      reason: 'repository_revision_not_resolved',
    },
  };
}

export function resolveFrozenReviewProfile(
  policySnapshot: { reviewProfile?: string } | null | undefined,
): ReviewProfile {
  const raw = policySnapshot?.reviewProfile;
  return raw === 'core' || raw === 'full' ? raw : 'core';
}

export function appendReviewObligation(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation | null,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  if (!obligation) return base;
  return {
    obligations: [...base.obligations, obligation],
    invocations: base.invocations,
    attempts: base.attempts,
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
    attempts: assurance.attempts,
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

export function hashFindings(findings: Record<string, unknown>): string {
  const normalizeFinding = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const finding = value as Record<string, unknown>;
    const { findingId: _findingId, relation, ...rest } = finding;
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) return rest;
    const typedRelation = relation as Record<string, unknown>;
    const sorted = (items: unknown) =>
      Array.isArray(items)
        ? [...items].sort((left, right) =>
            canonicalJsonStringify(left).localeCompare(canonicalJsonStringify(right)),
          )
        : items;
    return {
      ...rest,
      relation: {
        ...typedRelation,
        subjectAnchors: sorted(typedRelation.subjectAnchors),
        evidenceLocations: sorted(typedRelation.evidenceLocations),
      },
    };
  };
  return hashText(
    canonicalJsonStringify({
      ...findings,
      blockingIssues: Array.isArray(findings.blockingIssues)
        ? findings.blockingIssues.map(normalizeFinding)
        : findings.blockingIssues,
      majorRisks: Array.isArray(findings.majorRisks)
        ? findings.majorRisks.map(normalizeFinding)
        : findings.majorRisks,
    }),
  );
}

export function createReviewAttempt(input: {
  obligationId: string;
  obligationType: ReviewObligationType;
  subjectDigest: string;
  ordinal: number;
  childSessionId?: string;
  now: string;
}): ReviewAttempt {
  return {
    attemptId: randomUUID(),
    obligationId: input.obligationId,
    obligationType: input.obligationType,
    subjectDigest: input.subjectDigest,
    ordinal: input.ordinal,
    childSessionId: input.childSessionId,
    status: 'created',
    createdAt: input.now,
  };
}

/** Create an obligation and its initial attempt atomically.
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
    ordinal,
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

/** Append an obligation AND its initial attempt to the assurance state atomically.
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
): { assurance: ReviewAssuranceState; attemptId: string } {
  const base = ensureReviewAssurance(assurance);
  const ordinal =
    (base.attempts?.filter((a) => a.obligationId === obligation.obligationId).length ?? 0) + 1;
  const attempt = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    ordinal,
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

/** Create a new attempt for an EXISTING obligation (retry / re-invocation).
 * Unlike createObligationAndAttempt (which creates a new obligation), this
 * attaches a new attempt to an already-persisted obligation. Previous
 * non-bound attempts for this obligation are staled — so a late callback
 * from the previous reviewer invocation is hard-rejected.
 *
 * @returns Updated assurance state with the new attempt persisted.
 */
export function createAttemptForExistingObligation(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation,
  childSessionId: string,
  now: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  const ordinal =
    (base.attempts?.filter((a) => a.obligationId === obligation.obligationId).length ?? 0) + 1;
  const attempt = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    ordinal,
    childSessionId,
    now,
  });
  const withAttempt = appendReviewAttempt(base, attempt);
  return staleObligationAttempts(withAttempt, obligation.obligationId, attempt.attemptId, now);
}

export function appendReviewAttempt(
  assurance: ReviewAssuranceState,
  attempt: ReviewAttempt,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  return { ...base, attempts: [...(base.attempts ?? []), attempt] };
}

export function resolveAttempt(
  assurance: ReviewAssuranceState | undefined,
  childSessionId: string,
): ReviewAttempt | null {
  const base = ensureReviewAssurance(assurance);
  return (
    base.attempts?.find(
      (a) => a.childSessionId === childSessionId && a.status !== 'stale' && a.status !== 'expired',
    ) ?? null
  );
}

/**
 * The attempt a host Task can still be bound to for `obligationId`.
 *
 * Bindable means: created but not yet correlated with a reviewer child session,
 * and not superseded (`appendObligationWithAttempt` stales earlier attempts, so
 * at most one attempt per obligation qualifies). Returns the highest ordinal if
 * that invariant is ever violated, and null when no attempt can accept a
 * binding — callers must not fall back to an arbitrary attempt.
 */
export function findBindableAttempt(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
): ReviewAttempt | null {
  const base = ensureReviewAssurance(assurance);
  const candidates = (base.attempts ?? []).filter(
    (a) => a.obligationId === obligationId && a.status === 'created' && !a.childSessionId,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, a) => (a.ordinal > best.ordinal ? a : best));
}

export function updateAttemptStatus(
  assurance: ReviewAssuranceState,
  attemptId: string,
  status: ReviewAttempt['status'],
  now: string,
  childSessionId?: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  if (!base.attempts) return base;
  return {
    ...base,
    attempts: base.attempts.map((a) =>
      a.attemptId !== attemptId
        ? a
        : {
            ...a,
            status,
            completedAt: status !== 'created' ? now : a.completedAt,
            ...(childSessionId && !a.childSessionId ? { childSessionId } : {}),
          },
    ),
  };
}

export function staleObligationAttempts(
  assurance: ReviewAssuranceState,
  obligationId: string,
  exceptAttemptId: string,
  now: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  if (!base.attempts) return base;
  return {
    ...base,
    attempts: base.attempts.map((a) =>
      a.obligationId === obligationId && a.attemptId !== exceptAttemptId && a.status !== 'bound'
        ? { ...a, status: 'stale' as const, completedAt: now }
        : a,
    ),
  };
}

export function buildInvocationEvidence(input: {
  obligationId: string;
  obligationType: ReviewObligationType;
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
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
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
