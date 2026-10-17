/**
 * @module integration/review/reviewer-step-budget.test
 * @description A reviewer child stopped by the host at its configured step
 * limit must not be consumed as a substantive review verdict: the host
 * termination is verified from recorded messages and retried on the same frozen
 * obligation. Anything ambiguous is NOT a completed review and NOT an automatic
 * retry: the caller fails closed because required host evidence is unavailable.
 */
import { readFileSync } from 'node:fs';

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

/**
 * The generated SDK client keeps `_client` on the session object and its
 * `messages()` method reads it through `this`. A detached method call therefore
 * throws instead of reaching the host.
 */
function statefulClientReturning(entry: unknown): OrchestratorClient {
  return {
    app: { agents: async () => ({ data: [] }) },
    session: {
      _client: { transport: 'host' },
      prompt: async () => ({ data: { info: { structured: {} } } }),
      async messages(this: { _client?: unknown }) {
        if (this._client === undefined) {
          throw new TypeError("Cannot read properties of undefined (reading '_client')");
        }
        return entry as never;
      },
    } as unknown as OrchestratorClient['session'],
  };
}

function transcript(assistants: ReturnType<typeof step>[]) {
  return { data: [{ info: { role: 'user' } }, ...assistants] };
}

const yPE7QrTranscript = JSON.parse(
  readFileSync(new URL('./__fixtures__/reviewer-step-budget-yPE7Qr.json', import.meta.url), 'utf8'),
) as { data: unknown[] };

describe('reviewer step-budget detection', () => {
  it('proves a host stop at exactly the configured limit without a tool call', async () => {
    const steps = Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, () => step('tool-calls', true));
    steps.push(step('stop', false));
    await expect(
      detectReviewerStepBudgetExhaustion(clientReturning(transcript(steps)), 'ses_child'),
    ).resolves.toEqual({ state: 'exhausted' });
  });

  it('proves the host stop from the real yPE7Qr child transcript', async () => {
    await expect(
      detectReviewerStepBudgetExhaustion(clientReturning(yPE7QrTranscript), 'ses_child'),
    ).resolves.toEqual({ state: 'exhausted' });
  });

  it('keeps the SDK receiver so a this-dependent messages() call works', async () => {
    const steps = Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, () => step('tool-calls', true));
    steps.push(step('stop', false));
    await expect(
      detectReviewerStepBudgetExhaustion(statefulClientReturning(transcript(steps)), 'ses_child'),
    ).resolves.toEqual({ state: 'exhausted' });
  });

  it('leaves a child below the limit on the normal capture path', async () => {
    await expect(
      detectReviewerStepBudgetExhaustion(
        clientReturning(transcript([step('tool-calls', true), step('stop', false)])),
        'ses_child',
      ),
    ).resolves.toEqual({ state: 'not_exhausted' });
  });

  it('is ambiguous when the limit-step finished with pending tool work', async () => {
    const steps = Array.from({ length: REVIEWER_STEP_LIMIT }, () => step('tool-calls', true));
    await expect(
      detectReviewerStepBudgetExhaustion(clientReturning(transcript(steps)), 'ses_child'),
    ).resolves.toEqual({ state: 'ambiguous', detail: 'limit_without_host_stop' });
  });

  it('does not treat a stop with mixed text/tool parts as a host stop', async () => {
    const steps = Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, () => step('tool-calls', true));
    steps.push({
      info: { role: 'assistant', finish: 'stop' },
      parts: [{ type: 'text' }, { type: 'tool' }],
    });
    await expect(
      detectReviewerStepBudgetExhaustion(clientReturning(transcript(steps)), 'ses_child'),
    ).resolves.toEqual({ state: 'ambiguous', detail: 'limit_without_host_stop' });
  });

  it('ignores non-object parts instead of throwing on host data', async () => {
    const steps = Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, () => step('tool-calls', true));
    steps.push({
      info: { role: 'assistant', finish: 'stop' },
      parts: [null, { type: 'text' }],
    } as unknown as ReturnType<typeof step>);
    await expect(
      detectReviewerStepBudgetExhaustion(clientReturning(transcript(steps)), 'ses_child'),
    ).resolves.toEqual({ state: 'exhausted' });
  });

  it('is ambiguous on a null messages response instead of throwing', async () => {
    await expect(
      detectReviewerStepBudgetExhaustion(clientReturning(null), 'ses_child'),
    ).resolves.toEqual({ state: 'ambiguous', detail: 'unreadable_messages' });
  });

  it('is ambiguous without a usable messages authority', async () => {
    const withoutMessages: OrchestratorClient = {
      app: { agents: async () => ({ data: [] }) },
      session: { prompt: async () => ({ data: { info: { structured: {} } } }) },
    };
    await expect(detectReviewerStepBudgetExhaustion(withoutMessages, 'ses_child')).resolves.toEqual(
      { state: 'ambiguous', detail: 'messages_unavailable' },
    );
    await expect(
      detectReviewerStepBudgetExhaustion(
        clientReturning({ error: new Error('unavailable') }),
        'ses_child',
      ),
    ).resolves.toEqual({ state: 'ambiguous', detail: 'messages_error' });
  });
});
