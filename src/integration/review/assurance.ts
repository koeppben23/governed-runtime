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
import { indexMarkdownSections } from '../../shared/markdown-sections.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import {
  DEFAULT_MAX_REVIEWER_ATTEMPTS,
  CHALLENGE_POLICY_V1,
  type ChallengePolicy,
} from '../../config/policy-types.js';
import type { TaskClass } from '../../state/schema.js';
import type { ReviewSubjectScope } from '../../state/evidence-review.js';
import type { RepositoryEvidenceFreeze } from '../../state/evidence-review-freeze.js';
import { assertRepositoryFreezeCoherence } from './freeze-coherence.js';
// Static import - mandate content is a constant in ESM
import { REVIEWER_AGENT } from '../../templates/mandates.js';
export const REVIEW_CRITERIA_VERSION = 'p42-v1';
// Mandate digest - computed from actual REVIEWER_AGENT template at module load
export const REVIEW_MANDATE_DIGEST = hashText(REVIEWER_AGENT);

export function isCurrentReviewGeneration(
  input: Pick<ReviewObligation, 'criteriaVersion' | 'mandateDigest'>,
): boolean {
  return (
    input.criteriaVersion === REVIEW_CRITERIA_VERSION &&
    input.mandateDigest === REVIEW_MANDATE_DIGEST
  );
}
import {
  resolveSubjectScope,
  resolveChallengeRequirements,
  requireArtifactSubjectScope,
  requireImplementationSubjectScope,
} from './subject-scope.js';

function resolveSubjectDigest(input: {
  subjectDigest: string;
  reviewSubject?: FrozenReviewSubject;
}): string {
  return input.reviewSubject?.subjectDigest ?? input.subjectDigest;
}

/**
 * Mint the canonical artifact subject scope for pre-implementation reviews
 * (plan, ADR). The subject is the exact frozen artifact, indexed by the same
 * canonical Markdown section authority that feeds the reviewer prompt's
 * evidence refs (`indexMarkdownSections`), so scope sections and reviewer-
 * visible sections are structurally identical.
 *
 * Fail-closed: an artifact without ATX headings cannot produce section anchors
 * and therefore cannot support a bindable artifact review.
 */
export function artifactReviewSubjectScope(
  kind: 'plan' | 'adr',
  markdown: string,
  digest: string,
): ReviewSubjectScope {
  const sectionPaths = indexMarkdownSections(markdown).map((section) => section.sectionPath);
  if (sectionPaths.length === 0) {
    throw new Error(
      `FAIL_CLOSED: cannot mint a ${kind} artifact review subject scope from Markdown ` +
        'without ATX headings; artifact review findings must anchor to concrete sections.',
    );
  }
  return {
    kind: 'artifact',
    artifact: { kind, digest, sectionPaths },
  };
}

export {
  emptyReviewAssurance,
  ensureReviewAssurance,
  createReviewAttempt,
  createAttemptForExistingObligation,
  appendReviewAttempt,
  resolveAttempt,
  resolveEvidenceAuthorizingAttempt,
  EVIDENCE_AUTHORIZING_ATTEMPT_STATUSES,
  findBindableAttempt,
  updateAttemptStatus,
} from './attempt-lifecycle.js';
import {
  ensureReviewAssurance,
  createReviewAttempt,
  appendReviewAttempt,
  staleObligationAttempts,
  mintObservationCapabilityIfResolvable,
} from './attempt-lifecycle.js';

/**
 * Resolve the opaque observation capability of the attempt a reviewer Task
 * will bind to: the highest-ordinal attempt of the obligation. Returns null
 * when no attempt exists or the obligation backs no frozen repository
 * revision — repository evidence is then unavailable for the attempt.
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

function assertSubjectDigest(subjectDigest: string): void {
  if (!subjectDigest || subjectDigest.length === 0) {
    throw new Error(
      'FAIL_CLOSED: createReviewObligation requires a non-empty subjectDigest. ' +
        'Obligations without an authoritative subject identity cannot produce bindable evidence.',
    );
  }
}

export function createReviewObligation(input: {
  obligationType: ReviewObligationType;
  iteration: number;
  reviewCycle: number | null;
  planVersion: number;
  now: string;
  subjectDigest: string;
  claimDeclarationsDigest?: string;
  reviewSubject?: FrozenReviewSubject;
  reviewMaterial: ReviewMaterial;
  reviewProfile?: ReviewProfile;
  profileSource?: ReviewProfileSource;
  policySnapshot?:
    | (Pick<PolicySnapshot, 'maxReviewerAttempts'> & {
        challengePolicy?: ChallengePolicy;
      })
    | null;
  changedFiles?: readonly string[];
  reviewSubjectScope?: ReviewSubjectScope;
  repositoryAuthority?: FrozenRepositoryAuthority;
  repositoryEvidenceFreeze?: RepositoryEvidenceFreeze;
  claimedTaskClass?: TaskClass;
  metadata?: Record<string, unknown>;
  fingerprintVersion?: 'v2';
}): ReviewObligation {
  assertSubjectDigest(input.subjectDigest);
  assertRepositoryFreezeCoherence(input);
  requireArtifactSubjectScope(input.obligationType, input.reviewSubjectScope);
  const challengePolicy = input.policySnapshot?.challengePolicy ?? CHALLENGE_POLICY_V1;
  const resolvedChallengeRequirements = resolveChallengeRequirements(challengePolicy, input);
  const subjectDigest = resolveSubjectDigest(input);
  const reviewSubjectScope = resolveSubjectScope(
    subjectDigest,
    input.reviewSubjectScope,
    input.changedFiles,
  );
  requireImplementationSubjectScope(input.obligationType, subjectDigest, reviewSubjectScope);
  return {
    obligationId: randomUUID(),
    obligationType: input.obligationType,
    iteration: input.iteration,
    reviewCycle: input.reviewCycle,
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
    reviewProfile: input.reviewProfile ?? 'core',
    profileSource: input.profileSource ?? 'policy_default',
    ...resolvedChallengeRequirements,
    subjectDigest,
    ...(input.claimDeclarationsDigest
      ? { claimDeclarationsDigest: input.claimDeclarationsDigest }
      : {}),
    reviewMaterial: input.reviewMaterial,
    reviewSubject: input.reviewSubject,
    metadata: input.metadata,
    ...(input.fingerprintVersion ? { fingerprintVersion: input.fingerprintVersion } : {}),
    reviewSubjectScope,
    repositoryRevisionProvenance: deriveRepositoryRevisionProvenance({
      repositoryAuthority: input.repositoryAuthority,
    }),
    repositoryAuthority: input.repositoryAuthority,
    repositoryEvidenceFreeze: input.repositoryEvidenceFreeze,
    maxReviewerAttempts: resolveFrozenReviewerAttemptBudget(input.policySnapshot),
  };
}

/** Freeze review bytes with the canonical standalone-content normalization and digest. */
export function freezeReviewMaterial(content: string, subjectDigest: string): ReviewMaterial {
  const normalized = normalizeReviewContent(content);
  return {
    content: normalized,
    materialDigest: hashCanonicalReviewContent(normalized),
    subjectDigest,
  };
}

