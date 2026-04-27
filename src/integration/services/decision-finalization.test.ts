/**
 * @module integration/services/decision-finalization.test
 * @description Unit tests for decision finalization — MADR and regulated completion.
 *
 * Coverage: HAPPY, BAD, CORNER, EDGE
 * - HAPPY: MADR artifact written on ARCH_COMPLETE, regulated completion triggered
 * - BAD: Non-ok result passes through unchanged
 * - CORNER: EVIDENCE_REVIEW + approve but non-regulated mode skips regulated path
 * - EDGE: EVIDENCE_REVIEW + approve but error present skips regulated path
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeDecision } from './decision-finalization.js';
import {
  makeState,
  REGULATED_POLICY_SNAPSHOT,
  POLICY_SNAPSHOT,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  REVIEW_APPROVE,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
  ARCHITECTURE_DECISION,
} from '../../__fixtures__.js';
import type { RailResult } from '../../rails/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../artifacts/madr-writer.js', () => ({
  writeMadrArtifact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./regulated-completion.js', () => ({
  executeRegulatedCompletion: vi.fn().mockImplementation(async (_s, _f, _id, state) => ({
    ...state,
    archiveStatus: 'verified',
  })),
}));

import { writeMadrArtifact } from '../artifacts/madr-writer.js';
import { executeRegulatedCompletion } from './regulated-completion.js';

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCompleteState(opts?: { regulated?: boolean; error?: boolean }) {
  return makeState('COMPLETE', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    selfReview: SELF_REVIEW_CONVERGED,
    reviewDecision: REVIEW_APPROVE,
    validation: VALIDATION_PASSED,
    implementation: IMPL_EVIDENCE,
    implReview: IMPL_REVIEW_CONVERGED,
    policySnapshot: opts?.regulated ? REGULATED_POLICY_SNAPSHOT : POLICY_SNAPSHOT,
    error: opts?.error
      ? { code: 'ERR', message: 'fail', recoveryHint: 'retry', occurredAt: '2026-01-01T00:00:00Z' }
      : null,
  });
}

function makeOkResult(state: ReturnType<typeof makeState>): RailResult {
  return {
    kind: 'ok',
    state,
    evalResult: { kind: 'awaiting_input', phase: state.phase, prompt: '' },
    transitions: [],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('finalizeDecision', () => {
  describe('HAPPY: MADR artifact on ARCH_COMPLETE', () => {
    it('writes MADR artifact when result is ARCH_COMPLETE with architecture', async () => {
      const state = makeState('ARCH_COMPLETE', {
        architecture: { ...ARCHITECTURE_DECISION, status: 'accepted' },
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
      });
      const result = makeOkResult(state);

      await finalizeDecision('/sess', 'fp', 'sid', 'ARCH_REVIEW', 'approve', result);

      expect(writeMadrArtifact).toHaveBeenCalledOnce();
      expect(writeMadrArtifact).toHaveBeenCalledWith('/sess', state.architecture);
    });
  });

  describe('HAPPY: regulated completion on EVIDENCE_REVIEW + approve', () => {
    it('triggers regulated completion for regulated mode', async () => {
      const state = makeCompleteState({ regulated: true });
      const result = makeOkResult(state);

      const finalResult = await finalizeDecision(
        '/sess',
        'fp',
        'sid',
        'EVIDENCE_REVIEW',
        'approve',
        result,
      );

      expect(executeRegulatedCompletion).toHaveBeenCalledOnce();
      expect(executeRegulatedCompletion).toHaveBeenCalledWith('/sess', 'fp', 'sid', state);
      expect(finalResult.kind).toBe('ok');
      if (finalResult.kind === 'ok') {
        expect(finalResult.state.archiveStatus).toBe('verified');
      }
    });
  });

  describe('BAD: blocked result passes through', () => {
    it('returns blocked result unchanged', async () => {
      const blocked: RailResult = {
        kind: 'blocked',
        code: 'TEST_BLOCKED',
        reason: 'test',
      };

      const result = await finalizeDecision(
        '/sess',
        'fp',
        'sid',
        'EVIDENCE_REVIEW',
        'approve',
        blocked,
      );

      expect(result).toBe(blocked);
      expect(writeMadrArtifact).not.toHaveBeenCalled();
      expect(executeRegulatedCompletion).not.toHaveBeenCalled();
    });
  });

  describe('CORNER: conditions that skip regulated completion', () => {
    it('skips when prior phase is not EVIDENCE_REVIEW', async () => {
      const state = makeCompleteState({ regulated: true });
      const result = makeOkResult(state);

      await finalizeDecision('/sess', 'fp', 'sid', 'PLAN_REVIEW', 'approve', result);

      expect(executeRegulatedCompletion).not.toHaveBeenCalled();
    });

    it('skips when verdict is not approve', async () => {
      const state = makeCompleteState({ regulated: true });
      const result = makeOkResult(state);

      await finalizeDecision('/sess', 'fp', 'sid', 'EVIDENCE_REVIEW', 'changes_requested', result);

      expect(executeRegulatedCompletion).not.toHaveBeenCalled();
    });

    it('skips when mode is not regulated', async () => {
      const state = makeCompleteState({ regulated: false });
      const result = makeOkResult(state);

      await finalizeDecision('/sess', 'fp', 'sid', 'EVIDENCE_REVIEW', 'approve', result);

      expect(executeRegulatedCompletion).not.toHaveBeenCalled();
    });

    it('skips when state has error', async () => {
      const state = makeCompleteState({ regulated: true, error: true });
      const result = makeOkResult(state);

      await finalizeDecision('/sess', 'fp', 'sid', 'EVIDENCE_REVIEW', 'approve', result);

      expect(executeRegulatedCompletion).not.toHaveBeenCalled();
    });

    it('skips when phase is not COMPLETE', async () => {
      const state = makeState('EVIDENCE_REVIEW', {
        policySnapshot: REGULATED_POLICY_SNAPSHOT,
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        implementation: IMPL_EVIDENCE,
        implReview: IMPL_REVIEW_CONVERGED,
      });
      const result = makeOkResult(state);

      await finalizeDecision('/sess', 'fp', 'sid', 'EVIDENCE_REVIEW', 'approve', result);

      expect(executeRegulatedCompletion).not.toHaveBeenCalled();
    });
  });

  describe('EDGE: MADR not triggered without architecture', () => {
    it('skips MADR when ARCH_COMPLETE but no architecture data', async () => {
      const state = makeState('ARCH_COMPLETE', {
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
      });
      const result = makeOkResult(state);

      await finalizeDecision('/sess', 'fp', 'sid', 'ARCH_REVIEW', 'approve', result);

      expect(writeMadrArtifact).not.toHaveBeenCalled();
    });
  });
});
