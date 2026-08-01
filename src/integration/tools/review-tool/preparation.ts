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
import type { ReviewReferenceInput } from '../../../rails/review.js';

function subjectDigest(args: ReviewToolArgs, refInput?: ReviewReferenceInput): string {
  // Subject input is digest-bound review evidence; it is not a claim authority.
  return hashText(
    canonicalJsonStringify({
      inputOrigin: args.inputOrigin,
      references: args.references,
      text: args.text,
      prNumber: args.prNumber,
      branch: args.branch,
      base: args.base,
      // A branch name is mutable. Bind the standalone task to the immutable
      // resolved commits captured by its review obligation when available.
      resolvedBranchSha: refInput?.resolvedBranchSha,
      resolvedBaseSha: refInput?.resolvedBaseSha,
      url: args.url,
    }),
  );
}

export function prepareStandaloneReviewEvidence(
  args: ReviewToolArgs,
  preparedAt: string,
  refInput?: ReviewReferenceInput,
): StandaloneReviewPreparedEvidence {
  const { task, requestedDigests } = createStandaloneReviewTask({
    subjectDigest: subjectDigest(args, refInput),
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

/**
 * Resolve the prepared entry still awaiting completion.
 *
 * The subject digest can legitimately change between preparation and completion
 * (a branch name resolves to an immutable SHA only once the obligation exists),
 * which makes the recomputed `taskDigest` a non-identity. Binding on it appended
 * a second prepared+completed pair and duplicated every hypothesis claim in the
 * ProofGraph projection (#762).
 */
function pendingPreparedEvidence(
  evidence: readonly StandaloneReviewEvidence[],
): StandaloneReviewPreparedEvidence | undefined {
  const completedPreparedIds = new Set(
    evidence.filter((entry) => entry.kind === 'completed').map((entry) => entry.preparedEvidenceId),
  );
  return evidence
    .filter(
      (entry): entry is StandaloneReviewPreparedEvidence =>
        entry.kind === 'prepared' && !completedPreparedIds.has(entry.evidenceId),
    )
    .at(-1);
}

export function appendCompletedReviewEvidence(input: {
  readonly evidence: readonly StandaloneReviewEvidence[];
  readonly prepared: StandaloneReviewPreparedEvidence;
  readonly completedAt: string;
  readonly findings?: ReviewFindings;
}): StandaloneReviewEvidence[] {
  const { evidence, prepared, completedAt, findings } = input;
  const exactPrepared = evidence.find(
    (entry): entry is StandaloneReviewPreparedEvidence =>
      entry.kind === 'prepared' &&
      entry.requestedDigests.taskDigest === prepared.requestedDigests.taskDigest,
  );
  // Exact digest match first (unchanged subject); otherwise bind the outstanding
  // prepared entry so a resolved branch SHA cannot fork the evidence chain.
  const existingPrepared = exactPrepared ?? pendingPreparedEvidence(evidence);
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
