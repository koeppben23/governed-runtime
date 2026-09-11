/**
 * @module integration/review-orchestrator
 * @description Deterministic review subagent invocation via OpenCode SDK.
 *
 * This module is the core orchestration layer for reviewer subagent invocation.
 * It handles SDK session lifecycle, retry logic, structured/text-compat output,
 * output mutation, and review detection.
 *
 * Extracted modules (FG-REL-038):
 * - review-findings-schema.ts — JSON Schema for ReviewFindings
 * - review-text-extraction.ts — Multi-strategy JSON extraction
 * - review-prompt-builders.ts — Prompt construction for all review types
 * - review-agent-resolution.ts — Agent registry probe + cache
 *
 * Contract: INDEPENDENT_REVIEW_COMPLETED is only signaled when structured
 * ReviewFindings (with overallVerdict + blockingIssues) are available.
 * Unparseable reviewer responses never produce COMPLETED.
 *
 * Conformance: Uses documented OpenCode SDK client API
 * per https://opencode.ai/docs/plugins
 *
 * @version v2
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import {
  REASON_HOST_SUBAGENT_TASK_REQUIRED,
  RECOVERY_HOST_SUBAGENT_TASK,
} from '../../shared/flowguard-identifiers.js';
import type { OrchestratorClient } from './types.js';

import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { extractStructuredOutputToolPart } from './structured-output-tool-part.js';
import { extractJsonFromTextWithMethod } from './text-extraction.js';
import { resolveReviewerAgent } from './agent-resolution.js';
import { buildTextCompatReviewerPrompt } from './prompt-builders.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type { OrchestratorClient } from './types.js';

export interface ReviewerBlockedResult {
  readonly blocked: true;
  readonly code: typeof REASON_HOST_SUBAGENT_TASK_REQUIRED | 'REVIEWER_INVOCATION_EXHAUSTED';
  readonly reason: string;
  readonly reviewInvocation:
    | {
        readonly policy: 'host_task_required';
        readonly status: 'blocked_until_host_task';
        readonly code: typeof REASON_HOST_SUBAGENT_TASK_REQUIRED;
        readonly reviewerSubagentType: typeof REVIEWER_SUBAGENT_TYPE;
        readonly invocationMode: 'host_subagent_task';
        readonly hostVisible: true;
        readonly recovery: readonly [typeof RECOVERY_HOST_SUBAGENT_TASK];
      }
    | {
        readonly policy: 'host_task_required' | 'sdk_allowed' | 'host_task_preferred';
        readonly status: 'blocked_capability_mismatch';
        readonly code: 'REVIEWER_INVOCATION_EXHAUSTED';
        readonly reviewerSubagentType: typeof REVIEWER_SUBAGENT_TYPE;
        readonly invocationMode: 'sdk_session';
        readonly hostVisible: false;
        readonly recovery: readonly [string];
      };
}

export interface ReviewerSuccessResult {
  readonly blocked?: false;
  readonly sessionId: string;
  readonly rawResponse: string;
  readonly findings: Record<string, unknown> | null;
  readonly reviewOutputMode: 'structured_output' | 'text_compat';
  readonly structuredOutputUsed: boolean;
  readonly reviewAssuranceLevel: 'structured_high' | 'text_compat_lower';
  readonly extractionMethod?: 'direct_json' | 'json_fence' | 'outermost_braces';
  readonly modelCapabilityError?: string;
}

export type ReviewerResult = ReviewerSuccessResult | ReviewerBlockedResult;

export interface OrchestrationResult {
  readonly success: boolean;
  readonly reviewerResult: ReviewerResult | null;
  readonly mutatedOutput: string | null;
  readonly error: string | null;
}

const REVIEWER_SESSION_TITLE = 'FlowGuard Independent Review';

export interface InvokeReviewerOptions {
  readonly reviewOutputPolicy?: 'structured_required' | 'text_compat_allowed';
  readonly reviewInvocationPolicy?: 'host_task_required' | 'host_task_preferred' | 'sdk_allowed';
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly _sleepFn?: (ms: number) => Promise<void>;
  readonly _onAttemptFailed?: (info: {
    attempt: number;
    step:
      | 'agent_probe'
      | 'session_create'
      | 'session_prompt'
      | 'structured_output_error'
      | 'info_error'
      | 'model_capability_incompatible'
      | 'format_free_retry_session_create'
      | 'format_free_retry_failed'
      | 'format_free_retry_empty'
      | 'format_free_retry_parse_failed'
      | 'text_compat_blocked_by_policy'
      | 'no_findings';
    error?: unknown;
    details?: Record<string, unknown>;
  }) => void;
  readonly _onAttemptSucceeded?: (info: {
    attempt: number;
    step: 'session_create' | 'session_prompt';
    parentSessionId: string;
    childSessionId: string;
    durationMs: number;
  }) => void;
}

export function retrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_INVOKE_OPTIONS: Required<InvokeReviewerOptions> = {
  reviewOutputPolicy: 'structured_required',
  reviewInvocationPolicy: 'host_task_required',
  maxRetries: 2,
  baseDelayMs: 1000,
  _sleepFn: retrySleep,
  _onAttemptFailed: () => {},
  _onAttemptSucceeded: () => {},
};

interface ExecuteFormatFreePromptInput {
  client: OrchestratorClient;
  agent: string;
  prompt: string;
  sessionId: string;
  attempt: number;
  modelCapabilityError: string;
  onFailed: (info: {
    attempt: number;
    step: 'format_free_retry_failed' | 'format_free_retry_empty' | 'format_free_retry_parse_failed';
    error?: unknown;
    details?: Record<string, unknown>;
  }) => void;
}

async function executeFormatFreePrompt(
  input: ExecuteFormatFreePromptInput,
): Promise<ReviewerResult | null> {
  const { client, agent, prompt, sessionId, attempt, modelCapabilityError, onFailed } = input;
  const formatFreeResult = await client.session.prompt({
    path: { id: sessionId },
    body: {
      agent,
      parts: [{ type: 'text' as const, text: prompt }],
    },
  });

  if (formatFreeResult.error || !formatFreeResult.data) {
    onFailed({
      attempt,
      step: 'format_free_retry_failed',
      error: formatFreeResult.error,
      details: { agent, childSessionId: sessionId },
    });
    return null;
  }

  const textContent = (formatFreeResult.data.parts ?? [])
    .filter((p: { type?: string; text?: string }) => p.type === 'text' && p.text)
    .map((p: { type?: string; text?: string }) => p.text!)
    .join('');

  if (!textContent) {
    onFailed({
      attempt,
      step: 'format_free_retry_empty',
      error: null,
      details: {
        agent,
        childSessionId: sessionId,
        partsCount: formatFreeResult.data.parts?.length ?? 0,
      },
    });
    return null;
  }

  const extraction = extractJsonFromTextWithMethod(textContent);
  if (!extraction) {
    onFailed({
      attempt,
      step: 'format_free_retry_parse_failed',
      error: null,
      details: {
        agent,
        childSessionId: sessionId,
        textLength: textContent.length,
        textPreview: textContent.slice(0, 200),
      },
    });
    return null;
  }

  return {
    sessionId,
    rawResponse: JSON.stringify(extraction.value),
    findings: extraction.value,
    reviewOutputMode: 'text_compat',
    structuredOutputUsed: false,
    reviewAssuranceLevel: 'text_compat_lower',
    extractionMethod: extraction.extractionMethod,
    modelCapabilityError,
  };
}

export async function invokeReviewer(
  client: OrchestratorClient,
  prompt: string,
  parentSessionId: string,
  options?: InvokeReviewerOptions,
): Promise<ReviewerResult | null> {
  const invokeOptions = { ...DEFAULT_INVOKE_OPTIONS, ...options };
  if (invokeOptions.reviewInvocationPolicy === 'host_task_required')
    return hostTaskRequiredBlockedResult();

  let agent: string;
  try {
    agent = await resolveReviewerAgent(client);
  } catch (error) {
    invokeOptions._onAttemptFailed({
      attempt: 0,
      step: 'agent_probe',
      error,
      details: {
        reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
        reviewInvocationPolicy: invokeOptions.reviewInvocationPolicy,
      },
    });
    return reviewerIsolationUnavailableBlockedResult(invokeOptions.reviewInvocationPolicy, error);
  }

  const maxAttempts = invokeOptions.maxRetries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1)
      await invokeOptions._sleepFn(invokeOptions.baseDelayMs * Math.pow(2, attempt - 2));
    const result = await invokeReviewerAttempt({
      client,
      prompt,
      parentSessionId,
      agent,
      attempt,
      maxAttempts,
      options: invokeOptions,
    });
    if (result.kind === 'retry') continue;
    return result.result;
  }

  return null;
}

function reviewerIsolationUnavailableBlockedResult(
  policy: 'host_task_required' | 'host_task_preferred' | 'sdk_allowed',
  error: unknown,
): ReviewerBlockedResult {
  const detail = error instanceof Error ? error.message : String(error);
  const recovery = `Install/register ${REVIEWER_SUBAGENT_TYPE} with its read-only host capability restrictions, then restart the host.`;
  return {
    blocked: true,
    code: 'REVIEWER_INVOCATION_EXHAUSTED',
    reason: `Independent review is blocked because isolated reviewer capability is unavailable: ${detail}`,
    reviewInvocation: {
      policy,
      status: 'blocked_capability_mismatch',
      code: 'REVIEWER_INVOCATION_EXHAUSTED',
      reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
      invocationMode: 'sdk_session',
      hostVisible: false,
      recovery: [recovery],
    },
  };
}

function hostTaskRequiredBlockedResult(): ReviewerBlockedResult {
  return {
    blocked: true,
    code: REASON_HOST_SUBAGENT_TASK_REQUIRED,
    reason: `Policy requires a host-visible ${REVIEWER_SUBAGENT_TYPE} invocation via the OpenCode Task tool; SDK session invocation is disabled.`,
    reviewInvocation: {
      policy: 'host_task_required',
      status: 'blocked_until_host_task',
      code: REASON_HOST_SUBAGENT_TASK_REQUIRED,
      reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      recovery: [RECOVERY_HOST_SUBAGENT_TASK],
    },
  };
}

type ResolvedInvokeOptions = Required<InvokeReviewerOptions>;

interface InvokeAttemptInput {
  readonly client: OrchestratorClient;
  readonly prompt: string;
  readonly parentSessionId: string;
  readonly agent: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly options: ResolvedInvokeOptions;
}

type InvokeAttemptResult = { kind: 'done'; result: ReviewerResult | null } | { kind: 'retry' };

async function invokeReviewerAttempt(input: InvokeAttemptInput): Promise<InvokeAttemptResult> {
  const { client, parentSessionId, attempt, maxAttempts, options } = input;
  const createStartedAt = performance.now();
  const createResult = await client.session.create({
    body: { parentID: parentSessionId, title: REVIEWER_SESSION_TITLE },
  });

  if (createResult.error || !createResult.data?.id) {
    options._onAttemptFailed({
      attempt,
      step: 'session_create',
      error: createResult.error,
      details: { hasData: !!createResult.data },
    });
    return attempt < maxAttempts ? { kind: 'retry' } : { kind: 'done', result: null };
  }

  options._onAttemptSucceeded({
    attempt,
    step: 'session_create',
    parentSessionId,
    childSessionId: createResult.data.id,
    durationMs: performance.now() - createStartedAt,
  });

  return promptReviewerSession({ ...input, childSessionId: createResult.data.id });
}

async function promptReviewerSession(
  input: InvokeAttemptInput & { childSessionId: string },
): Promise<InvokeAttemptResult> {
  const { client, prompt, agent, parentSessionId, childSessionId, attempt, options } = input;
  const promptStartedAt = performance.now();
  const promptResult = await client.session.prompt({
    path: { id: childSessionId },
    body: buildStructuredPromptBody(agent, prompt),
  });

  if (promptResult.error || !promptResult.data) {
    return handlePromptTransportFailure(input, promptResult.error, !!promptResult.data);
  }

  const info = promptResult.data.info;
  if (info?.error && info.error.name === 'StructuredOutputError') {
    options._onAttemptFailed({
      attempt,
      step: 'structured_output_error',
      error: info.error,
      details: { agent, retries: info.error.data?.retries },
    });
    return { kind: 'done', result: null };
  }

  const capabilityResult = await handleInfoError(input, info?.error);
  if (capabilityResult) return capabilityResult;

  const findings =
    extractStructuredFindings(info) ?? extractStructuredOutputToolPart(promptResult.data.parts);
  if (!findings) return handleNoStructuredFindings(input, promptResult.data.parts, info);
  options._onAttemptSucceeded({
    attempt,
    step: 'session_prompt',
    parentSessionId,
    childSessionId,
    durationMs: performance.now() - promptStartedAt,
  });
  return { kind: 'done', result: structuredReviewerResult(childSessionId, findings) };
}

function buildStructuredPromptBody(agent: string, prompt: string) {
  return {
    agent,
    parts: [{ type: 'text' as const, text: prompt }],
    format: { type: 'json_schema' as const, schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
  };
}

function handlePromptTransportFailure(
  input: InvokeAttemptInput & { childSessionId: string },
  error: unknown,
  hasData: boolean,
): InvokeAttemptResult {
  const { agent, attempt, maxAttempts, options } = input;
  const errorObj =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
  const isNonRetryable = errorObj?.isRetryable === false;
  options._onAttemptFailed({
    attempt,
    step: 'session_prompt',
    error,
    details: { hasData, agent, hasFormat: true, isNonRetryable },
  });
  if (isNonRetryable) return { kind: 'done', result: null };
  return attempt < maxAttempts ? { kind: 'retry' } : { kind: 'done', result: null };
}

async function handleInfoError(
  input: InvokeAttemptInput & { childSessionId: string },
  error: unknown,
): Promise<InvokeAttemptResult | null> {
  if (!error) return null;
  const errorObj =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : { value: error };
  logInfoError(input, error, errorObj);
  const capabilityError = structuredOutputCapabilityError(errorObj);
  return capabilityError ? handleStructuredCapabilityError(input, error, capabilityError) : null;
}

function logInfoError(
  input: InvokeAttemptInput,
  error: unknown,
  errorObj: Record<string, unknown>,
): void {
  input.options._onAttemptFailed({
    attempt: input.attempt,
    step: 'info_error',
    error,
    details: {
      agent: input.agent,
      errorName: typeof errorObj.name === 'string' ? errorObj.name : typeof error,
      errorMessage: infoErrorMessage(errorObj),
    },
  });
}

function infoErrorMessage(errorObj: Record<string, unknown>): string | undefined {
  if (typeof errorObj.message === 'string') return errorObj.message;
  return typeof errorObj.value === 'string' ? errorObj.value : undefined;
}

function structuredOutputCapabilityError(errorObj: Record<string, unknown>): string | null {
  const dataMessage =
    typeof errorObj.data === 'object' &&
    errorObj.data !== null &&
    typeof (errorObj.data as Record<string, unknown>).message === 'string'
      ? ((errorObj.data as Record<string, unknown>).message as string)
      : '';
  const lower = `${infoErrorMessage(errorObj) ?? ''} ${dataMessage}`.toLowerCase();
  const unsupported = lower.includes('does not support');
  const structured = ['tool_choice', 'tools', 'function calling', 'structured output'].some(
    (term) => lower.includes(term),
  );
  return unsupported && structured ? lower.trim() : null;
}

async function handleStructuredCapabilityError(
  input: InvokeAttemptInput & { childSessionId: string },
  error: unknown,
  capabilityError: string,
): Promise<InvokeAttemptResult> {
  logCapabilityError(input, error, capabilityError);
  if (input.options.reviewOutputPolicy !== 'text_compat_allowed')
    return textCompatBlocked(input, error);
  await showTextCompatToast(input.client);
  const retrySessionId = await createFormatFreeRetrySession(input, error);
  if (!retrySessionId) return { kind: 'done', result: null };
  const promptStartedAt = performance.now();
  const result = await executeFormatFreePrompt({
    client: input.client,
    agent: input.agent,
    prompt: buildTextCompatReviewerPrompt(input.prompt),
    sessionId: retrySessionId,
    attempt: input.attempt,
    modelCapabilityError: capabilityError,
    onFailed: input.options._onAttemptFailed,
  });
  if (result && result.blocked !== true) {
    input.options._onAttemptSucceeded({
      attempt: input.attempt,
      step: 'session_prompt',
      parentSessionId: input.parentSessionId,
      childSessionId: retrySessionId,
      durationMs: performance.now() - promptStartedAt,
    });
  }
  return { kind: 'done', result };
}

function logCapabilityError(
  input: InvokeAttemptInput,
  error: unknown,
  capabilityError: string,
): void {
  input.options._onAttemptFailed({
    attempt: input.attempt,
    step: 'model_capability_incompatible',
    error,
    details: {
      agent: input.agent,
      reason:
        'Session model does not support structured output (tool_choice/function calling). ' +
        (input.options.reviewOutputPolicy === 'text_compat_allowed'
          ? 'Creating new child session for text compatibility retry.'
          : 'Policy requires structured output.'),
      detectedPattern: capabilityError,
      reviewOutputPolicy: input.options.reviewOutputPolicy,
    },
  });
}

function textCompatBlocked(input: InvokeAttemptInput, error: unknown): InvokeAttemptResult {
  input.options._onAttemptFailed({
    attempt: input.attempt,
    step: 'text_compat_blocked_by_policy',
    error,
    details: {
      agent: input.agent,
      reviewOutputPolicy: input.options.reviewOutputPolicy,
      recovery: `Configure the ${REVIEWER_SUBAGENT_TYPE} agent to use a structured-output-capable model.`,
    },
  });
  return {
    kind: 'done',
    result: {
      blocked: true,
      code: 'REVIEWER_INVOCATION_EXHAUSTED',
      reason:
        'The configured reviewer model does not support required structured output. ' +
        `Configure ${REVIEWER_SUBAGENT_TYPE} to use a structured-output-capable model.`,
      reviewInvocation: {
        policy: input.options.reviewInvocationPolicy,
        status: 'blocked_capability_mismatch',
        code: 'REVIEWER_INVOCATION_EXHAUSTED',
        reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
        invocationMode: 'sdk_session',
        hostVisible: false,
        recovery: [`Configure ${REVIEWER_SUBAGENT_TYPE} to use a structured-output-capable model.`],
      },
    },
  };
}

async function showTextCompatToast(client: OrchestratorClient): Promise<void> {
  try {
    await client.tui?.showToast({
      body: {
        message: 'FlowGuard Reviewer: using lower-assurance text compatibility mode',
        variant: 'info',
      },
    });
  } catch {
    /* TUI unavailable — ignore */
  }
}

