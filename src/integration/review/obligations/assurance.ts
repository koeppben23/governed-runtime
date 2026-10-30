/**
 * @module integration/review/obligations/assurance
 * @description SSOT helpers for strict independent-review obligations and evidence.
 */

import { randomUUID } from 'node:crypto';
import { hashText } from '../../../shared/hashing.js';
import { IntegrationInvariantError } from '../../errors.js';
import { hashFindings } from '../findings-hash.js';

import type {
  ReviewAssuranceState,
  ReviewFindings,
  ReviewInvocationEvidence,
  ReviewObligation,
  ReviewObligationType,
  PolicySnapshot,
  ReviewAttempt,
  ReviewAttemptDiscoveryContext,
  ReviewMaterial,
  FrozenReviewSubject,
  FrozenRepositoryAuthority,
} from '../../../state/evidence.js';
import {
  hashCanonicalReviewContent,
  normalizeReviewContent,
} from '../../../shared/review-subject.js';
import { deriveRepositoryRevisionProvenance } from '../../../state/evidence.js';
import { indexMarkdownSections } from '../../../shared/markdown-sections.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import {
  DEFAULT_MAX_REVIEWER_ATTEMPTS,
  CHALLENGE_POLICY_V1,
  type ChallengePolicy,
} from '../../../config/policy-types.js';
import type { TaskClass } from '../../../state/task-class.js';
import type { ReviewSubjectScope } from '../../../state/evidence-review-subject.js';
import type { RepositoryEvidenceFreeze } from '../../../state/evidence-review-freeze.js';
import { assertRepositoryFreezeCoherence } from './freeze-coherence.js';
// Static import - mandate content is a constant in ESM
import { REVIEWER_AGENT } from '../../../templates/mandates.js';
// #1081: the implementation criteria were expanded to the risk-adaptive
// quality checklist and blocking-finding contract. Any semantic criteria change
// advances this generation; stale obligations fail closed instead of silently
// reviewing under unstated semantics.
// p42-v3: plan-review verification authority (persisted verification candidates,
// executable candidate command) and plan-before-validation phase boundary.
// p42-v7: compact output contract (Ref-number citation, settled points); criteria unchanged.
// p42-v6: counterexample sufficiency — a counterexample must be a targeted
// falsification (concrete violating variant detected by the bound check), not a
// second green execution; different check/attempt identities stay required,
// assertion-identity inequality is not.
// p42-v5: implementation challenges separate execution evidence (current-digest
// validation attempt) from content evidence (current implementation ref); a
// passing challenge requires both. Finding-relation grammar scope + retry
// ordering corrections ride the same criteria generation.
// p42-v4: plan evidence-role rule stated once in the criteria (overlapping
// suites of different checks are admissible) and the plan blocking-issue bar.
export const REVIEW_CRITERIA_VERSION = 'p42-v7';
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
  artifactReviewSubjectScopeFromSections,
  resolveSubjectScope,
  resolveChallengeRequirements,
  requireArtifactSubjectScope,
  requireImplementationSubjectScope,
} from '../context/subject-scope.js';

function resolveSubjectDigest(input: {
  subjectDigest: string;
  reviewSubject?: FrozenReviewSubject | undefined;
}): string {
  return input.reviewSubject?.subjectDigest ?? input.subjectDigest;
}

/**
 * Mint an artifact subject scope from a standalone artifact markdown document.
 * Use only where the document itself is the complete review subject; plan and
 * ADR obligations must use {@link artifactReviewSubjectScopeFromSections}
 * with the paths derived from the frozen material.
 */
export function artifactReviewSubjectScope(
  kind: 'plan' | 'adr',
  markdown: string,
  digest: string,
): ReviewSubjectScope {
  return artifactReviewSubjectScopeFromSections(
    kind,
    indexMarkdownSections(markdown).map((section) => section.sectionPath),
    digest,
  );
}

