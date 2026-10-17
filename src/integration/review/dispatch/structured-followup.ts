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
 * binding.
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { ReviewerFindingsInput } from '../../../state/evidence-review-input.js';
import { REVIEW_FINDINGS_JSON_SCHEMA } from '../evidence/findings-schema.js';
import { resolveReviewerAgent } from './agent-resolution.js';
import type { OrchestratorClient, PendingReviewRetryDiagnostic } from '../types.js';
import { REVIEWER_STEP_LIMIT } from '../../../templates/mandates-reviewer-criteria.js';
import type { StructuredFollowupFailureCode } from './native-task-review-types.js';
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

export type ReviewerStepBudgetState = 'exhausted' | 'ambiguous' | 'not_exhausted';

/** Why the host step-budget state could not be established. */
export type ReviewerStepBudgetDetail =
  'messages_unavailable' | 'messages_error' | 'unreadable_messages' | 'limit_without_host_stop';

export interface ReviewerStepBudgetDetection {
  readonly state: ReviewerStepBudgetState;
  readonly detail?: ReviewerStepBudgetDetail;
}

/**
 * Verify a HOST-enforced reviewer step-budget stop before the structured
 * follow-up runs. Proof requires all of: the child's assistant-step count
 * equals the configured reviewer step limit, the last host-recorded step
 * finished with `stop`, and it made no tool call.
 *
 * Only a child below the limit proceeds on the normal capture path. A verified
 * host stop is retryable on the same frozen obligation. Anything ambiguous is
 * NEVER treated as a completed review and NEVER retried automatically: the
 * caller fails closed because required host evidence is unavailable.
 */
type SessionMessage = {
  readonly info?: { readonly role?: string; readonly finish?: string };
  readonly parts?: readonly { readonly type?: string }[];
};

function assistantMessages(data: readonly SessionMessage[]): readonly SessionMessage[] {
  return data.filter((entry) => entry.info?.role === 'assistant');
}

/** Host-recorded stop of the last assistant step, without further tool work. */
function stoppedWithoutToolCall(message: SessionMessage | undefined): boolean {
  if (message?.info?.finish !== 'stop') return false;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return !parts.some((part) => part?.type === 'tool');
}

export async function detectReviewerStepBudgetExhaustion(
  client: OrchestratorClient,
  childSessionId: string,
): Promise<ReviewerStepBudgetDetection> {
  // Keep the SDK receiver: the generated client methods read `this._client`.
  const session = client.session;
  if (typeof session.messages !== 'function') {
    return { state: 'ambiguous', detail: 'messages_unavailable' };
  }
  let response: Awaited<ReturnType<NonNullable<typeof session.messages>>>;
  try {
    response = await session.messages({ path: { id: childSessionId } });
  } catch {
    return { state: 'ambiguous', detail: 'messages_error' };
  }
  if (response?.error !== undefined) return { state: 'ambiguous', detail: 'messages_error' };
  if (!Array.isArray(response?.data)) {
    return { state: 'ambiguous', detail: 'unreadable_messages' };
  }
  const assistants = assistantMessages(response.data);
  // A child below the limit still has steps to serialize findings; a child
  // above it proves the limit did not stop it.
  if (assistants.length !== REVIEWER_STEP_LIMIT) return { state: 'not_exhausted' };
  return stoppedWithoutToolCall(assistants.at(-1))
    ? { state: 'exhausted' }
    : { state: 'ambiguous', detail: 'limit_without_host_stop' };
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
  input: { readonly childSessionId: string; readonly obligationId: string },
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
        format: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
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
