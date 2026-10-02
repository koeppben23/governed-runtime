/**
 * @module integration/review/subject-scope
 * @description Review subject scope resolution for obligation creation.
 *
 * Extracted from assurance.ts to keep the assurance SSOT within the
 * production file-size budget. These resolvers are internal to
 * `createReviewObligation`; the public surface stays re-exported from
 * assurance.ts.
 *
 * @version v1
 */

import type { ReviewSubjectScope } from '../../../state/evidence-review-subject.js';
import type { TaskClass } from '../../../state/task-class.js';
import { resolveEffectiveTaskClass } from '../../../state/risk-declaration.js';
import { assessMinimumTaskClass } from '../../phase-tool-gate.js';
import { challengeKindForObligation, type ChallengeKind } from '../../../config/policy-types.js';
import type { PolicySnapshot } from '../../../state/evidence.js';
import type { ReviewObligationType } from '../../../state/evidence.js';
import { IntegrationInvariantError } from '../../errors.js';

/**
 * Pre-implementation artifact reviews (plan, ADR) MUST mint an explicit
 * artifact subject scope. changedFiles, targetPaths, and discovery risk
 * surfaces are challenge classification and repository evidence context —
 * they must never become the primary subject authority of an artifact review.
 */
export function requireArtifactSubjectScope(
  obligationType: ReviewObligationType,
  reviewSubjectScope: ReviewSubjectScope | undefined,
): void {
  if (
    (obligationType === 'plan' || obligationType === 'architecture') &&
    reviewSubjectScope?.kind !== 'artifact'
  ) {
    throw new IntegrationInvariantError(
      'REVIEW_ARTIFACT_SCOPE_REQUIRED',
      'FAIL_CLOSED: plan/architecture review obligations require an explicit artifact ' +
        'reviewSubjectScope.',
    );
  }
}

/**
 * Implementation reviews (implement) MUST mint an explicit implementation
 * subject scope bound to the exact obligation subject digest. changedFiles,
 * targetPaths, and discovery risk surfaces are challenge classification and
 * repository evidence context — they must never become the primary subject
 * authority of an implementation review. Divergence is fail-closed: a
 * repository_change scope (or a digest mismatch) would mint a structurally
 * unsatisfiable reviewer contract.
 */
export function requireImplementationSubjectScope(
  obligationType: ReviewObligationType,
  subjectDigest: string,
  reviewSubjectScope: ReviewSubjectScope | undefined,
): void {
  if (obligationType !== 'implement') return;
  if (reviewSubjectScope?.kind !== 'implementation') {
    throw new IntegrationInvariantError(
      'REVIEW_IMPLEMENTATION_SCOPE_REQUIRED',
      'FAIL_CLOSED: implement review obligations require an explicit implementation ' +
        'reviewSubjectScope bound to the implementation subject digest.',
    );
  }
  if (reviewSubjectScope.implementationDigest !== subjectDigest) {
    throw new IntegrationInvariantError(
      'REVIEW_SUBJECT_DIGEST_MISMATCH',
      'FAIL_CLOSED: implementation reviewSubjectScope digest does not match the ' +
        'obligation subject digest.',
    );
  }
}

export const defaultScope = (changedFiles: readonly string[] | undefined): ReviewSubjectScope =>
  changedFiles && changedFiles.length > 0
    ? { kind: 'repository_change', paths: [...changedFiles], revisions: ['head'] }
    : { kind: 'unavailable', reason: 'scope_not_resolved' };

export function resolveSubjectScope(
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

/**
 * Frozen challenge coverage requirements: the fail-closed FLOOR derives from
 * the central effective task-class resolution
 * `max(computedFromChangedFiles, ticketDeclared, escalated)` so a high-risk
 * change cannot collapse the requirement to 0 by declaring doc-only target
 * paths, and a ticket-declared minimum cannot be undercut.
 * Empty when no challenge policy is frozen on the obligation.
 */
export function resolveChallengeRequirements(
  challengePolicy: Pick<PolicySnapshot, 'challengePolicy'>['challengePolicy'],
  input: {
    obligationType: ReviewObligationType;
    changedFiles?: readonly string[];
    declaredTaskClass?: TaskClass | null;
    escalatedTaskClass?: TaskClass;
    provisionalScopeUnknown?: boolean;
  },
): {
  requiredChallengeCount: number;
  requiredChallengeKind: ChallengeKind;
  challengePolicyVersion: 'challenge-policy.v1';
} {
  // Hard Assurance Epoch: the persisted policy snapshot requires
  // challengePolicy, and the obligation freezes the requirement explicitly.
  // TRIVIAL is the explicit zero — never an implicit no-policy state.
  const declaredTaskClass = input.declaredTaskClass ?? null;
  const computed = assessMinimumTaskClass(input.changedFiles ?? []).minimumTaskClass;
  const effectiveTaskClass = resolveEffectiveTaskClass({
    // An unresolved pre-implementation scope is floored at STANDARD: absence of
    // target evidence is not evidence of a trivial change.
    computed:
      input.provisionalScopeUnknown === true && computed === 'TRIVIAL' ? 'STANDARD' : computed,
    declaration:
      declaredTaskClass === null
        ? { kind: 'absent' }
        : { kind: 'declared', taskClass: declaredTaskClass },
    escalated: input.escalatedTaskClass,
  });
  return {
    requiredChallengeCount: challengePolicy.counts[effectiveTaskClass],
    requiredChallengeKind: challengeKindForObligation(input.obligationType),
    challengePolicyVersion: challengePolicy.version,
  };
}
