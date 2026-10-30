/** Host-recorded completion gate. Final prose is never findings authority. */
import type { OrchestratorClient, ReviewerCompletionFailureCode } from '../types.js';
import type { ReviewerTaskCompletion } from './native-task-review-types.js';
import { REVIEWER_STEP_LIMIT } from '../../../templates/mandates-reviewer-criteria.js';
import { completedReviewerModel } from '../../reviewer-capture.js';
import { classifyReviewerProviderError } from './provider-error.js';

type Message = {
  readonly info?: { readonly role?: unknown; readonly finish?: unknown; readonly error?: unknown };
  readonly parts?: unknown;
};
type Facts = { steps: number; finish: unknown; error: string | null; reason?: string };

function incomplete(code: ReviewerCompletionFailureCode, facts: Facts): ReviewerTaskCompletion {
  return {
    kind: 'incomplete',
    code,
    detail: [
      `steps=${facts.steps}`,
      `finish=${typeof facts.finish === 'string' ? facts.finish : 'missing'}`,
      `error=${facts.error ?? 'none'}`,
      ...(facts.reason ? [facts.reason] : []),
    ].join('; '),
  };
}

function partsOf(message: Message): Array<Record<string, unknown>> {
  if (!Array.isArray(message.parts)) return [];
  return message.parts.filter(
    (part): part is Record<string, unknown> => typeof part === 'object' && part !== null,
  );
}

function errorName(message: Message): string | null {
  const error = message.info?.error;
  if (error == null) return null;
  return typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : 'unknown';
}

function classifyLast(last: Message, facts: Facts, stepLimit: number): ReviewerTaskCompletion {
  const parts = partsOf(last);
  const tool = parts.some((part) => part.type === 'tool');
  if (facts.steps > stepLimit)
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      ...facts,
      reason: `more assistant steps than the configured limit ${stepLimit}`,
    });
  if (facts.steps === stepLimit && facts.finish === 'stop' && !tool) {
    return incomplete('REVIEWER_STEP_BUDGET_EXHAUSTED', facts);
  }
  if (tool || facts.finish !== 'stop')
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      ...facts,
      reason: tool ? 'tool call in the last step' : 'no host stop',
    });
  const finalText = parts.some(
    (part) =>
      part.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.trim().length > 0 &&
      part.synthetic !== true &&
      part.ignored !== true,
  );
  return finalText
    ? { kind: 'completed', steps: facts.steps }
    : incomplete('REVIEWER_TASK_INCOMPLETE', facts);
}

function hostSignal(facts: Facts): ReviewerTaskCompletion | null {
  if (facts.error === 'MessageAbortedError') return incomplete('REVIEWER_TASK_ABORTED', facts);
  if (facts.finish === 'length' || facts.error === 'MessageOutputLengthError') {
    return incomplete('REVIEWER_OUTPUT_TRUNCATED', facts);
  }
  return facts.error === null ? null : incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', facts);
}

function stepLimitFromEnvironment(): number | string {
  const raw = process.env.FLOWGUARD_REVIEWER_STEPS;
  if (!raw || process.env.FLOWGUARD_REFERENCE_SUITE !== '1') return REVIEWER_STEP_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 20
    ? value
    : `invalid FLOWGUARD_REVIEWER_STEPS: expected an integer from 1 to 20, got ${JSON.stringify(raw)}`;
}

/** Ordered completion, abort, truncation and budget rules shared by all four review families. */
export function classifyReviewerTaskMessages(
  data: unknown,
  stepLimit?: number,
): ReviewerTaskCompletion {
  const limit = stepLimit ?? stepLimitFromEnvironment();
  const empty = { steps: 0, finish: undefined, error: null };
  if (typeof limit !== 'number')
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', { ...empty, reason: limit });
  if (!Array.isArray(data))
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      ...empty,
      reason: 'messages unreadable',
    });
  const entries = data as Message[];
  const assistant = (entry: Message): boolean =>
    typeof entry === 'object' && entry !== null && entry.info?.role === 'assistant';
  const assistants = entries.filter(assistant);
  const lastIndex = entries.reduce((found, entry, index) => (assistant(entry) ? index : found), -1);
  const last = entries[lastIndex];
  if (!last)
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      ...empty,
      reason: 'no assistant step',
    });
  const facts = { steps: assistants.length, finish: last.info?.finish, error: errorName(last) };
  if (lastIndex !== entries.length - 1)
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      ...facts,
      reason: 'unexpected host message after the final assistant step',
    });
  return hostSignal(facts) ?? classifyLast(last, facts, limit);
}

function unreadable(error: unknown): ReviewerTaskCompletion {
  const failure = classifyReviewerProviderError(error);
  return incomplete(
    failure?.code === 'REVIEWER_HOST_MESSAGE_ENCODING_FAILED'
      ? failure.code
      : 'REVIEWER_COMPLETION_UNVERIFIABLE',
    {
      steps: 0,
      finish: undefined,
      error: null,
      reason: failure?.reason ?? 'messages error',
    },
  );
}

export async function readReviewerTaskCompletion(
  client: OrchestratorClient,
  childSessionId: string,
): Promise<ReviewerTaskCompletion> {
  const session = client.session;
  if (typeof session.messages !== 'function') return unreadable(null);
  let response: Awaited<ReturnType<NonNullable<typeof session.messages>>>;
  try {
    // Keep the SDK receiver: generated methods access this._client.
    response = await session.messages({ path: { id: childSessionId } });
  } catch (error) {
    return unreadable(error);
  }
  if (response?.error !== undefined) return unreadable(response.error);
  const completion = classifyReviewerTaskMessages(response?.data);
  if (completion.kind !== 'completed') return completion;
  const model = completedReviewerModel(response?.data, childSessionId);
  return model
    ? { ...completion, model }
    : incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
        steps: completion.steps,
        finish: 'stop',
        error: null,
        reason: 'child model/variant identity is missing or contradictory',
      });
}
