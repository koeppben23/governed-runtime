/**
 * @module standalone-review
 * @description Deterministic standalone-review task and append-only evidence schemas.
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { digestToId, hashText } from '../shared/hashing.js';
import type { ReviewFindings } from './evidence.js';
import { DeclaredClaim, type DeclaredClaim as DeclaredClaimType } from './proofgraph.js';

export const STANDALONE_REVIEW_OBJECTIVES_PROFILE_VERSION =
  'standalone-review-objectives.v1' as const;

export const StandaloneReviewObjective = z
  .object({
    objectiveId: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_-]*$/),
    statement: z.string().min(1),
  })
  .readonly();
export type StandaloneReviewObjective = z.infer<typeof StandaloneReviewObjective>;

/** Canonical static objectives. They are never inferred from review subject text. */
export const STANDALONE_REVIEW_DEFAULT_OBJECTIVES: readonly StandaloneReviewObjective[] = [
  { objectiveId: 'correctness', statement: 'The reviewed subject behaves correctly.' },
  {
    objectiveId: 'safety',
    statement:
      'The reviewed subject does not introduce material security or reliability regressions.',
  },
  {
    objectiveId: 'verification',
    statement: 'The reviewed subject has sufficient verification evidence for the review findings.',
  },
];

export const StandaloneReviewRequestedDigests = z
  .object({
    taskDigest: z.string().regex(/^[a-f0-9]{64}$/),
    objectivesDigest: z.string().regex(/^[a-f0-9]{64}$/),
    subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .readonly();
export type StandaloneReviewRequestedDigests = z.infer<typeof StandaloneReviewRequestedDigests>;

export const StandaloneReviewTask = z
  .object({
    profileVersion: z.literal(STANDALONE_REVIEW_OBJECTIVES_PROFILE_VERSION),
    objectives: z.array(StandaloneReviewObjective).min(1),
    /** Digest only: the reviewed subject is evidence, never claim provenance. */
    subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
    claims: z.array(DeclaredClaim),
  })
  .readonly();
export type StandaloneReviewTask = z.infer<typeof StandaloneReviewTask>;

/**
 * Hard version literal for standalone-review evidence entries.
 *
 * v2 introduces an explicit lifecycle chain: every entry carries a stable
 * `reviewTaskId` (the logical review operation — deliberately NOT the
 * taskDigest, subjectDigest, or evidenceId) and its owning `obligationId`.
 * `prepared` incarnations are superseded STRUCTURALLY via `superseded` entries
 * instead of being inferred from digests. `completed` no longer duplicates the
 * task payload; task authority resolves exclusively through its
 * `preparedEvidenceId`.
 *
 * Entries persisted without this literal are invalid: there is no upgrade or
 * fallback path (see repository no-legacy policy).
 */
export const STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION = 'standalone-review-evidence.v2' as const;

const evidenceIdentity = {
  schemaVersion: z.literal(STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION),
  evidenceId: z.string().uuid(),
  /** Stable lifecycle identity of the logical review operation. */
  reviewTaskId: z.string().uuid(),
  /** Owning review obligation. */
  obligationId: z.string().uuid(),
} as const;

export const StandaloneReviewPreparedEvidence = z
  .object({
    kind: z.literal('prepared'),
    ...evidenceIdentity,
    preparedAt: z.string().datetime(),
    task: StandaloneReviewTask,
    requestedDigests: StandaloneReviewRequestedDigests,
  })
  .readonly();
export type StandaloneReviewPreparedEvidence = z.infer<typeof StandaloneReviewPreparedEvidence>;

export const StandaloneReviewCompletedEvidence = z
  .object({
    kind: z.literal('completed'),
    ...evidenceIdentity,
    /** Task authority resolves through the referenced prepared entry. */
    preparedEvidenceId: z.string().uuid(),
    completedAt: z.string().datetime(),
    findingsDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    attestationDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .readonly();
export type StandaloneReviewCompletedEvidence = z.infer<typeof StandaloneReviewCompletedEvidence>;

export const StandaloneReviewSupersededEvidence = z
  .object({
    kind: z.literal('superseded'),
    ...evidenceIdentity,
    supersededPreparedEvidenceId: z.string().uuid(),
    replacementPreparedEvidenceId: z.string().uuid(),
    supersededAt: z.string().datetime(),
    reason: z.enum(['subject_frozen', 'task_reprepared']),
  })
  .readonly();
export type StandaloneReviewSupersededEvidence = z.infer<typeof StandaloneReviewSupersededEvidence>;

export const StandaloneReviewEvidence = z.discriminatedUnion('kind', [
  StandaloneReviewPreparedEvidence,
  StandaloneReviewCompletedEvidence,
  StandaloneReviewSupersededEvidence,
]);
export type StandaloneReviewEvidence = z.infer<typeof StandaloneReviewEvidence>;

function normalizedStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').toLowerCase();
}

function deterministicUuid(input: string): string {
  return digestToId(hashText(input), 5);
}

export function createStandaloneReviewTask(input: {
  readonly subjectDigest: string;
  readonly objectives?: readonly StandaloneReviewObjective[];
}): { task: StandaloneReviewTask; requestedDigests: StandaloneReviewRequestedDigests } {
  const objectives = input.objectives
    ? [...input.objectives]
    : [...STANDALONE_REVIEW_DEFAULT_OBJECTIVES];
  const objectivesDigest = hashText(canonicalJsonStringify(objectives));
  const claims: DeclaredClaimType[] = objectives.map((objective) => ({
    claimId: deterministicUuid(
      canonicalJsonStringify({
        profileVersion: STANDALONE_REVIEW_OBJECTIVES_PROFILE_VERSION,
        objectiveId: objective.objectiveId,
        statement: normalizedStatement(objective.statement),
        subjectDigest: input.subjectDigest,
      }),
    ),
    statement: objective.statement.trim(),
    signalClass: 'hypothesis' as const,
    critical: false,
    provenance: null,
    evidenceRefs: [],
    counterexampleRefs: [],
  }));
  const task = {
    profileVersion: STANDALONE_REVIEW_OBJECTIVES_PROFILE_VERSION,
    objectives,
    subjectDigest: input.subjectDigest,
    claims,
  };
  return {
    task,
    requestedDigests: {
      taskDigest: hashText(canonicalJsonStringify(task)),
      objectivesDigest,
      subjectDigest: input.subjectDigest,
    },
  };
}

export function reviewFindingsDigests(findings: ReviewFindings | undefined): {
  findingsDigest: string | null;
  attestationDigest: string | null;
} {
  if (!findings) return { findingsDigest: null, attestationDigest: null };
  return {
    findingsDigest: hashText(canonicalJsonStringify(findings)),
    attestationDigest: findings.attestation
      ? hashText(canonicalJsonStringify(findings.attestation))
      : null,
  };
}

// ─── Authoritative Task Resolution ────────────────────────────────────────────

export type AuthoritativeStandaloneReviewTask =
  | {
      readonly kind: 'ok';
      readonly task: StandaloneReviewTask;
      readonly reviewTaskId: string;
    }
  | { readonly kind: 'none'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string };

type EvidenceIndexes = {
  readonly preparedById: ReadonlyMap<string, StandaloneReviewPreparedEvidence>;
  readonly preparedByTask: ReadonlyMap<string, StandaloneReviewPreparedEvidence[]>;
  readonly completedByTask: ReadonlyMap<string, StandaloneReviewCompletedEvidence[]>;
  readonly supersededByTask: ReadonlyMap<string, StandaloneReviewSupersededEvidence[]>;
};

function indexStandaloneEvidence(
  evidence: readonly StandaloneReviewEvidence[],
  obligationId: string,
): EvidenceIndexes {
  const prepared = evidence.filter(
    (e): e is StandaloneReviewPreparedEvidence =>
      e.kind === 'prepared' && e.obligationId === obligationId,
  );
  const completed = evidence.filter(
    (e): e is StandaloneReviewCompletedEvidence =>
      e.kind === 'completed' && e.obligationId === obligationId,
  );
  const superseded = evidence.filter(
    (e): e is StandaloneReviewSupersededEvidence =>
      e.kind === 'superseded' && e.obligationId === obligationId,
  );
  return {
    preparedById: new Map(prepared.map((p) => [p.evidenceId, p])),
    preparedByTask: groupBy(prepared, (p) => p.reviewTaskId),
    completedByTask: groupBy(completed, (c) => c.reviewTaskId),
    supersededByTask: groupBy(superseded, (s) => s.reviewTaskId),
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function validateSupersessionGraph(index: EvidenceIndexes): string | null {
  const preparedById = index.preparedById;
  for (const markers of index.supersededByTask.values()) {
    for (const marker of markers) {
      const superseded = preparedById.get(marker.supersededPreparedEvidenceId);
      if (!superseded) {
        return `supersededPreparedEvidenceId ${marker.supersededPreparedEvidenceId} does not reference a prepared entry`;
      }
      const replacement = preparedById.get(marker.replacementPreparedEvidenceId);
      if (!replacement) {
        return `replacementPreparedEvidenceId ${marker.replacementPreparedEvidenceId} does not reference a prepared entry`;
      }
      if (
        marker.reviewTaskId !== superseded.reviewTaskId ||
        marker.reviewTaskId !== replacement.reviewTaskId
      ) {
        return `supersession marker ${marker.evidenceId} crosses reviewTaskId boundaries`;
      }
    }
  }
  // At most one replacement per prepared, and no replacement cycles.
  const replacements = new Map<string, string>();
  for (const markers of index.supersededByTask.values()) {
    for (const marker of markers) {
      const existing = replacements.get(marker.supersededPreparedEvidenceId);
      if (existing && existing !== marker.replacementPreparedEvidenceId) {
        return `prepared ${marker.supersededPreparedEvidenceId} has multiple replacements`;
      }
      replacements.set(marker.supersededPreparedEvidenceId, marker.replacementPreparedEvidenceId);
    }
  }
  for (const start of replacements.keys()) {
    const seen = new Set<string>([start]);
    let cursor: string | undefined = replacements.get(start);
    while (cursor) {
      if (seen.has(cursor)) {
        return `supersession graph contains a cycle at ${cursor}`;
      }
      seen.add(cursor);
      cursor = replacements.get(cursor);
    }
  }
  return null;
}

/**
 * Resolve the single authoritative standalone-review task for an obligation.
 *
 * The authoritative incarnation is the task payload of the latest non-
 * superseded `prepared` entry for the obligation's `reviewTaskId` chain:
 * `completed` entries reference it and inherit its task; `superseded` entries
 * mark earlier prepared incarnations as audit-only with zero governance
 * authority. Any structurally broken chain (dangling references, cross-task
 * supersession, multiple replacements, cycles, completions on superseded
 * prepared entries, or multiple authoritative incarnations) fails closed.
 */
export function resolveAuthoritativeStandaloneReviewTask(
  evidence: readonly StandaloneReviewEvidence[],
  obligationId: string,
): AuthoritativeStandaloneReviewTask {
  const index = indexStandaloneEvidence(evidence, obligationId);

  const graphError = validateSupersessionGraph(index);
  if (graphError) return { kind: 'blocked', reason: graphError };

  const supersededPreparedIds = new Set<string>();
  for (const markers of index.supersededByTask.values()) {
    for (const marker of markers) supersededPreparedIds.add(marker.supersededPreparedEvidenceId);
  }

  const taskIds = new Set([
    ...index.preparedByTask.keys(),
    ...index.completedByTask.keys(),
    ...index.supersededByTask.keys(),
  ]);
  if (taskIds.size === 0) {
    return { kind: 'none', reason: 'no standalone review evidence for this obligation' };
  }
  if (taskIds.size > 1) {
    return {
      kind: 'blocked',
      reason: 'multiple reviewTaskIds exist for one obligation; the lifecycle chain is ambiguous',
    };
  }
  const reviewTaskId = [...taskIds][0]!;

  const completions = index.completedByTask.get(reviewTaskId) ?? [];
  if (completions.length > 1) {
    return { kind: 'blocked', reason: 'multiple completed entries exist for one review task' };
  }
  const completion = completions[0];
  if (completion) {
    const referenced = index.preparedById.get(completion.preparedEvidenceId);
    if (!referenced) {
      return {
        kind: 'blocked',
        reason: `completed entry references missing prepared evidence ${completion.preparedEvidenceId}`,
      };
    }
    if (supersededPreparedIds.has(completion.preparedEvidenceId)) {
      return {
        kind: 'blocked',
        reason: 'a superseded prepared entry cannot receive an authoritative completion',
      };
    }
    return { kind: 'ok', task: referenced.task, reviewTaskId };
  }

  const pending = (index.preparedByTask.get(reviewTaskId) ?? []).filter(
    (p) => !supersededPreparedIds.has(p.evidenceId),
  );
  if (pending.length > 1) {
    return {
      kind: 'blocked',
      reason: 'multiple non-superseded pending prepared incarnations exist for one review task',
    };
  }
  const authoritative = pending[0];
  if (!authoritative) {
    return { kind: 'none', reason: 'no pending or completed incarnation for this review task' };
  }
  return { kind: 'ok', task: authoritative.task, reviewTaskId };
}
