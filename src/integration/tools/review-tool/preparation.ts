/** Deterministic standalone-review task preparation and append-only evidence. */

import { randomUUID } from 'node:crypto';

import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';
import {
  createStandaloneReviewTask,
  type StandaloneReviewCompletedEvidence,
  type StandaloneReviewEvidence,
  type StandaloneReviewPreparedEvidence,
  reviewFindingsDigests,
} from '../../../state/standalone-review.js';
import type { ReviewFindings } from '../../../state/evidence.js';
import type { ReviewToolArgs } from './types.js';

function subjectDigest(args: ReviewToolArgs): string {
  // Subject input is digest-bound review evidence; it is not a claim authority.
  return hashText(
    canonicalJsonStringify({
      inputOrigin: args.inputOrigin,
      references: args.references,
      text: args.text,
      prNumber: args.prNumber,
      branch: args.branch,
      base: args.base,
      url: args.url,
    }),
  );
}

export function prepareStandaloneReviewEvidence(
  args: ReviewToolArgs,
  preparedAt: string,
): StandaloneReviewPreparedEvidence {
  const { task, requestedDigests } = createStandaloneReviewTask({
    subjectDigest: subjectDigest(args),
    objectives: args.objectives,
  });
  return { kind: 'prepared', evidenceId: randomUUID(), preparedAt, task, requestedDigests };
}

export function appendPreparedReviewEvidence(
  evidence: readonly StandaloneReviewEvidence[],
  prepared: StandaloneReviewPreparedEvidence,
): StandaloneReviewEvidence[] {
  if (
    evidence.some(
      (entry) =>
        entry.kind === 'prepared' &&
        entry.requestedDigests.taskDigest === prepared.requestedDigests.taskDigest,
    )
  ) {
    return [...evidence];
  }
  return [...evidence, prepared];
}

export function appendCompletedReviewEvidence(input: {
  readonly evidence: readonly StandaloneReviewEvidence[];
  readonly prepared: StandaloneReviewPreparedEvidence;
  readonly completedAt: string;
  readonly findings?: ReviewFindings;
}): StandaloneReviewEvidence[] {
  const { evidence, prepared, completedAt, findings } = input;
  const existingPrepared = evidence.find(
    (entry): entry is StandaloneReviewPreparedEvidence =>
      entry.kind === 'prepared' &&
      entry.requestedDigests.taskDigest === prepared.requestedDigests.taskDigest,
  );
  const boundPrepared = existingPrepared ?? prepared;
  const { findingsDigest, attestationDigest } = reviewFindingsDigests(findings);
  const completed: StandaloneReviewCompletedEvidence = {
    kind: 'completed',
    evidenceId: randomUUID(),
    completedAt,
    preparedEvidenceId: boundPrepared.evidenceId,
    task: boundPrepared.task,
    requestedDigests: boundPrepared.requestedDigests,
    findingsDigest,
    attestationDigest,
  };
  return existingPrepared ? [...evidence, completed] : [...evidence, boundPrepared, completed];
}