async function createFormatFreeRetrySession(
  input: InvokeAttemptInput & { childSessionId: string },
  error: unknown,
): Promise<string | null> {
  const retryCreateResult = await input.client.session.create({
    body: { parentID: input.parentSessionId, title: REVIEWER_SESSION_TITLE + ' (format-free)' },
  });
  if (!retryCreateResult.error && retryCreateResult.data?.id) return retryCreateResult.data.id;
  input.options._onAttemptFailed({
    attempt: input.attempt,
    step: 'format_free_retry_session_create',
    error: retryCreateResult.error ?? error,
    details: { agent: input.agent, originalSessionId: input.childSessionId },
  });
  return null;
}

function extractStructuredFindings(
  info: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const structuredRaw = info?.structured_output ?? info?.structured;
  return structuredRaw && typeof structuredRaw === 'object' && !Array.isArray(structuredRaw)
    ? (structuredRaw as Record<string, unknown>)
    : null;
}

function handleNoStructuredFindings(
  input: InvokeAttemptInput,
  parts: Array<{ type?: string; text?: string }> | undefined,
  info: Record<string, unknown> | undefined,
): InvokeAttemptResult {
  input.options._onAttemptFailed({
    attempt: input.attempt,
    step: 'no_findings',
    details: noFindingsDetails(input.agent, parts, info),
  });
  return input.attempt < input.maxAttempts ? { kind: 'retry' } : { kind: 'done', result: null };
}

