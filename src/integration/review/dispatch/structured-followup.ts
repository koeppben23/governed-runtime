/**
 * @module integration/review/dispatch/structured-followup
 * @description Schema-constrained serialization of an already-completed native
 *              reviewer Task in the SAME visible child session.
 *
 * The native OpenCode Task transport owns execution visibility, child-session
 * identity, navigation, and permission isolation. The host's Task transport
 * does not return schema-validated structured output (pinned host baseline:
 * `.sdk-baselines/opencode/host-version.json`), so FlowGuard performs a second
 * prompt in that exact child session whose sole purpose is serialization.
 *
 * The Task text is never findings authority. Only `info.structured` from this
 * follow-up, validated against ReviewerFindingsInput, can proceed to evidence
 * binding. The follow-up runs only after `readReviewerTaskCompletion` proved from
 * host-recorded messages that the reviewer finished its task normally.
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { ReviewerFindingsInput } from '../../../state/evidence-review-input.js';
import { resolveReviewerAgent } from './agent-resolution.js';
import type {
  OrchestratorClient,
  PendingReviewRetryDiagnostic,
  ReviewerCompletionFailureCode,
} from '../types.js';
import { REVIEWER_STEP_LIMIT } from '../../../templates/mandates-reviewer-criteria.js';
import type {
  ReviewerTaskCompletion,
  StructuredFollowupFailureCode,
} from './native-task-review-types.js';
import {
  buildStructuredFindingsContractDiagnostics,
  structuredFindingsContractReason,
} from './capture-retry.js';

export type StructuredFollowupResult =
  | {
      readonly kind: 'ok';
      readonly findings: Record<string, unknown>;
      readonly invokedAt: string;
      readonly fulfilledAt: string;
    }
  | {
      readonly kind: 'blocked';
      readonly code: StructuredFollowupFailureCode;
      readonly reason: string;
      readonly diagnostics?: readonly PendingReviewRetryDiagnostic[];
    };

type BlockedFollowup = Extract<StructuredFollowupResult, { readonly kind: 'blocked' }>;
type ParsedFollowup =
  { readonly kind: 'ok'; readonly findings: Record<string, unknown> } | BlockedFollowup;
type PromptResponse = Awaited<ReturnType<OrchestratorClient['session']['prompt']>>;

/**
 * Reviewer task completion: host-evidenced completion of a native reviewer Task
 * BEFORE any structured serialization.
 *
 * The same-child structured follow-up serializes "the findings you concluded";
 * it can turn ANY child transcript into a formally bindable verdict. It may
 * therefore only run after the host-recorded messages prove that the reviewer
 * finished its task normally. A host-terminated, token-truncated, aborted or
 * otherwise unprovable task is never serialized, regardless of how plausible a
 * later verdict would look.
 *
 * Classification is a pure function over the host-recorded `session.messages`
 * data and is evaluated on the LAST assistant step. The first matching rule
 * wins; the order is part of the contract:
 *
 * 1. unreadable messages / no assistant step   -> REVIEWER_COMPLETION_UNVERIFIABLE (terminal)
 * 2. `MessageAbortedError`                      -> REVIEWER_TASK_ABORTED (terminal; never auto-restart)
 * 3. `finish: "length"` / `MessageOutputLengthError`
 *                                               -> REVIEWER_OUTPUT_TRUNCATED (retryable)
 * 4. any other host error                       -> REVIEWER_COMPLETION_UNVERIFIABLE (terminal)
 * 5. more assistant steps than the limit        -> REVIEWER_COMPLETION_UNVERIFIABLE (terminal)
 * 6. exactly the limit, `stop`, no tool call    -> REVIEWER_STEP_BUDGET_EXHAUSTED (retryable)
 * 7. tool call in the last step, or `finish` missing / not `stop`
 *                                               -> REVIEWER_COMPLETION_UNVERIFIABLE (terminal)
 * 8. `stop` without a non-blank, non-synthetic text part
 *                                               -> REVIEWER_TASK_INCOMPLETE (retryable)
 * 9. `stop` with final text below the limit     -> completed (serialization may run)
 *
 * A completed task is a NECESSARY condition only: findings, scope, observation
 * and challenge validation still decide whether the review binds.
 */
type MessagePart = { readonly type?: unknown; readonly text?: unknown } & Record<string, unknown>;

type SessionMessage = {
  readonly info?: {
    readonly role?: unknown;
    readonly finish?: unknown;
    readonly error?: unknown;
  };
  readonly parts?: unknown;
};

function partsOf(message: SessionMessage): readonly MessagePart[] {
  const parts = Array.isArray(message.parts) ? (message.parts as unknown[]) : [];
  return parts.filter((part): part is MessagePart => typeof part === 'object' && part !== null);
}

function errorName(message: SessionMessage): string | null {
  const error = message.info?.error;
  if (error === undefined || error === null) return null;
  if (typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name;
  }
  return 'unknown';
}

/** Final reviewer prose: a real (not synthetic/ignored) text part that is not blank. */
function hasFinalText(parts: readonly MessagePart[]): boolean {
  return parts.some(
    (part) =>
      part.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.trim().length > 0 &&
      part.synthetic !== true &&
      part.ignored !== true,
  );
}

