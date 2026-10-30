/** Reviewer Task results must be routed before completion-only fields are read. */
import { describe, expect, it } from 'vitest';
import { PLAN_COMMAND } from '../../../templates/commands/plan.js';
import { IMPLEMENT_COMMAND } from '../../../templates/commands/implement.js';
import { ARCHITECTURE_COMMAND } from '../../../templates/commands/architecture.js';
import { REVIEW_COMMAND } from '../../../templates/commands/review.js';
import {
  buildReviewerCaptureRetryOutput,
  classifyReviewerCaptureFailure,
} from './capture-retry.js';

const commands = [PLAN_COMMAND, IMPLEMENT_COMMAND, ARCHITECTURE_COMMAND, REVIEW_COMMAND];

describe('reviewer Task return contract', () => {
  it('routes a real incomplete retry without requiring dispatch or completion evidence', () => {
    const retry = JSON.parse(
      buildReviewerCaptureRetryOutput({
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        obligationId: '11111111-1111-4111-8111-111111111111',
        attemptId: '22222222-2222-4222-8222-222222222222',
        diagnostics: [{ code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING' }],
      }),
    );
    expect(retry.reviewDispatch).toEqual({ required: true, completed: false });
    expect(retry.reviewRetry.retryable).toBe(true);
    expect(retry).not.toHaveProperty('reviewInvocation');
    expect(retry).not.toHaveProperty('reviewExecution');
    for (const command of commands) {
      const completion = command.indexOf('When `reviewDispatch.completed` is true:');
      expect(completion).toBeGreaterThan(command.indexOf('reviewRetry'));
      expect(command.slice(0, completion)).not.toContain('reviewExecution.visible');
      expect(command.slice(completion)).toContain('reviewExecution.visible === true');
      expect(command).toContain('After EVERY Task return, restart response routing');
    }
  });

  it('requires all execution proofs only for a completed result and stops on terminal errors', () => {
    expect(
      classifyReviewerCaptureFailure('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE').retryable,
    ).toBe(false);
    for (const command of commands) {
      const completion = command.indexOf('When `reviewDispatch.completed` is true:');
      const completedBranch = command.slice(completion);
      expect(completedBranch).toContain('reviewExecution.transcriptNavigable === true');
      expect(completedBranch).toContain('reviewExecution.validationAuthority === "flowguard"');
      expect(completedBranch).toContain('Otherwise stop on the returned');
      expect(command).toContain('terminal BLOCKED or `error: true`');
      expect(command).toContain('never infer a retry from an error code');
    }
  });
});