function noFindingsDetails(
  agent: string,
  parts: Array<{ type?: string; text?: string }> | undefined,
  info: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    agent,
    hasInfo: !!info,
    infoError: info?.error ?? null,
    hasStructuredOutput: info ? 'structured_output' in info : false,
    hasStructured: info ? 'structured' in info : false,
    infoKeys: info ? Object.keys(info) : [],
    partsCount: parts?.length ?? 0,
    textPartsLength: textPartsLength(parts),
  };
}

function textPartsLength(parts: Array<{ type?: string; text?: string }> | undefined): number {
  return (
    parts
      ?.filter((p) => p.type === 'text' && p.text)
      .reduce((sum, p) => sum + (p.text?.length ?? 0), 0) ?? 0
  );
}

function structuredReviewerResult(
  childSessionId: string,
  findings: Record<string, unknown>,
): ReviewerSuccessResult {
  return {
    sessionId: childSessionId,
    rawResponse: JSON.stringify(findings),
    findings,
    reviewOutputMode: 'structured_output',
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high',
  };
}

export { REVIEW_COMPLETED_PREFIX } from './orchestrator-constants.js';
export { buildMutatedOutput, buildReviewContentMutatedOutput } from './orchestrator-output.js';
export { isReviewRequired, extractReviewContext } from './orchestrator-detection.js';