function incomplete(
  code: ReviewerCompletionFailureCode,
  facts: { steps: number; finish: unknown; error: string | null; reason?: string },
): ReviewerTaskCompletion {
  const finish = typeof facts.finish === 'string' ? facts.finish : 'missing';
  const detail = [
    `steps=${facts.steps}`,
    `finish=${finish}`,
    `error=${facts.error ?? 'none'}`,
    ...(facts.reason ? [facts.reason] : []),
  ].join('; ');
  return { kind: 'incomplete', code, detail };
}

/** Host-signal rules 2-4: abort, truncation, other host error (in this order). */
function classifyHostSignal(facts: {
  steps: number;
  finish: unknown;
  error: string | null;
}): ReviewerTaskCompletion | null {
  if (facts.error === 'MessageAbortedError') return incomplete('REVIEWER_TASK_ABORTED', facts);
  if (facts.finish === 'length' || facts.error === 'MessageOutputLengthError') {
    return incomplete('REVIEWER_OUTPUT_TRUNCATED', facts);
  }
  if (facts.error !== null) return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', facts);
  return null;
}

/** Step/shape rules 5-9 for a last step without a host error. */
function classifyLastStep(
  last: SessionMessage,
  facts: { steps: number; finish: unknown; error: string | null },
  stepLimit: number,
): ReviewerTaskCompletion {
  const parts = partsOf(last);
  const toolCall = parts.some((part) => part.type === 'tool');
  if (facts.steps > stepLimit) {
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      ...facts,
      reason: `more assistant steps than the configured limit ${stepLimit}`,
    });
  }
  if (facts.steps === stepLimit && facts.finish === 'stop' && !toolCall) {
    return incomplete('REVIEWER_STEP_BUDGET_EXHAUSTED', facts);
  }
  if (toolCall || facts.finish !== 'stop') {
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      ...facts,
      reason: toolCall ? 'tool call in the last step' : 'no host stop',
    });
  }
  if (!hasFinalText(parts)) return incomplete('REVIEWER_TASK_INCOMPLETE', facts);
  return { kind: 'completed', steps: facts.steps };
}

/**
 * Classify host-recorded child messages (`session.messages` response `data`).
 * Pure and total: any shape that cannot prove completion is incomplete.
 */
export function classifyReviewerTaskMessages(
  data: unknown,
  stepLimit: number = REVIEWER_STEP_LIMIT,
): ReviewerTaskCompletion {
  if (!Array.isArray(data)) {
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      steps: 0,
      finish: undefined,
      error: null,
      reason: 'messages unreadable',
    });
  }
  const entries = data as SessionMessage[];
  const isAssistantEntry = (entry: SessionMessage): boolean =>
    typeof entry === 'object' && entry !== null && entry.info?.role === 'assistant';
  const assistants = entries.filter(isAssistantEntry);
  const lastIndex = entries.reduce(
    (found, entry, index) => (isAssistantEntry(entry) ? index : found),
    -1,
  );
  const last = lastIndex === -1 ? undefined : entries[lastIndex];
  if (!last) {
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      steps: 0,
      finish: undefined,
      error: null,
      reason: 'no assistant step',
    });
  }
  const facts = { steps: assistants.length, finish: last.info?.finish, error: errorName(last) };
  const trailing = entries.slice(lastIndex + 1);
  if (trailing.length > 0) {
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      ...facts,
      reason: 'unexpected host message after the final assistant step',
    });
  }
  return classifyHostSignal(facts) ?? classifyLastStep(last, facts, stepLimit);
}
/** Read the child's host-recorded messages and classify its completion. */
export async function readReviewerTaskCompletion(
  client: OrchestratorClient,
  childSessionId: string,
): Promise<ReviewerTaskCompletion> {
  // Keep the SDK receiver: the generated client methods read `this._client`.
  const session = client.session;
  if (typeof session.messages !== 'function') {
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      steps: 0,
      finish: undefined,
      error: null,
      reason: 'messages unavailable',
    });
  }
  let response: Awaited<ReturnType<NonNullable<typeof session.messages>>>;
  try {
    response = await session.messages({ path: { id: childSessionId } });
  } catch {
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      steps: 0,
      finish: undefined,
      error: null,
      reason: 'messages error',
    });
  }
  if (response?.error !== undefined) {
    return incomplete('REVIEWER_COMPLETION_UNVERIFIABLE', {
      steps: 0,
      finish: undefined,
      error: null,
      reason: 'messages error',
    });
  }
  return classifyReviewerTaskMessages(response?.data);
}

function serializationPrompt(obligationId: string): string {
  return [
    'The independent FlowGuard review in this child session is complete.',
    'Do NOT inspect additional files, call tools, or change your conclusions.',
    'Serialize exactly the findings you concluded in the immediately preceding review as one ReviewerFindingsInput.',
    `Set attestation.toolObligationId exactly to "${obligationId}".`,
    'Preserve the original overallVerdict, findings, relations, evidence locations, missing verification, challenges, and challenge-resolution verdicts.',
    'If the completed review cannot be represented faithfully, use overallVerdict="unable_to_review" rather than inventing or repairing evidence.',
    'This prompt is serialization only; it is not a second review.',
  ].join('\n');
}

