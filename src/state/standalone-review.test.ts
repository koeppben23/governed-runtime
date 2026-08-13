import { describe, expect, it } from 'vitest';
import {
  STANDALONE_REVIEW_OBJECTIVES_PROFILE_VERSION,
  STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
  createStandaloneReviewTask,
  resolveAuthoritativeStandaloneReviewTask,
  type StandaloneReviewEvidence,
  type StandaloneReviewPreparedEvidence,
} from './standalone-review.js';
import { deriveProofGraph } from '../audit/proofgraph/derive.js';
import { makeState } from '../fixtures.js';
import { SessionState } from './schema.js';
import { createReviewObligation } from '../integration/review/assurance.js';
import {
  appendCompletedReviewEvidence,
  appendPreparedReviewEvidence,
  prepareStandaloneReviewEvidence,
} from '../integration/tools/review-tool/preparation.js';
import type { ReviewAssuranceState } from './evidence-review.js';

const OBLIGATION_ID = '00000000-0000-4000-8000-00000000000a';
const REVIEW_TASK_ID = '00000000-0000-4000-8000-00000000000b';
const NOW = '2026-01-01T00:00:00.000Z';
const SUBJECT_DIGEST = 'a'.repeat(64);

function reviewObligation(): ReturnType<typeof createReviewObligation> {
  return createReviewObligation({
    obligationType: 'review',
    iteration: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'subject-digest',
    reviewSubject: {
      kind: 'content',
      source: { kind: 'inline', mediaType: 'text' },
      materialDigest: 'b'.repeat(64),
      subjectDigest: 'subject-digest',
      lineCount: 1,
    },
  });
}

function assuranceWith(obligationId: string): ReviewAssuranceState {
  const obligation = { ...reviewObligation(), obligationId };
  return {
    assuranceSchemaVersion: 'review-assurance.v3',
    obligations: [obligation],
    invocations: [],
    attempts: [],
  };
}

function preparedEntry(
  overrides: Partial<StandaloneReviewPreparedEvidence> = {},
): StandaloneReviewPreparedEvidence {
  const { task, requestedDigests } = createStandaloneReviewTask({
    subjectDigest: SUBJECT_DIGEST,
  });
  return {
    kind: 'prepared',
    schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
    evidenceId: '00000000-0000-4000-8000-000000000001',
    reviewTaskId: REVIEW_TASK_ID,
    obligationId: OBLIGATION_ID,
    preparedAt: NOW,
    task,
    requestedDigests,
    ...overrides,
  };
}

