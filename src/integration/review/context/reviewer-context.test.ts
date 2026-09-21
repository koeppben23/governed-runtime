/**
 * Frozen implementation review material is the single canonical carrier of
 * host-executed verification evidence for the native reviewer transport: the
 * attempt identity and its execution-continuity observation must reach the
 * reviewer through this persisted material, not through a mutable re-read.
 */

import { describe, expect, it } from 'vitest';

import { IMPL_EVIDENCE, VALIDATION_PASSED, makeState } from '../../../fixtures.js';
import { renderPlanClaimDeclarations } from '../../../presentation/index.js';
import { buildFrozenReviewMaterialContent } from './reviewer-context.js';

const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const OBSERVED_DIGEST = 'b'.repeat(64);
const PRE_COMMIT_DIGEST = 'c'.repeat(64);

function implementationState(executionObservation: {
  executionObservedStateDigest: string;
  preCommitStateDigest: string;
}) {
  return makeState('IMPL_REVIEW', {
    implementation: IMPL_EVIDENCE,
    validationAttempts: [
      {
        attemptId: ATTEMPT_ID,
        scope: 'implementation',
        implementationDigest: IMPL_EVIDENCE.digest,
        executionObservation,
        result: VALIDATION_PASSED[0]!,
      },
    ] as never,
  });
}

describe('buildFrozenReviewMaterialContent', () => {
  it('binds the executed attempt and its observed state digests into reviewer material', () => {
    const content = buildFrozenReviewMaterialContent({
      obligationType: 'implement',
      renderPlanClaimDeclarations,
      state: implementationState({
        executionObservedStateDigest: OBSERVED_DIGEST,
        preCommitStateDigest: PRE_COMMIT_DIGEST,
      }),
      artifact: 'the diff',
    });

    expect(content).toContain('Verification Evidence (host-executed)');
    expect(content).toContain(ATTEMPT_ID);
    expect(content).toContain(VALIDATION_PASSED[0]!.executedAt);
    expect(content).toContain(OBSERVED_DIGEST);
    expect(content).toContain(PRE_COMMIT_DIGEST);
    expect(content).toContain('"stateChangedDuringExecution":true');
  });

  it('derives an unchanged continuity projection from equal digests', () => {
    const content = buildFrozenReviewMaterialContent({
      obligationType: 'implement',
      renderPlanClaimDeclarations,
      state: implementationState({
        executionObservedStateDigest: OBSERVED_DIGEST,
        preCommitStateDigest: OBSERVED_DIGEST,
      }),
      artifact: 'the diff',
    });

    expect(content).toContain('"stateChangedDuringExecution":false');
  });

  it('carries no verification evidence for plan material', () => {
    const content = buildFrozenReviewMaterialContent({
      obligationType: 'plan',
      renderPlanClaimDeclarations,
      state: makeState('PLAN_REVIEW'),
      artifact: 'the plan',
    });

    expect(content).not.toContain('Verification Evidence (host-executed)');
  });
});
