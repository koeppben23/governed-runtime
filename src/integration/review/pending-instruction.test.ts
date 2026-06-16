/**
 * @module integration/review/pending-instruction.test
 * @description Unit tests for the LLM-visible pending review instruction.
 *
 * Guards the host-task contract: the agent must submit the verdict only (the
 * plugin resolves findings from captured evidence), and the review verdict is
 * NOT user approval. Regression guard for the instruction conflict that drove
 * SUBAGENT_SESSION_MISMATCH.
 *
 * @test-policy HAPPY, EDGE
 */
import { describe, it, expect } from 'vitest';
import { buildPendingReviewInstruction } from './pending-instruction.js';

const base = {
  platform: 'opencode' as const,
  reviewKind: 'plan' as const,
  obligation: null,
  iteration: 0,
  planVersion: 1,
  subjectLabel: 'full plan text and ticket text',
};

describe('buildPendingReviewInstruction', () => {
  describe('host_task_sync (OpenCode default)', () => {
    it('instructs verdict-only and never "submit the exact reviewFindings"', () => {
      const result = buildPendingReviewInstruction({ ...base, mode: 'host_task_sync' });
      expect(result.next).toContain('INDEPENDENT_REVIEW_REQUIRED');
      expect(result.next).toContain('submit ONLY the verdict');
      expect(result.next).not.toMatch(/submit the exact reviewFindings/i);
      expect(result.next).toMatch(/do NOT submit, copy, or alter reviewFindings/i);
    });

    it('states the review verdict is NOT user approval and points to flowguard_decision', () => {
      const result = buildPendingReviewInstruction({ ...base, mode: 'host_task_sync' });
      expect(result.next).toContain('NOT user approval');
      expect(result.next).toContain('flowguard_decision');
    });
  });

  describe('blocked / fail-closed modes', () => {
    it('unsupported_blocked stays blocked and rejects flowguard_decision as review evidence', () => {
      const result = buildPendingReviewInstruction({ ...base, mode: 'unsupported_blocked' });
      expect(result.reviewInvocation.status).toBe('unsupported_blocked');
      expect(result.next).toContain('UNSUPPORTED_REVIEW_TRANSPORT');
      expect(result.next).toContain('flowguard_decision is not independent review evidence');
    });
  });
});
