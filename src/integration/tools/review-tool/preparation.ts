/** Deterministic standalone-review task preparation and append-only evidence. */

import { randomUUID } from 'node:crypto';

import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';
import {
  STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
  createStandaloneReviewTask,
  type StandaloneReviewCompletedEvidence,
  type StandaloneReviewEvidence,
  type StandaloneReviewPreparedEvidence,
  type StandaloneReviewSupersededEvidence,
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

/**
 * The stable lifecycle identity of the standalone review operation for an
 * obligation. `reviewTaskId` is minted ONCE for the logical review operation
 * and survives subject freeze re-preparation, output repair, and verdict
 * continuation. It is deliberately NOT derived from any digest.
 */
export function resolveReviewTaskIdentity(
  evidence: readonly StandaloneReviewEvidence[],
  obligationId: string,
): { reviewTaskId: string } {
  const existing = evidence.find((entry) => entry.obligationId === obligationId);
  return { reviewTaskId: existing?.reviewTaskId ?? randomUUID() };
}

export function prepareStandaloneReviewEvidence(
  args: ReviewToolArgs,
  preparedAt: string,
  refInput: ReviewReferenceInput | undefined,
  reviewTaskId: string,
  obligationId: string,
): StandaloneReviewPreparedEvidence {
  const { task, requestedDigests } = createStandaloneReviewTask({
    subjectDigest: subjectDigest(args, refInput),
    objectives: args.objectives,
  });
  return {
    kind: 'prepared',
    schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
    evidenceId: randomUUID(),
    reviewTaskId,
    obligationId,
    preparedAt,
    task,
    requestedDigests,
  };
}

/**
 * Supersession marker between two prepared incarnations of the SAME logical
 * review operation (`reviewTaskId`).
 */
function supersessionMarker(
  superseded: StandaloneReviewPreparedEvidence,
  replacement: StandaloneReviewPreparedEvidence,
): StandaloneReviewSupersededEvidence {
  return {
    kind: 'superseded',
    schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
    evidenceId: randomUUID(),
    reviewTaskId: superseded.reviewTaskId,
    obligationId: superseded.obligationId,
    supersededPreparedEvidenceId: superseded.evidenceId,
    replacementPreparedEvidenceId: replacement.evidenceId,
    supersededAt: replacement.preparedAt,
    // Same objectives, changed subject digest = the documented preparation-to-
    // freeze transition. Changed objectives = a genuinely re-prepared task.
    reason:
      superseded.requestedDigests.objectivesDigest === replacement.requestedDigests.objectivesDigest
        ? 'subject_frozen'
        : 'task_reprepared',
  };
}

/**
 * Append a prepared incarnation, structurally superseding any outstanding
 * pending prepared incarnation of the same logical review operation.
 *
 * The replaced entry stays in the array for audit; a `superseded` marker makes
 * the transition explicit. No dedupe by statement or heuristic digests: the
 * lifecycle chain is the authority.
 */
export function appendPreparedReviewEvidence(
  evidence: readonly StandaloneReviewEvidence[],
  prepared: StandaloneReviewPreparedEvidence,
): StandaloneReviewEvidence[] {
  const supersededIds = new Set(
    evidence
      .filter((e): e is StandaloneReviewSupersededEvidence => e.kind === 'superseded')
      .map((e) => e.supersededPreparedEvidenceId),
  );
  const completedIds = new Set(
    evidence
      .filter((e): e is StandaloneReviewCompletedEvidence => e.kind === 'completed')
      .map((e) => e.preparedEvidenceId),
  );
  const identical = evidence.some(
    (entry) =>
      entry.kind === 'prepared' &&
      entry.obligationId === prepared.obligationId &&
      entry.requestedDigests.taskDigest === prepared.requestedDigests.taskDigest,
  );
  if (identical) return [...evidence];

  const outstanding = evidence.filter(
    (entry): entry is StandaloneReviewPreparedEvidence =>
      entry.kind === 'prepared' &&
      entry.obligationId === prepared.obligationId &&
      entry.reviewTaskId === prepared.reviewTaskId &&
      !supersededIds.has(entry.evidenceId) &&
      !completedIds.has(entry.evidenceId),
  );
  const markers = outstanding.map((stale) => supersessionMarker(stale, prepared));
  return [...evidence, ...markers, prepared];
}

/**
 * Resolve the outstanding pending prepared incarnation a completion binds to.
 */
function pendingPreparedEvidence(
  evidence: readonly StandaloneReviewEvidence[],
  obligationId: string,
  reviewTaskId: string,
): StandaloneReviewPreparedEvidence | undefined {
  const supersededIds = new Set(
    evidence
      .filter((e): e is StandaloneReviewSupersededEvidence => e.kind === 'superseded')
      .map((e) => e.supersededPreparedEvidenceId),
  );
  const completedIds = new Set(
    evidence
      .filter((e): e is StandaloneReviewCompletedEvidence => e.kind === 'completed')
      .map((e) => e.preparedEvidenceId),
  );
  return evidence
    .filter(
      (entry): entry is StandaloneReviewPreparedEvidence =>
        entry.kind === 'prepared' &&
        entry.obligationId === obligationId &&
        entry.reviewTaskId === reviewTaskId &&
        !supersededIds.has(entry.evidenceId) &&
        !completedIds.has(entry.evidenceId),
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
  // Exact digest match first (unchanged subject); otherwise bind the outstanding
  // pending incarnation of the same logical review operation so a resolved
  // branch SHA cannot fork the evidence chain.
  const exactPrepared = evidence.find(
    (entry): entry is StandaloneReviewPreparedEvidence =>
      entry.kind === 'prepared' &&
      entry.obligationId === prepared.obligationId &&
      entry.requestedDigests.taskDigest === prepared.requestedDigests.taskDigest,
  );
  const boundPrepared =
    exactPrepared ??
    pendingPreparedEvidence(evidence, prepared.obligationId, prepared.reviewTaskId) ??
    prepared;
  const { findingsDigest, attestationDigest } = reviewFindingsDigests(findings);
  const completed: StandaloneReviewCompletedEvidence = {
    kind: 'completed',
    schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
    evidenceId: randomUUID(),
    reviewTaskId: boundPrepared.reviewTaskId,
    obligationId: boundPrepared.obligationId,
    preparedEvidenceId: boundPrepared.evidenceId,
    completedAt,
    findingsDigest,
    attestationDigest,
  };
  const boundAlreadyPresent = evidence.includes(boundPrepared);
  return boundAlreadyPresent ? [...evidence, completed] : [...evidence, boundPrepared, completed];
}