function classifyInfoError(error: unknown): BlockedFollowup | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Record<string, unknown>;
  const data =
    value.data && typeof value.data === 'object'
      ? (value.data as Record<string, unknown>)
      : undefined;
  const text = `${typeof value.message === 'string' ? value.message : ''} ${
    typeof data?.message === 'string' ? data.message : ''
  }`.toLowerCase();
  if (text.includes('thinking mode does not support this tool_choice')) {
    return {
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
      reason: `The visible ${REVIEWER_SUBAGENT_TYPE} child cannot serialize structured findings while its current reasoning mode conflicts with the host structured-output tool.`,
    };
  }
  const capabilityMismatch =
    text.includes('does not support') &&
    ['tool_choice', 'tools', 'function calling', 'structured output'].some((term) =>
      text.includes(term),
    );
  return capabilityMismatch
    ? {
        kind: 'blocked',
        code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
        reason: `The visible ${REVIEWER_SUBAGENT_TYPE} child model does not support the required structured-output serialization.`,
      }
    : null;
}

async function resolveAgent(client: OrchestratorClient): Promise<string | BlockedFollowup> {
  try {
    return await resolveReviewerAgent(client);
  } catch (error) {
    return {
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
      reason: `The required ${REVIEWER_SUBAGENT_TYPE} agent is unavailable for same-child structured serialization: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function responseFailure(response: PromptResponse): BlockedFollowup | null {
  if (response.error || !response.data) {
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
      reason: `OpenCode did not return structured findings from the visible reviewer child: ${
        response.error instanceof Error
          ? response.error.message
          : String(response.error ?? 'missing response')
      }`,
    };
  }
  if (response.data.info?.error?.name === 'StructuredOutputError') {
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      reason:
        'OpenCode rejected the reviewer structured-output serialization after its schema retry budget.',
    };
  }
  return classifyInfoError(response.data.info?.error);
}

function parseStructuredFindings(response: PromptResponse): ParsedFollowup {
  const structured = response.data?.info?.structured;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
      reason: 'OpenCode completed the reviewer follow-up without host-validated structured output.',
    };
  }
  const parsed = ReviewerFindingsInput.safeParse(structured);
  if (!parsed.success) {
    const diagnostics = buildStructuredFindingsContractDiagnostics(parsed.error.issues);
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      reason: structuredFindingsContractReason(parsed.error.issues),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }
  return { kind: 'ok', findings: { ...parsed.data } };
}

/**
 * Diagnostic timing of the structured follow-up host prompt only (agent
 * resolution, validation, and binding are excluded). A prompt that was never
 * invoked has no duration; a missing measurement is never reported as 0.
 */
export type StructuredFollowupTiming =
  | { readonly followupPromptMs: number; readonly promptOutcome: 'responded' | 'threw' }
  | { readonly followupPromptMsUnavailable: 'not_invoked' };

export type StructuredFollowupTimingObserver = (timing: StructuredFollowupTiming) => void;

/** Diagnostics never change the follow-up result or its failure path. */
function reportTiming(
  observe: StructuredFollowupTimingObserver | undefined,
  timing: StructuredFollowupTiming,
): void {
  try {
    observe?.(timing);
  } catch {
    // A failing diagnostic observer must not alter reviewer evidence handling.
  }
}

/** Serialize findings from an existing visible reviewer child. Never creates a child. */
export async function captureStructuredFindingsFromVisibleChild(
  client: OrchestratorClient,
  input: {
    readonly childSessionId: string;
    readonly obligationId: string;
    /** Obligation-bound specialization of the static findings schema. */
    readonly schema: Record<string, unknown>;
  },
  observeTiming?: StructuredFollowupTimingObserver,
): Promise<StructuredFollowupResult> {
  const agent = await resolveAgent(client);
  if (typeof agent !== 'string') {
    reportTiming(observeTiming, { followupPromptMsUnavailable: 'not_invoked' });
    return agent;
  }

  const invokedAt = new Date().toISOString();
  const promptStartedAt = performance.now();
  let promptOutcome: 'responded' | 'threw' = 'threw';
  let response: Awaited<ReturnType<OrchestratorClient['session']['prompt']>>;
  try {
    response = await client.session.prompt({
      path: { id: input.childSessionId },
      body: {
        agent,
        parts: [{ type: 'text', text: serializationPrompt(input.obligationId) }],
        format: { type: 'json_schema', schema: input.schema, retryCount: 1 },
      },
    });
    promptOutcome = 'responded';
  } finally {
    reportTiming(observeTiming, {
      followupPromptMs: Number((performance.now() - promptStartedAt).toFixed(3)),
      promptOutcome,
    });
  }

  const failure = responseFailure(response);
  if (failure) return failure;
  const parsed = parseStructuredFindings(response);
  if (parsed.kind === 'blocked') return parsed;

  return {
    kind: 'ok',
    findings: parsed.findings,
    invokedAt,
    fulfilledAt: new Date().toISOString(),
  };
}
