import { describe, expect, it } from 'vitest';
import {
  PEER_REVIEW_OBJECTIVES_PROFILE_VERSION,
  PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
  createPeerReviewTask,
  resolveAuthoritativePeerReviewTask,
  type PeerReviewEvidence,
  type PeerReviewPreparedEvidence,
} from './peer-review.js';
import { deriveProofGraph } from '../audit/proofgraph/derive.js';
import { assuranceWith, makeState } from '../fixtures.js';
import { SessionState } from './schema.js';
import {
  createReviewObligation,
  freezeReviewMaterial,
} from '../integration/review/obligations/assurance.js';
import {
  appendCompletedReviewEvidence,
  appendPreparedReviewEvidence,
  preparePeerReviewEvidence,
} from '../integration/tools/review-tool/preparation.js';
import type { ReviewAssuranceState } from './evidence-review.js';

const OBLIGATION_ID = '00000000-0000-4000-8000-00000000000a';
const REVIEW_TASK_ID = '00000000-0000-4000-8000-00000000000b';
const NOW = '2026-01-01T00:00:00.000Z';
const SUBJECT_DIGEST = 'a'.repeat(64);

function reviewObligation(): ReturnType<typeof createReviewObligation> {
  return createReviewObligation({
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerAttempts: 1,
    },
    obligationType: 'review',
    reviewCycle: null,
    iteration: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'subject-digest',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'subject-digest'),
    reviewSubject: {
      kind: 'content',
      source: { kind: 'inline', mediaType: 'text' },
      materialDigest: 'b'.repeat(64),
      subjectDigest: 'subject-digest',
      lineCount: 1,
    },
  });
}

function preparedEntry(
  overrides: Partial<PeerReviewPreparedEvidence> = {},
): PeerReviewPreparedEvidence {
  const { task, requestedDigests } = createPeerReviewTask({
    subjectDigest: SUBJECT_DIGEST,
  });
  return {
    kind: 'prepared',
    schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
    evidenceId: '00000000-0000-4000-8000-000000000001',
    reviewTaskId: REVIEW_TASK_ID,
    obligationId: OBLIGATION_ID,
    preparedAt: NOW,
    task,
    requestedDigests,
    ...overrides,
  };
}