export function resolveFrozenReviewProfile(
  policySnapshot: { reviewProfile?: string } | null | undefined,
): ReviewProfile {
  const raw = policySnapshot?.reviewProfile;
  return raw === 'core' || raw === 'full' ? raw : 'core';
}

function resolveFrozenReviewerAttemptBudget(
  policySnapshot:
    | (Pick<PolicySnapshot, 'maxReviewerAttempts'> & {
        challengePolicy?: ChallengePolicy;
      })
    | null
    | undefined,
): number {
  return policySnapshot?.maxReviewerAttempts ?? DEFAULT_MAX_REVIEWER_ATTEMPTS;
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
  fingerprintVersion?: 'v2',
): ReviewObligation | null {
  const base = ensureReviewAssurance(assurance);
  const candidates = base.obligations.filter(
    (o) => o.obligationType === obligationType && o.status === 'pending',
  );
  if (metadataFingerprint) {
    return (
      candidates
        .filter(
          (o) =>
            o.metadata &&
            o.metadata.fingerprint === metadataFingerprint &&
            (fingerprintVersion === undefined || o.fingerprintVersion === fingerprintVersion),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .at(0) ?? null
    );
  }
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
        invocation.invocationMode === 'native_task_structured_followup' &&
        invocation.childSessionId === findings.reviewedBy.sessionId &&
        invocation.findingsHash === findingsHash &&
        invocation.consumedByObligationId === null,
    ) ?? null
  );
}

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
    ordinal,
    origin: { kind: 'initial' },
    repositoryDiscovery,
    observationCapability: mintObservationCapabilityIfResolvable(obligation),
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
    ordinal,
    origin: { kind: 'initial' },
    repositoryDiscovery,
    observationCapability: mintObservationCapabilityIfResolvable(obligation),
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

/** Build canonical invocation evidence for the one sanctioned review transport. */
export function buildInvocationEvidence(input: {
  obligationId: string;
  obligationType: ReviewObligationType;
  mandateDigest: string;
  criteriaVersion: string;
  parentSessionId: string;
  childSessionId: string;
  promptHash: string;
  canonicalPromptDigest?: string;
  modelPromptDigest?: string | null;
  findingsHash: string;
  invokedAt: string;
  fulfilledAt?: string;
  capturedRawFindings: Record<string, unknown>;
  resolvedBranchSha?: string | null;
  resolvedBaseSha?: string | null;
  reviewedContentDigest?: string | null;
  attemptId: string;
}): ReviewInvocationEvidence {
  const capturedVerdict = input.capturedRawFindings.overallVerdict;
  return {
    invocationId: randomUUID(),
    obligationId: input.obligationId,
    obligationType: input.obligationType,
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    agentType: REVIEWER_SUBAGENT_TYPE,
    invocationMode: 'native_task_structured_followup',
    hostVisible: true,
    transcriptNavigable: true,
    promptHash: input.promptHash,
    canonicalPromptDigest: input.canonicalPromptDigest,
    modelPromptDigest: input.modelPromptDigest,
    mandateDigest: input.mandateDigest,
    criteriaVersion: input.criteriaVersion,
    findingsHash: input.findingsHash,
    invokedAt: input.invokedAt,
    fulfilledAt: input.fulfilledAt ?? null,
    consumedByObligationId: null,
    capturedRawFindings: input.capturedRawFindings,
    ...(typeof capturedVerdict === 'string' ? { capturedVerdict } : {}),
    source: 'host-orchestrated',
    reviewOutputMode: 'structured_output',
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high',
    resolvedBranchSha: input.resolvedBranchSha ?? null,
    resolvedBaseSha: input.resolvedBaseSha ?? null,
    reviewedContentDigest: input.reviewedContentDigest ?? null,
    attemptId: input.attemptId,
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
