/**
 * @module standalone-review
 * @description Deterministic standalone-review task and append-only evidence schemas.
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
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

const evidenceBase = {
  evidenceId: z.string().uuid(),
  task: StandaloneReviewTask,
  requestedDigests: StandaloneReviewRequestedDigests,
} as const;

export const StandaloneReviewPreparedEvidence = z
  .object({ kind: z.literal('prepared'), preparedAt: z.string().datetime(), ...evidenceBase })
  .readonly();
export type StandaloneReviewPreparedEvidence = z.infer<typeof StandaloneReviewPreparedEvidence>;

export const StandaloneReviewCompletedEvidence = z
  .object({
    kind: z.literal('completed'),
    completedAt: z.string().datetime(),
    preparedEvidenceId: z.string().uuid(),
    findingsDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    attestationDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    ...evidenceBase,
  })
  .readonly();
export type StandaloneReviewCompletedEvidence = z.infer<typeof StandaloneReviewCompletedEvidence>;

export const StandaloneReviewEvidence = z.discriminatedUnion('kind', [
  StandaloneReviewPreparedEvidence,
  StandaloneReviewCompletedEvidence,
]);
export type StandaloneReviewEvidence = z.infer<typeof StandaloneReviewEvidence>;

function normalizedStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').toLowerCase();
}

function deterministicUuid(input: string): string {
  const hex = hashText(input);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