describe('standalone review deterministic task', () => {
  it('uses canonical defaults and stable null-provenance hypothesis claims', () => {
    const first = createStandaloneReviewTask({ subjectDigest: 'a'.repeat(64) });
    const second = createStandaloneReviewTask({ subjectDigest: 'a'.repeat(64) });

    expect(first).toEqual(second);
    expect(first.task.profileVersion).toBe(STANDALONE_REVIEW_OBJECTIVES_PROFILE_VERSION);
    expect(first.task.objectives).toHaveLength(3);
    expect(first.task.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signalClass: 'hypothesis',
          provenance: null,
          evidenceRefs: [],
          counterexampleRefs: [],
        }),
      ]),
    );
    expect(
      createStandaloneReviewTask({ subjectDigest: 'b'.repeat(64) }).task.claims[0]?.claimId,
    ).not.toBe(first.task.claims[0]?.claimId);
  });

  it('uses structured custom objectives without deriving objectives from subject text', () => {
    const { task } = createStandaloneReviewTask({
      subjectDigest: 'a'.repeat(64),
      objectives: [
        { objectiveId: 'api-contract', statement: 'The API contract remains compatible.' },
      ],
    });

    expect(task.objectives).toEqual([
      { objectiveId: 'api-contract', statement: 'The API contract remains compatible.' },
    ]);
    expect(task.claims).toHaveLength(1);
    expect(task.claims[0]).toMatchObject({
      statement: 'The API contract remains compatible.',
      provenance: null,
      signalClass: 'hypothesis',
    });
  });

  it('adds review claims to the graph as NOT_VERIFIED, never proven provider evidence', () => {
    const prepared = preparedEntry();
    const projection = deriveProofGraph(
      makeState('READY', {
        standaloneReviewEvidence: [prepared],
        reviewAssurance: assuranceWith(OBLIGATION_ID),
      }),
      [],
      [],
      '2026-01-01T00:00:00.000Z',
    );

    expect(projection.claims).toHaveLength(prepared.task.claims.length);
    expect(projection.claims.every((claim) => claim.verificationState === 'NOT_VERIFIED')).toBe(
      true,
    );
  });

  it('binds a branch review subject to its resolved head rather than its mutable branch name', () => {
    const args = { branch: 'feature', base: 'main' };
    const first = prepareStandaloneReviewEvidence(
      args,
      NOW,
      {
        branch: 'feature',
        baseBranch: 'main',
        resolvedBranchSha: 'a'.repeat(40),
        resolvedBaseSha: 'b'.repeat(40),
      },
      REVIEW_TASK_ID,
      OBLIGATION_ID,
    );
    const second = prepareStandaloneReviewEvidence(
      args,
      NOW,
      {
        branch: 'feature',
        baseBranch: 'main',
        resolvedBranchSha: 'c'.repeat(40),
        resolvedBaseSha: 'b'.repeat(40),
      },
      REVIEW_TASK_ID,
      OBLIGATION_ID,
    );

    expect(second.task.subjectDigest).not.toBe(first.task.subjectDigest);
  });

  it('completes the outstanding prepared entry when the subject digest drifted', () => {
    // Preparation runs before the branch resolves to an immutable SHA, so the
    // completion recomputes a different taskDigest. The lifecycle chain binds
    // the completion to the outstanding prepared incarnation instead of forking
    // the evidence chain and duplicating hypothesis claims (#762).
    const args = { branch: 'feature', base: 'main' };
    const prepared = prepareStandaloneReviewEvidence(
      args,
      NOW,
      undefined,
      REVIEW_TASK_ID,
      OBLIGATION_ID,
    );
    const recomputed = prepareStandaloneReviewEvidence(
      args,
      '2026-01-01T00:00:01.000Z',
      {
        branch: 'feature',
        baseBranch: 'main',
        resolvedBranchSha: 'a'.repeat(40),
        resolvedBaseSha: 'b'.repeat(40),
      },
      REVIEW_TASK_ID,
      OBLIGATION_ID,
    );
    expect(recomputed.requestedDigests.taskDigest).not.toBe(prepared.requestedDigests.taskDigest);

    const evidence = appendCompletedReviewEvidence({
      evidence: appendPreparedReviewEvidence([], prepared),
      prepared: recomputed,
      completedAt: '2026-01-01T00:00:02.000Z',
    });

    expect(evidence.filter((entry) => entry.kind === 'prepared')).toHaveLength(1);
    expect(evidence.filter((entry) => entry.kind === 'completed')).toHaveLength(1);
    const completed = evidence.find((entry) => entry.kind === 'completed');
    expect(completed?.preparedEvidenceId).toBe(prepared.evidenceId);
  });

  it('keeps the hypothesis claim count at the objective count across the full lifecycle', () => {
    const args = { branch: 'feature', base: 'main' };
    const prepared = prepareStandaloneReviewEvidence(
      args,
      NOW,
      undefined,
      REVIEW_TASK_ID,
      OBLIGATION_ID,
    );
    const recomputed = prepareStandaloneReviewEvidence(
      args,
      '2026-01-01T00:00:01.000Z',
      {
        branch: 'feature',
        baseBranch: 'main',
        resolvedBranchSha: 'a'.repeat(40),
        resolvedBaseSha: 'b'.repeat(40),
      },
      REVIEW_TASK_ID,
      OBLIGATION_ID,
    );
    const evidence = appendPreparedReviewEvidence([], prepared);
    const superseded = appendPreparedReviewEvidence(evidence, recomputed);
    const standaloneReviewEvidence = appendCompletedReviewEvidence({
      evidence: superseded,
      prepared: recomputed,
      completedAt: '2026-01-01T00:00:02.000Z',
    });

    const projection = deriveProofGraph(
      makeState('REVIEW_COMPLETE', {
        standaloneReviewEvidence,
        reviewAssurance: assuranceWith(OBLIGATION_ID),
      }),
      [],
      [],
      '2026-01-01T00:00:03.000Z',
    );

    expect(projection.claims).toHaveLength(prepared.task.claims.length);
    expect(projection.claims).toHaveLength(3);
  });
});