import { ensureReviewAssurance, isOpenReviewObligation } from '../../../state/review-dispatch.js';
import {
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
function assertSubjectDigest(subjectDigest: string): void {
  if (!subjectDigest || subjectDigest.length === 0) {
    throw new IntegrationInvariantError(
      'REVIEW_SUBJECT_DIGEST_MISSING',
      'FAIL_CLOSED: createReviewObligation requires a non-empty subjectDigest. ' +
        'Obligations without an authoritative subject identity cannot produce bindable evidence.',
    );
  }
}

function assertObligationFreezeCoherence(input: {
  obligationType: ReviewObligationType;
  repositoryAuthority?: FrozenRepositoryAuthority | undefined;
  repositoryEvidenceFreeze?: RepositoryEvidenceFreeze | undefined;
}): void {
  assertRepositoryFreezeCoherence({
    obligationType: input.obligationType,
    ...(input.repositoryAuthority !== undefined
      ? { repositoryAuthority: input.repositoryAuthority }
      : {}),
    ...(input.repositoryEvidenceFreeze !== undefined
      ? { repositoryEvidenceFreeze: input.repositoryEvidenceFreeze }
      : {}),
  });
}

function resolveFrozenChallengeRequirements(
  challengePolicy: Pick<PolicySnapshot, 'challengePolicy'>['challengePolicy'],
  input: {
    obligationType: ReviewObligationType;
    changedFiles?: readonly string[] | undefined;
    declaredTaskClass?: TaskClass | null | undefined;
    escalatedTaskClass?: TaskClass | undefined;
    provisionalScopeUnknown?: boolean | undefined;
    policySnapshot?: { riskTriggerPaths?: PolicySnapshot['riskTriggerPaths'] } | null | undefined;
  },
): ReturnType<typeof resolveChallengeRequirements> {
  return resolveChallengeRequirements(challengePolicy, {
    obligationType: input.obligationType,
    ...(input.policySnapshot?.riskTriggerPaths !== undefined
      ? { riskTriggerPaths: input.policySnapshot.riskTriggerPaths }
      : {}),
    ...(input.changedFiles !== undefined ? { changedFiles: input.changedFiles } : {}),
    ...(input.declaredTaskClass !== undefined
      ? { declaredTaskClass: input.declaredTaskClass }
      : {}),
    ...(input.escalatedTaskClass !== undefined
      ? { escalatedTaskClass: input.escalatedTaskClass }
      : {}),
    ...(input.provisionalScopeUnknown !== undefined
      ? { provisionalScopeUnknown: input.provisionalScopeUnknown }
      : {}),
  });
}

export function createReviewObligation(input: {
  obligationType: ReviewObligationType;
  iteration: number;
  reviewCycle: number | null;
  planVersion: number;
  now: string;
  subjectDigest: string;
  claimDeclarationsDigest?: string | undefined;
  reviewSubject?: FrozenReviewSubject | undefined;
  reviewMaterial: ReviewMaterial;
  policySnapshot?:
    | (Pick<PolicySnapshot, 'maxReviewerAttempts'> & {
        challengePolicy?: ChallengePolicy;
        riskTriggerPaths?: PolicySnapshot['riskTriggerPaths'];
      })
    | null
    | undefined;
  changedFiles?: readonly string[] | undefined;
  reviewSubjectScope?: ReviewSubjectScope | undefined;
  repositoryAuthority?: FrozenRepositoryAuthority | undefined;
  repositoryEvidenceFreeze?: RepositoryEvidenceFreeze | undefined;
  declaredTaskClass?: TaskClass | null | undefined;
  escalatedTaskClass?: TaskClass | undefined;
  provisionalScopeUnknown?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
  fingerprintVersion?: 'v2' | undefined;
}): ReviewObligation {
  assertSubjectDigest(input.subjectDigest);
  assertObligationFreezeCoherence(input);
  requireArtifactSubjectScope(input.obligationType, input.reviewSubjectScope);
  const challengePolicy = input.policySnapshot?.challengePolicy ?? CHALLENGE_POLICY_V1;
  const resolvedChallengeRequirements = resolveFrozenChallengeRequirements(challengePolicy, input);
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

export function findLatestOpenObligation(
  assurance: ReviewAssuranceState | undefined,
  obligationType: ReviewObligationType,
): ReviewObligation | null {
  const base = ensureReviewAssurance(assurance);
  return (
    base.obligations
      .filter((o) => o.obligationType === obligationType && isOpenReviewObligation(o))
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
        invocation.invocationMode === 'native_task_message_json' &&
        invocation.childSessionId === findings.reviewedBy.sessionId &&
        invocation.findingsHash === findingsHash &&
        invocation.consumedByObligationId === null,
    ) ?? null
  );
}

function appendObligationAndInitialAttempt(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation,
  now: string,
  repositoryDiscovery: ReviewAttemptDiscoveryContext,
): { assurance: ReviewAssuranceState; obligation: ReviewObligation; attempt: ReviewAttempt } {
  const ordinal =
    (ensureReviewAssurance(assurance).attempts?.filter(
      (a) => a.obligationId === obligation.obligationId,
    ).length ?? 0) + 1;
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

export function createObligationAndAttempt(
  assurance: ReviewAssuranceState | undefined,
  obligationInput: Parameters<typeof createReviewObligation>[0],
  now: string,
  repositoryDiscovery: ReviewAttemptDiscoveryContext = { kind: 'not_applicable' },
): { assurance: ReviewAssuranceState; obligation: ReviewObligation; attempt: ReviewAttempt } {
  return appendObligationAndInitialAttempt(
    assurance,
    createReviewObligation(obligationInput),
    now,
    repositoryDiscovery,
  );
}

export function appendObligationWithAttempt(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation,
  now: string,
  repositoryDiscovery: ReviewAttemptDiscoveryContext = { kind: 'not_applicable' },
): { assurance: ReviewAssuranceState; attemptId: string } {
  const result = appendObligationAndInitialAttempt(assurance, obligation, now, repositoryDiscovery);
  return {
    assurance: result.assurance,
    attemptId: result.attempt.attemptId,
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
  capture: ReviewInvocationEvidence['capture'];
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
    // One native child; exact message provenance and FlowGuard-validated JSON.
    invocationMode: 'native_task_message_json',
    transportVersion: 5,
    capture: input.capture,
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
    reviewOutputMode: 'validated_json',
    reviewAssuranceLevel: 'host_message_validated',
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
  if (!obligation) {
    throw new IntegrationInvariantError(
      'REVIEW_OBLIGATION_NOT_FOUND',
      `Review obligation not found: ${obligationId}`,
    );
  }
  if (obligation.status !== 'pending') {
    if (obligation.status === 'fulfilled' && obligation.invocationId === invocationId) return base;
    throw new IntegrationInvariantError(
      'REVIEW_OBLIGATION_STATUS_INVALID',
      `Cannot fulfill review obligation in status ${obligation.status}`,
    );
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

/**
 * Deterministically close a pending review obligation as blocked by bound
 * reviewer evidence that cannot carry a verdict (`unable_to_review`).
 *
 * The invocation reference is retained so the failure stays auditable: the
 * evidence was recorded, but it can never be consumed as an approval and the
 * obligation cannot be repaired by submitting a verdict. Recovery is flow
 * specific — an artifact flow submits a fresh revision, which mints a new
 * obligation.
 */
export function blockObligationWithInvocation(
  assurance: ReviewAssuranceState,
  obligationId: string,
  invocationId: string,
  blockedCode: string,
  now: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  const obligation = base.obligations.find((item) => item.obligationId === obligationId);
  if (!obligation) {
    throw new IntegrationInvariantError(
      'REVIEW_OBLIGATION_NOT_FOUND',
      `Review obligation not found: ${obligationId}`,
    );
  }
  if (obligation.status !== 'pending') {
    if (
      obligation.status === 'blocked' &&
      obligation.blockedCode === blockedCode &&
      obligation.invocationId === invocationId
    ) {
      return base;
    }
    throw new IntegrationInvariantError(
      'REVIEW_OBLIGATION_STATUS_INVALID',
      `Cannot block review obligation in status ${obligation.status}`,
    );
  }
  return {
    ...base,
    obligations: base.obligations.map((item) =>
      item.obligationId !== obligationId
        ? item
        : {
            ...item,
            status: 'blocked' as const,
            blockedCode,
            invocationId,
            fulfilledAt: now,
          },
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
