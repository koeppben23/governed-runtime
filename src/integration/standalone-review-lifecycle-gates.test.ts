/**
 * @module integration/standalone-review-lifecycle-gates
 * @description Contract gates for the standalone-review claim lifecycle:
 *              output repair keeps one logical review task (gate 4), and a
 *              genuinely new /review creates a new logical task (gate 5).
 */
import { describe, expect, it } from 'vitest';
import {
  appendCompletedReviewEvidence,
  appendPreparedReviewEvidence,
  prepareStandaloneReviewEvidence,
} from './tools/review-tool/preparation.js';
import { deriveProofGraph } from '../audit/proofgraph/derive.js';
import { createReviewObligation } from './review/assurance.js';
import { makeState } from '../fixtures.js';
import type { ReviewAssuranceState } from '../state/evidence-review.js';

const NOW = '2026-01-01T00:00:00.000Z';
const OBLIGATION_A = '00000000-0000-4000-8000-00000000000a';
const OBLIGATION_B = '00000000-0000-4000-8000-00000000000b';
const TASK_A = '00000000-0000-4000-8000-00000000000c';
const TASK_B = '00000000-0000-4000-8000-00000000000d';

function obligation(id: string): ReturnType<typeof createReviewObligation> {
  return {
    ...createReviewObligation({
      obligationType: 'review',
      iteration: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: `subject-${id}`,
      reviewSubject: {
        kind: 'content',
        source: { kind: 'inline', mediaType: 'text' },
        materialDigest: 'b'.repeat(64),
        subjectDigest: `subject-${id}`,
        lineCount: 1,
      },
    }),
    obligationId: id,
  };
}

function assuranceWith(obligationId: string): ReviewAssuranceState {
  return {
    assuranceSchemaVersion: 'review-assurance.v5',
    obligations: [obligation(obligationId)],
    invocations: [],
    attempts: [],
  };
}

function claimIds(projection: { claims: readonly { claimId: string }[] }): string[] {
  return projection.claims.map((claim) => claim.claimId).sort();
}

describe('standalone-review lifecycle gates', () => {
  it('gate 4: output repair keeps the logical task — same 3 projected claimIds', () => {
    const args = { branch: 'feature/x', base: 'main' };
    const prepared = prepareStandaloneReviewEvidence(args, NOW, undefined, TASK_A, OBLIGATION_A);
    // Repair re-preparation of the same logical task with an unchanged subject:
    // no new incarnation is minted, the completion binds the single prepared.
    const evidence = appendCompletedReviewEvidence({
      evidence: appendPreparedReviewEvidence([], prepared),
      prepared: prepareStandaloneReviewEvidence(args, NOW, undefined, TASK_A, OBLIGATION_A),
      completedAt: NOW,
    });

    const projection = deriveProofGraph(
      makeState('REVIEW_COMPLETE', {
        standaloneReviewEvidence: evidence,
        reviewAssurance: assuranceWith(OBLIGATION_A),
      }),
      [],
      [],
      NOW,
    );

    expect(claimIds(projection)).toEqual(claimIds({ claims: prepared.task.claims }));
    expect(projection.claims).toHaveLength(3);
  });

  it('gate 5: a genuinely new /review creates a new logical task with distinct claims', () => {
    const argsA = { branch: 'feature/x', base: 'main' };
    const argsB = { branch: 'feature/y', base: 'main' };
    const preparedA = prepareStandaloneReviewEvidence(argsA, NOW, undefined, TASK_A, OBLIGATION_A);
    const preparedB = prepareStandaloneReviewEvidence(argsB, NOW, undefined, TASK_B, OBLIGATION_B);
    const evidenceA = appendCompletedReviewEvidence({
      evidence: appendPreparedReviewEvidence([], preparedA),
      prepared: prepareStandaloneReviewEvidence(argsA, NOW, undefined, TASK_A, OBLIGATION_A),
      completedAt: NOW,
    });
    const evidenceB = appendCompletedReviewEvidence({
      evidence: appendPreparedReviewEvidence([], preparedB),
      prepared: prepareStandaloneReviewEvidence(argsB, NOW, undefined, TASK_B, OBLIGATION_B),
      completedAt: NOW,
    });

    const projection = deriveProofGraph(
      makeState('REVIEW_COMPLETE', {
        standaloneReviewEvidence: [...evidenceA, ...evidenceB],
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v5',
          obligations: [obligation(OBLIGATION_A), obligation(OBLIGATION_B)],
          invocations: [],
          attempts: [],
        },
      }),
      [],
      [],
      NOW,
    );

    expect(projection.claims).toHaveLength(6);
    const idsA = claimIds({ claims: preparedA.task.claims });
    const idsB = claimIds({ claims: preparedB.task.claims });
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
  });
});
