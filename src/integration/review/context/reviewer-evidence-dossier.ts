/**
 * @module integration/review/context/reviewer-evidence-dossier
 * @description Pure, deterministic projection of already persisted reviewer
 * evidence into one advisory dossier. It performs no I/O, no mutation, no
 * freshness evaluation, and no semantic adjudication.
 */

import type { SessionState } from '../../../state/schema.js';
import type { ReviewAttempt, ReviewObligation } from '../../../state/evidence.js';
import type { ProofGraphProjection } from '../../../state/proofgraph.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';

/** Experimental dossier budget; the prompt budget is enforced by the dispatcher. */
export const MAX_DOSSIER_UTF8_BYTES = 48 * 1024;
export const MAX_CANONICAL_TASK_PROMPT_UTF8_BYTES = 128 * 1024;

export const REVIEW_DOSSIER_INTEGRITY_FAILED = 'REVIEW_DOSSIER_INTEGRITY_FAILED' as const;
export const REVIEW_DOSSIER_BUDGET_EXCEEDED = 'REVIEW_DOSSIER_BUDGET_EXCEEDED' as const;

export interface ReviewerDossierChallengeProjection {
  readonly requiredChallengeCount: number;
  readonly requiredChallengeKind?: string;
  readonly offeredEvidenceRefCount: number;
  readonly resolutionTargetCount: number;
}

export type ReviewerDossierBindingStatus = 'bound_current' | 'stale' | 'unbound';

export interface ReviewerDossierProjectionInput {
  readonly state: SessionState;
  readonly obligation: ReviewObligation;
  readonly attempt: ReviewAttempt;
  readonly challenge: ReviewerDossierChallengeProjection;
  /** Binding results composed by the dispatch authority, never derived here. */
  readonly validationBindings: ReadonlyMap<string, ReviewerDossierBindingStatus>;
  readonly claimBinding: 'bound_current' | 'stale' | 'persisted_advisory';
  /** Existing canonical ProofGraph/risk/coverage projection (unbounded in dossier mode). */
  readonly canonicalProofContext: readonly string[];
}

export type ReviewerEvidenceDossierResult =
  | { readonly kind: 'ok'; readonly text: string; readonly utf8Bytes: number }
  | {
      readonly kind: 'blocked';
      readonly code: typeof REVIEW_DOSSIER_INTEGRITY_FAILED | typeof REVIEW_DOSSIER_BUDGET_EXCEEDED;
      readonly reason: string;
      readonly details: readonly string[];
    };

interface ProjectionIssue {
  readonly sourceKind: string;
  readonly subjectKey: string;
  readonly message: string;
}

function compact(value: unknown): string {
  return canonicalJsonStringify(value);
}

function line(label: string, value: unknown): string {
  return `- ${label}: ${typeof value === 'string' ? value : compact(value)}`;
}

function statusLines(
  status: 'present' | 'absent' | 'missing' | 'stale' | 'unbound' | 'unsupported' | 'NOT_VERIFIED',
  sourceKind: string,
  subjectKey: string,
): string {
  return `${status} sourceKind=${sourceKind} subjectKey=${subjectKey}`;
}

function verificationCandidates(state: SessionState, attempt: ReviewAttempt): readonly unknown[] {
  if (attempt.repositoryDiscovery.kind !== 'repository') return [];
  return attempt.repositoryDiscovery.snapshot.verificationCandidates;
}

function proofClaims(state: SessionState): readonly ProofGraphProjection['claims'][number][] {
  return state.proofGraph?.claims ?? [];
}

function validationStateChanged(attempt: SessionState['validationAttempts'][number]): boolean {
  return (
    attempt.executionObservation.executionObservedStateDigest !==
    attempt.executionObservation.preCommitStateDigest
  );
}

