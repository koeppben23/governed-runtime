/**
 * @module integration/review/reviewer-step-budget.test
 * @description A reviewer child stopped by the host at its configured step
 * limit must not be consumed as a substantive `unable_to_review` verdict: the
 * host termination is verified from recorded messages and retried on the same
 * frozen obligation. Anything ambiguous keeps the normal capture path.
 */
import { describe, expect, it } from 'vitest';
import { detectReviewerStepBudgetExhaustion } from './structured-followup.js';
import { REVIEWER_STEP_LIMIT } from '../../../templates/mandates-reviewer-criteria.js';
import type { OrchestratorClient } from '../types.js';

function step(finish: string, toolCall: boolean) {
  return {
    info: { role: 'assistant', finish },
    parts: toolCall ? [{ type: 'tool' }] : [{ type: 'text' }],
  };
}

function clientReturning(entry: unknown): OrchestratorClient {
  return {
    app: { agents: async () => ({ data: [] }) },
    session: {
      prompt: async () => ({ data: { info: { structured: {} } } }),
      messages: async () => entry as never,
    },
  };
}

function transcript(assistants: ReturnType<typeof step>[]) {
  return { data: [{ info: { role: 'user' } }, ...assistants] };
}

describe('reviewer step-budget detection', () => {
  it('proves a host stop at exactly the configured limit without a tool call', async () => {
    const steps = Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, () => step('tool-calls', true));
    steps.push(step('stop', false));
    await expect(
      detectReviewerStepBudgetExhaustion(clientReturning(transcript(steps)), 'ses_child'),
    ).resolves.toBe('exhausted');
  });

  it('leaves a child below the limit on the normal capture path', async () => {
    await expect(
      detectReviewerStepBudgetExhaustion(
        clientReturning(transcript([step('tool-calls', true), step('stop', false)])),
        'ses_child',
      ),
    ).resolves.toBe('not_exhausted');
  });

  it('is ambiguous when the limit-step finished with pending tool work', async () => {
    const steps = Array.from({ length: REVIEWER_STEP_LIMIT }, () => step('tool-calls', true));
    await expect(
      detectReviewerStepBudgetExhaustion(clientReturning(transcript(steps)), 'ses_child'),
    ).resolves.toBe('ambiguous');
  });

  it('is ambiguous without a usable messages authority', async () => {
    const withoutMessages: OrchestratorClient = {
      app: { agents: async () => ({ data: [] }) },
      session: { prompt: async () => ({ data: { info: { structured: {} } } }) },
    };
    await expect(detectReviewerStepBudgetExhaustion(withoutMessages, 'ses_child')).resolves.toBe(
      'ambiguous',
    );
    await expect(
      detectReviewerStepBudgetExhaustion(
        clientReturning({ error: new Error('unavailable') }),
        'ses_child',
      ),
    ).resolves.toBe('ambiguous');
  });
});
