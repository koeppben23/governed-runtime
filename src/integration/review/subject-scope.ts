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