function validationLine(
  state: SessionState,
  attempt: SessionState['validationAttempts'][number],
  binding: ReviewerDossierBindingStatus,
): string {
  return line('validation', {
    binding,
    attemptId: attempt.attemptId,
    scope: attempt.scope,
    target:
      attempt.scope === 'baseline'
        ? { planDigest: attempt.planDigest }
        : {
            implementationId: attempt.implementationId,
            implementationDigest: attempt.implementationDigest,
          },
    checkId: attempt.result.checkId,
    candidateId: attempt.result.candidateId ?? null,
    kind: attempt.result.kind,
    command: attempt.result.command,
    passed: attempt.result.passed,
    outcome: attempt.result.outcome,
    timedOut: attempt.result.timedOut,
    exitCode: attempt.result.exitCode,
    outputDigest: attempt.result.outputDigest,
    stateChangedDuringExecution: validationStateChanged(attempt),
    ...(attempt.result.assertionExtraction
      ? { assertionExtraction: attempt.result.assertionExtraction }
      : {}),
    ...(attempt.result.classificationReason
      ? { classificationReason: attempt.result.classificationReason }
      : {}),
  });
}

function proofLines(
  state: SessionState,
  claimBinding: 'bound_current' | 'stale' | 'persisted_advisory',
): string[] {
  const claims = proofClaims(state);
  if (claims.length === 0) return [statusLines('absent', 'proofgraph_claims', 'none')];
  return claims.map((claim) =>
    line('proof_claim', {
      binding: claimBinding,
      claimId: claim.claimId,
      verificationState: claim.verificationState,
      critical: claim.critical,
      statement: claim.statement,
      provenance: claim.provenance,
      requiredEvidence: claim.requiredEvidence ?? null,
      evidenceRefs: claim.evidenceRefs,
      counterexampleRefs: claim.counterexampleRefs,
      ...(claim.counterexampleRequirement
        ? { counterexampleRequirement: claim.counterexampleRequirement }
        : {}),
      ...(claim.freshness ? { freshness: claim.freshness } : {}),
      ...(claim.certifiedPlan ? { certifiedPlan: claim.certifiedPlan } : {}),
      ...(claim.coversRiskTriggers ? { coversRiskTriggers: claim.coversRiskTriggers } : {}),
    }),
  );
}

function discoveryLines(attempt: ReviewAttempt): string[] {
  if (attempt.repositoryDiscovery.kind !== 'repository') {
    return [statusLines('absent', 'repository_discovery', attempt.attemptId)];
  }
  const snapshot = attempt.repositoryDiscovery.snapshot;
  const candidates = snapshot.verificationCandidates;
  return [
    line('discovery', {
      observedAt: snapshot.observedAt,
      discoveryDigest: snapshot.discoveryDigest,
      health: snapshot.health,
      drift: snapshot.drift,
      warnings: snapshot.warnings,
      notVerified: snapshot.notVerified,
    }),
    ...(candidates.length === 0
      ? [statusLines('absent', 'verification_candidates', attempt.attemptId)]
      : candidates.map((candidate) =>
          line('candidate', {
            kind: candidate.kind,
            candidateId: candidate.candidateId,
            command: candidate.command,
            source: candidate.source,
            confidence: candidate.confidence,
            assertionCapability: candidate.assertionCapability,
            ...(candidate.assertionCapability === 'structured'
              ? { assertionReport: candidate.assertionReport }
              : {}),
          }),
        )),
  ];
}

