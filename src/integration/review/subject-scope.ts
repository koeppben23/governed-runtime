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

import type { ReviewSubjectScope } from '../../state/evidence-review.js';
import type { TaskClass } from '../../state/schema.js';
import { assessMinimumTaskClass, maxTaskClass } from '../phase-tool-gate.js';
import { challengeKindForObligation } from '../../config/policy-types.js';
import type { PolicySnapshot } from '../../state/evidence.js';
import type { ReviewObligationType } from '../../state/evidence.js';

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
    throw new Error(
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
    throw new Error(
      'FAIL_CLOSED: implement review obligations require an explicit implementation ' +
        'reviewSubjectScope bound to the implementation subject digest.',
    );
  }
  if (reviewSubjectScope.implementationDigest !== subjectDigest) {
    throw new Error(
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
 * `max(computedFromChangedFiles, claimedTaskClass)` so a high-risk change
 * cannot collapse the requirement to 0 by declaring doc-only target paths.
 * Empty when no challenge policy is frozen on the obligation.
 */
export function resolveChallengeRequirements(
  challengePolicy: Pick<PolicySnapshot, 'challengePolicy'>['challengePolicy'] | undefined,
  input: {
    obligationType: ReviewObligationType;
    changedFiles?: readonly string[];
    claimedTaskClass?: TaskClass;
  },
): Record<string, unknown> {
  if (!challengePolicy) return {};
  return {
    requiredChallengeCount:
      challengePolicy.counts[
        maxTaskClass(
          assessMinimumTaskClass(input.changedFiles ?? []).minimumTaskClass,
          input.claimedTaskClass ?? 'TRIVIAL',
        )
      ],
    requiredChallengeKind: challengeKindForObligation(input.obligationType),
    challengePolicyVersion: challengePolicy.version,
  };
}
