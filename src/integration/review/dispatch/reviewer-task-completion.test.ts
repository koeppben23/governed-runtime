/**
 * @module integration/review/reviewer-task-completion.test
 * @description The same-child structured follow-up may only serialize a
 * reviewer Task whose host-recorded messages prove a normal completion. A
 * token-truncated, aborted, step-limited or unprovable task is never
 * serialized, whatever verdict a serialization would produce.
 *
 * Fixtures:
 * - `reviewer-plan-2026-10-19-pre-followup-redacted.json`: derived from the real
 *   OpenCode export of the plan-review child `ses_ead29ed7effe5Q9hfbMoOY1ZGM`
 *   (parent `ses_ead2b296cffeD1PY69gDCBnfLj`), the six messages BEFORE the
 *   structured follow-up, reduced to host fields (role, finish, tokens, part
 *   types); prompts, reasoning, tool arguments and answers removed. Five
 *   assistant steps; the last one `finish: "length"` with 32,000 reasoning
 *   tokens, no text and no tool call. Under the previous step-budget-only check
 *   this child reached the serialization prompt and bound an `accept`.
 * - `reviewer-step-budget-yPE7Qr.json`: a real child stopped at the step limit.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { classifyReviewerTaskMessages, readReviewerTaskCompletion } from './structured-followup.js';
import { REVIEWER_STEP_LIMIT } from '../../../templates/mandates-reviewer-criteria.js';
import type { OrchestratorClient, ReviewerCompletionFailureCode } from '../types.js';

type Part = Record<string, unknown>;

function step(finish: string | undefined, parts: Part[], error?: unknown) {
  return {
    info: {
      role: 'assistant',
      ...(finish !== undefined ? { finish } : {}),
      ...(error !== undefined ? { error } : {}),
    },
    parts,
  };
}

const TOOL: Part = { type: 'tool' };
const ANSWER: Part = { type: 'text', text: 'Verdict: accept. Findings: none.' };
const toolStep = () => step('tool-calls', [TOOL]);

function transcript(assistants: ReturnType<typeof step>[]) {
  return [{ info: { role: 'user' }, parts: [{ type: 'text' }] }, ...assistants];
}

function codeOf(data: unknown): ReviewerCompletionFailureCode | 'completed' {
  const result = classifyReviewerTaskMessages(data);
  return result.kind === 'completed' ? 'completed' : result.code;
}

function fixture(name: string): { data: unknown[] } {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as {
    data: unknown[];
  };
}

const OCT19 = fixture('reviewer-plan-2026-10-19-pre-followup-redacted.json');
const YPE7QR = fixture('reviewer-step-budget-yPE7Qr.json');

function clientReturning(entry: unknown): OrchestratorClient {
  return {
    app: { agents: async () => ({ data: [] }) },
    session: {
      prompt: vi.fn(async () => ({ data: { info: { structured: {} } } })),
      messages: async () => entry as never,
    },
  };
}

describe('reviewer task completion - real host fixtures', () => {
  it('BAD: the 2026-10-19 plan-review child is token-truncated, never completed', () => {
    const assistants = OCT19.data.filter(
      (entry) => (entry as { info?: { role?: string } }).info?.role === 'assistant',
    );
    expect(assistants).toHaveLength(5);
    expect(classifyReviewerTaskMessages(OCT19.data)).toEqual({
      kind: 'incomplete',
      code: 'REVIEWER_OUTPUT_TRUNCATED',
      detail: 'steps=5; finish=length; error=none',
    });
  });

  it('CORNER: the yPE7Qr child stays a host step-budget stop', () => {
    expect(codeOf(YPE7QR.data)).toBe('REVIEWER_STEP_BUDGET_EXHAUSTED');
  });
});

describe('reviewer task completion - classification order', () => {
  it('HAPPY: stop with a final answer below the limit is the only completion', () => {
    expect(classifyReviewerTaskMessages(transcript([toolStep(), step('stop', [ANSWER])]))).toEqual({
      kind: 'completed',
      steps: 2,
    });
  });

  it('BAD: any host message after the final assistant step makes completion unverifiable', () => {
    const completed = transcript([toolStep(), step('stop', [ANSWER])]);
    for (const trailing of [
      { info: {} },
      { info: { role: 'user' }, parts: [{ type: 'text' }] },
      { corrupt: true },
    ]) {
      expect(classifyReviewerTaskMessages([...completed, trailing])).toEqual({
        kind: 'incomplete',
        code: 'REVIEWER_COMPLETION_UNVERIFIABLE',
        detail:
          'steps=2; finish=stop; error=none; unexpected host message after the final assistant step',
      });
    }
  });

  it('BAD: an abort is terminal even when the output is also truncated', () => {
    const aborted = { name: 'MessageAbortedError', data: { message: 'aborted' } };
    expect(codeOf(transcript([step('length', [], aborted)]))).toBe('REVIEWER_TASK_ABORTED');
    expect(codeOf(transcript([step('stop', [ANSWER], aborted)]))).toBe('REVIEWER_TASK_ABORTED');
  });

  it('BAD: finish length or MessageOutputLengthError is truncation, also at the step limit', () => {
    expect(codeOf(transcript([step('length', [{ type: 'reasoning' }])]))).toBe(
      'REVIEWER_OUTPUT_TRUNCATED',
    );
    const lengthError = { name: 'MessageOutputLengthError', data: {} };
    expect(codeOf(transcript([step('stop', [ANSWER], lengthError)]))).toBe(
      'REVIEWER_OUTPUT_TRUNCATED',
    );
    const atLimit = Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, toolStep);
    atLimit.push(step('length', []));
    expect(codeOf(transcript(atLimit))).toBe('REVIEWER_OUTPUT_TRUNCATED');
  });

  it('BAD: any other host error cannot prove completion', () => {
    for (const error of [
      { name: 'APIError', data: { message: 'x', isRetryable: false } },
      { name: 'ProviderAuthError', data: {} },
      { name: 'UnknownError', data: {} },
      'opaque',
    ]) {
      expect(codeOf(transcript([step('stop', [ANSWER], error)])), JSON.stringify(error)).toBe(
        'REVIEWER_COMPLETION_UNVERIFIABLE',
      );
    }
  });

  it('BAD: more assistant steps than the configured limit fail closed', () => {
    const over = Array.from({ length: REVIEWER_STEP_LIMIT }, toolStep);
    over.push(step('stop', [ANSWER]));
    expect(codeOf(transcript(over))).toBe('REVIEWER_COMPLETION_UNVERIFIABLE');
  });

  it('CORNER: exactly the limit with stop and no tool call stays the step-budget stop', () => {
    const steps = Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, toolStep);
    steps.push(step('stop', [ANSWER]));
    expect(codeOf(transcript(steps))).toBe('REVIEWER_STEP_BUDGET_EXHAUSTED');
  });

  it('BAD: a tool call or a missing/foreign finish in the last step is unverifiable', () => {
    expect(codeOf(transcript([step('stop', [ANSWER, TOOL])]))).toBe(
      'REVIEWER_COMPLETION_UNVERIFIABLE',
    );
    expect(codeOf(transcript([toolStep()]))).toBe('REVIEWER_COMPLETION_UNVERIFIABLE');
    expect(codeOf(transcript([step(undefined, [ANSWER])]))).toBe(
      'REVIEWER_COMPLETION_UNVERIFIABLE',
    );
    for (const finish of ['content-filter', 'error', 'other', 'unknown']) {
      expect(codeOf(transcript([step(finish, [ANSWER])])), finish).toBe(
        'REVIEWER_COMPLETION_UNVERIFIABLE',
      );
    }
    const atLimit = Array.from({ length: REVIEWER_STEP_LIMIT }, toolStep);
    expect(codeOf(transcript(atLimit))).toBe('REVIEWER_COMPLETION_UNVERIFIABLE');
  });

  it('BAD: stop without a non-blank, non-synthetic answer is incomplete', () => {
    for (const parts of [
      [],
      [{ type: 'reasoning', text: 'thinking' }],
      [{ type: 'text' }],
      [{ type: 'text', text: '   \n\t' }],
      [{ type: 'text', text: 'injected', synthetic: true }],
      [{ type: 'text', text: 'ignored', ignored: true }],
      [null, 7, { type: 'step-finish' }],
    ] as Part[][]) {
      expect(codeOf(transcript([step('stop', parts)])), JSON.stringify(parts)).toBe(
        'REVIEWER_TASK_INCOMPLETE',
      );
    }
  });

  it('EDGE: unreadable data or no assistant step is unverifiable', () => {
    for (const data of [null, undefined, {}, 'x', [], [{ info: { role: 'user' } }], [null]]) {
      expect(codeOf(data), JSON.stringify(data)).toBe('REVIEWER_COMPLETION_UNVERIFIABLE');
    }
  });
});

describe('reviewer task completion - host messages authority', () => {
  it('HAPPY: reads the host messages through the SDK receiver', async () => {
    const session = {
      _client: { transport: 'host' },
      prompt: async () => ({ data: { info: { structured: {} } } }),
      async messages(this: { _client?: unknown }) {
        if (this._client === undefined) throw new TypeError('detached receiver');
        return { data: transcript([step('stop', [ANSWER])]) } as never;
      },
    } as unknown as OrchestratorClient['session'];
    await expect(
      readReviewerTaskCompletion({ app: { agents: async () => ({ data: [] }) }, session }, 'c'),
    ).resolves.toEqual({ kind: 'completed', steps: 1 });
  });

  it('BAD: the 2026-10-19 child read from the host is truncated', async () => {
    await expect(readReviewerTaskCompletion(clientReturning(OCT19), 'c')).resolves.toMatchObject({
      kind: 'incomplete',
      code: 'REVIEWER_OUTPUT_TRUNCATED',
    });
  });

  it('EDGE: missing, throwing, erroring or null messages are unverifiable', async () => {
    const withoutMessages: OrchestratorClient = {
      app: { agents: async () => ({ data: [] }) },
      session: { prompt: async () => ({ data: { info: { structured: {} } } }) },
    };
    const throwing: OrchestratorClient = {
      app: { agents: async () => ({ data: [] }) },
      session: {
        prompt: async () => ({ data: { info: { structured: {} } } }),
        messages: async () => {
          throw new Error('host down');
        },
      },
    };
    for (const client of [
      withoutMessages,
      throwing,
      clientReturning({ error: new Error('unavailable') }),
      clientReturning(null),
    ]) {
      await expect(readReviewerTaskCompletion(client, 'c')).resolves.toMatchObject({
        kind: 'incomplete',
        code: 'REVIEWER_COMPLETION_UNVERIFIABLE',
      });
    }
  });
});