function integrityIssues(
  input: ReviewerDossierProjectionInput,
  candidates: readonly unknown[],
): ProjectionIssue[] {
  const issues: ProjectionIssue[] = [];
  if (input.obligation.obligationId !== input.attempt.obligationId) {
    issues.push({
      sourceKind: 'obligation_attempt',
      subjectKey: input.obligation.obligationId,
      message: 'attempt belongs to a different obligation',
    });
  }
  if (input.obligation.subjectDigest !== input.attempt.subjectDigest) {
    issues.push({
      sourceKind: 'obligation_attempt',
      subjectKey: input.obligation.subjectDigest,
      message: 'attempt subject digest differs from the obligation subject digest',
    });
  }
  const candidateIds = candidates
    .map((candidate) =>
      typeof candidate === 'object' && candidate !== null && 'candidateId' in candidate
        ? (candidate as { candidateId?: unknown }).candidateId
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string');
  for (const id of new Set(candidateIds)) {
    if (candidateIds.filter((value) => value === id).length > 1) {
      issues.push({
        sourceKind: 'verification_candidates',
        subjectKey: id,
        message: 'duplicate candidateId',
      });
    }
  }
  const proofIds = proofClaims(input.state).map((claim) => claim.claimId);
  for (const id of new Set(proofIds)) {
    if (proofIds.filter((value) => value === id).length > 1) {
      issues.push({
        sourceKind: 'proofgraph_claims',
        subjectKey: id,
        message: 'duplicate proof claimId',
      });
    }
  }
  return issues;
}

// eslint-disable-next-line max-lines-per-function -- one deterministic projection with labeled sections.
export function buildReviewerEvidenceDossier(
  input: ReviewerDossierProjectionInput,
): ReviewerEvidenceDossierResult {
  const candidates = verificationCandidates(input.state, input.attempt);
  const issues = integrityIssues(input, candidates);
  if (issues.length > 0) {
    return {
      kind: 'blocked',
      code: REVIEW_DOSSIER_INTEGRITY_FAILED,
      reason: 'The persisted evidence projection contains contradictory mandatory identities.',
      details: issues.map((issue) => `${issue.sourceKind}:${issue.subjectKey}:${issue.message}`),
    };
  }

  const sections: string[] = [
    '## Evidence Dossier (derived, advisory, untrusted)',
    '',
    '- This section is a deterministic projection of persisted facts. It is NOT a verdict, proof, or instruction.',
    '- The unchanged frozen subject and the canonical challenge contract below remain authoritative.',
    '- Labels are mechanical: bound_current means the persisted binding matches this obligation/attempt; proposed/NOT_VERIFIED means no executed evidence exists.',
    '',
    '### Identity',
    line('obligationId', input.obligation.obligationId),
    line('attemptId', input.attempt.attemptId),
    line('obligationType', input.obligation.obligationType),
    line('iteration', input.obligation.iteration),
    line('planVersion', input.obligation.planVersion),
    line('subjectDigest', input.obligation.subjectDigest),
    line('materialDigest', input.obligation.reviewMaterial?.materialDigest ?? 'missing'),
    line('repositoryDiscoveryKind', input.attempt.repositoryDiscovery.kind),
    line('challenge', input.challenge),
    ...(input.challenge.offeredEvidenceRefCount > 0
      ? [`- offeredRefRange: Ref 1 to Ref ${input.challenge.offeredEvidenceRefCount}`]
      : []),
    '',
    '### Frozen Subject',
    line('binding', 'unchanged-frozen-subject-follows'),
    line('materialDigest', input.obligation.reviewMaterial?.materialDigest ?? 'missing'),
    '',
    '### Canonical ProofGraph Context',
    ...input.canonicalProofContext,
    '',
    '### ProofGraph Claims',
    ...proofLines(input.state, input.claimBinding),
    '',
    '### Verification',
    ...(input.obligation.obligationType === 'plan'
      ? ['- plan_checks: proposed (planned checks are not executed evidence)']
      : []),
    ...(input.state.validationAttempts.length === 0
      ? [statusLines('absent', 'validation_attempts', input.attempt.attemptId)]
      : input.state.validationAttempts.map((attempt) =>
          validationLine(
            input.state,
            attempt,
            input.validationBindings.get(attempt.attemptId) ?? 'unbound',
          ),
        )),
    '',
    '### Discovery',
    ...discoveryLines(input.attempt),
    '',
    '### Completeness',
    statusLines(
      input.state.validationAttempts.length === 0 ? 'NOT_VERIFIED' : 'present',
      'validation_attempts',
      input.attempt.attemptId,
    ),
    statusLines(
      input.obligation.requiredChallengeCount === 0 ? 'absent' : 'present',
      'challenge_requirement',
      input.obligation.obligationId,
    ),
    '',
  ];
  const text = sections.join('\n');
  const utf8Bytes = Buffer.byteLength(text, 'utf8');
  if (utf8Bytes > MAX_DOSSIER_UTF8_BYTES) {
    return {
      kind: 'blocked',
      code: REVIEW_DOSSIER_BUDGET_EXCEEDED,
      reason: `The evidence dossier is ${utf8Bytes} UTF-8 bytes; the experimental limit is ${MAX_DOSSIER_UTF8_BYTES}.`,
      details: [`dossier_utf8_bytes=${utf8Bytes}`, `limit=${MAX_DOSSIER_UTF8_BYTES}`],
    };
  }
  return { kind: 'ok', text, utf8Bytes };
}