describe('resolveAuthoritativeStandaloneReviewTask lifecycle validation', () => {
  it('resolves the completed incarnation after supersession (contract gate 2)', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const evidence: StandaloneReviewEvidence[] = [
      first,
      second,
      {
        kind: 'superseded',
        schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000003',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: first.evidenceId,
        replacementPreparedEvidenceId: second.evidenceId,
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
      {
        kind: 'completed',
        schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000004',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        preparedEvidenceId: second.evidenceId,
        completedAt: NOW,
        findingsDigest: null,
        attestationDigest: null,
      },
    ];
    const result = resolveAuthoritativeStandaloneReviewTask(evidence, OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'ok', reviewTaskId: REVIEW_TASK_ID });
    if (result.kind !== 'ok') throw new TypeError('expected ok');
    expect(result.task.subjectDigest).toBe(SUBJECT_DIGEST);
  });

  it('resolves the pending incarnation when nothing completed yet (contract gate 1)', () => {
    const first = preparedEntry();
    const result = resolveAuthoritativeStandaloneReviewTask([first], OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'ok', reviewTaskId: REVIEW_TASK_ID });
  });

  it('blocks two non-superseded pending incarnations of one review task (adversarial)', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const result = resolveAuthoritativeStandaloneReviewTask([first, second], OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it('blocks a supersession marker with a dangling replacement reference', () => {
    const first = preparedEntry();
    const evidence: StandaloneReviewEvidence[] = [
      first,
      {
        kind: 'superseded',
        schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000003',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: first.evidenceId,
        replacementPreparedEvidenceId: '00000000-0000-4000-8000-0000000000ff',
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
    ];
    const result = resolveAuthoritativeStandaloneReviewTask(evidence, OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it('blocks a completion referencing a superseded prepared entry', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const evidence: StandaloneReviewEvidence[] = [
      first,
      second,
      {
        kind: 'superseded',
        schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000003',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: first.evidenceId,
        replacementPreparedEvidenceId: second.evidenceId,
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
      {
        kind: 'completed',
        schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000004',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        preparedEvidenceId: first.evidenceId,
        completedAt: NOW,
        findingsDigest: null,
        attestationDigest: null,
      },
    ];
    const result = resolveAuthoritativeStandaloneReviewTask(evidence, OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it('blocks a supersession cycle', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const evidence: StandaloneReviewEvidence[] = [
      first,
      second,
      {
        kind: 'superseded',
        schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000003',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: first.evidenceId,
        replacementPreparedEvidenceId: second.evidenceId,
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
      {
        kind: 'superseded',
        schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000004',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: second.evidenceId,
        replacementPreparedEvidenceId: first.evidenceId,
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
    ];
    const result = resolveAuthoritativeStandaloneReviewTask(evidence, OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it('returns none for an obligation without evidence', () => {
    const result = resolveAuthoritativeStandaloneReviewTask([], OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'none' });
  });

  it('SessionState rejects a structurally broken lifecycle chain fail-closed', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const brokenEvidence: StandaloneReviewEvidence[] = [
      first,
      second,
      {
        kind: 'superseded',
        schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000003',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: first.evidenceId,
        replacementPreparedEvidenceId: second.evidenceId,
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
      {
        kind: 'superseded',
        schemaVersion: STANDALONE_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000004',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: second.evidenceId,
        replacementPreparedEvidenceId: first.evidenceId,
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
    ];
    const state = makeState('REVIEW_COMPLETE', {
      standaloneReviewEvidence: brokenEvidence,
      reviewAssurance: assuranceWith(OBLIGATION_ID),
    });
    const parsed = SessionState.safeParse(state);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new TypeError('expected schema rejection');
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain(
      'standaloneReviewEvidence',
    );
  });
});