describe('peer review deterministic task', () => {
  it('uses canonical defaults and stable null-provenance hypothesis claims', () => {
    const first = createPeerReviewTask({ subjectDigest: 'a'.repeat(64) });
    const second = createPeerReviewTask({ subjectDigest: 'a'.repeat(64) });

    expect(first).toEqual(second);
    expect(first.task.profileVersion).toBe(PEER_REVIEW_OBJECTIVES_PROFILE_VERSION);
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
      createPeerReviewTask({ subjectDigest: 'b'.repeat(64) }).task.claims[0]?.claimId,
    ).not.toBe(first.task.claims[0]?.claimId);
  });

  it('uses structured custom objectives without deriving objectives from subject text', () => {
    const { task } = createPeerReviewTask({
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
        peerReviewEvidence: [prepared],
        reviewAssurance: assuranceWith({
          obligation: { ...reviewObligation(), obligationId: OBLIGATION_ID },
        }),
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
    const first = preparePeerReviewEvidence(
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
    const second = preparePeerReviewEvidence(
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
    const prepared = preparePeerReviewEvidence(args, NOW, undefined, REVIEW_TASK_ID, OBLIGATION_ID);
    const recomputed = preparePeerReviewEvidence(
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
    const prepared = preparePeerReviewEvidence(args, NOW, undefined, REVIEW_TASK_ID, OBLIGATION_ID);
    const recomputed = preparePeerReviewEvidence(
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
    const peerReviewEvidence = appendCompletedReviewEvidence({
      evidence: superseded,
      prepared: recomputed,
      completedAt: '2026-01-01T00:00:02.000Z',
    });

    const projection = deriveProofGraph(
      makeState('PEER_REVIEW_COMPLETE', {
        peerReviewEvidence,
        reviewAssurance: assuranceWith({
          obligation: { ...reviewObligation(), obligationId: OBLIGATION_ID },
        }),
      }),
      [],
      [],
      '2026-01-01T00:00:03.000Z',
    );

    expect(projection.claims).toHaveLength(prepared.task.claims.length);
    expect(projection.claims).toHaveLength(3);
  });
});

describe('resolveAuthoritativePeerReviewTask lifecycle validation', () => {
  it('resolves the completed incarnation after supersession (contract gate 2)', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const evidence: PeerReviewEvidence[] = [
      first,
      second,
      {
        kind: 'superseded',
        schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
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
        schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000004',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        preparedEvidenceId: second.evidenceId,
        completedAt: NOW,
        findingsDigest: null,
        attestationDigest: null,
      },
    ];
    const result = resolveAuthoritativePeerReviewTask(evidence, OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'ok', reviewTaskId: REVIEW_TASK_ID });
    if (result.kind !== 'ok') throw new TypeError('expected ok');
    expect(result.task.subjectDigest).toBe(SUBJECT_DIGEST);
  });

  it('resolves the pending incarnation when nothing completed yet (contract gate 1)', () => {
    const first = preparedEntry();
    const result = resolveAuthoritativePeerReviewTask([first], OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'ok', reviewTaskId: REVIEW_TASK_ID });
  });

  it('blocks two non-superseded pending incarnations of one review task (adversarial)', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const result = resolveAuthoritativePeerReviewTask([first, second], OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it('blocks a supersession marker with a dangling replacement reference', () => {
    const first = preparedEntry();
    const evidence: PeerReviewEvidence[] = [
      first,
      {
        kind: 'superseded',
        schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000003',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: first.evidenceId,
        replacementPreparedEvidenceId: '00000000-0000-4000-8000-0000000000ff',
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
    ];
    const result = resolveAuthoritativePeerReviewTask(evidence, OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it('blocks a completion referencing a superseded prepared entry', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const evidence: PeerReviewEvidence[] = [
      first,
      second,
      {
        kind: 'superseded',
        schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
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
        schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000004',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        preparedEvidenceId: first.evidenceId,
        completedAt: NOW,
        findingsDigest: null,
        attestationDigest: null,
      },
    ];
    const result = resolveAuthoritativePeerReviewTask(evidence, OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it('blocks a supersession cycle', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const evidence: PeerReviewEvidence[] = [
      first,
      second,
      {
        kind: 'superseded',
        schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
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
        schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000004',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: second.evidenceId,
        replacementPreparedEvidenceId: first.evidenceId,
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
    ];
    const result = resolveAuthoritativePeerReviewTask(evidence, OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it('returns none for an obligation without evidence', () => {
    const result = resolveAuthoritativePeerReviewTask([], OBLIGATION_ID);
    expect(result).toMatchObject({ kind: 'none' });
  });

  it('SessionState rejects a structurally broken lifecycle chain fail-closed', () => {
    const first = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000001' });
    const second = preparedEntry({ evidenceId: '00000000-0000-4000-8000-000000000002' });
    const brokenEvidence: PeerReviewEvidence[] = [
      first,
      second,
      {
        kind: 'superseded',
        schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
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
        schemaVersion: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '00000000-0000-4000-8000-000000000004',
        reviewTaskId: REVIEW_TASK_ID,
        obligationId: OBLIGATION_ID,
        supersededPreparedEvidenceId: second.evidenceId,
        replacementPreparedEvidenceId: first.evidenceId,
        supersededAt: NOW,
        reason: 'subject_frozen',
      },
    ];
    const state = makeState('PEER_REVIEW_COMPLETE', {
      peerReviewEvidence: brokenEvidence,
      reviewAssurance: assuranceWith({
        obligation: { ...reviewObligation(), obligationId: OBLIGATION_ID },
      }),
    });
    const parsed = SessionState.safeParse(state);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new TypeError('expected schema rejection');
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain(
      'peerReviewEvidence',
    );
  });
});

describe('peer review persisted state hard cut', () => {
  it('rejects snapshots without the peerReviewEvidence slot', () => {
    const withoutEvidence: Record<string, unknown> = { ...makeState('READY') };
    delete withoutEvidence.peerReviewEvidence;
    expect(SessionState.safeParse(withoutEvidence).success).toBe(false);
  });
});
