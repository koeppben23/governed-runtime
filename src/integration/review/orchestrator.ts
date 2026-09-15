/**
 * @module integration/review-orchestrator
 * @description Deterministic review subagent invocation via OpenCode SDK.
 *
 * This module is the core orchestration layer for reviewer subagent invocation.
 * It handles SDK session lifecycle, retry logic, structured output, output
 * mutation, and review detection.
 *
 * Extracted modules (FG-REL-038):
 * - review-findings-schema.ts — JSON Schema for ReviewFindings
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
import { ReviewerFindingsInput } from '../../state/evidence-review-input.js';
import type { OrchestratorClient } from './types.js';

import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { resolveReviewerAgent } from './agent-resolution.js';
import {
  abortReviewerSession,
  DEFAULT_REVIEWER_PROMPT_TIMEOUT_MS,
  raceWithTimeout,
  REVIEWER_PROMPT_TIMEOUT_CODE,
} from './prompt-timeout.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type { OrchestratorClient } from './types.js';

export interface ReviewerBlockedResult {
  readonly blocked: true;
  readonly code:
    | 'REVIEWER_INVOCATION_EXHAUSTED'
    | 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE'
    | 'HOST_STRUCTURED_OUTPUT_REQUIRED'
    | 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION';
  readonly reason: string;
  readonly reviewInvocation: {
    readonly status: 'blocked_capability_mismatch' | 'host_contract_violation';
    readonly code: string;
    readonly reviewerSubagentType: typeof REVIEWER_SUBAGENT_TYPE;
    readonly invocationMode: 'sdk_session';
    readonly recovery: readonly [string];
  };
}

export interface ReviewerSuccessResult {
  readonly blocked?: false;
  readonly sessionId: string;
  readonly rawResponse: string;
  readonly findings: Record<string, unknown> | null;
  readonly reviewOutputMode: 'structured_output';
  readonly structuredOutputUsed: boolean;
  readonly reviewAssuranceLevel: 'structured_high';
  /** Host-observed lifecycle timestamps for the successful reviewer prompt. */
  readonly invokedAt?: string;
  readonly fulfilledAt?: string;
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
  /** Technical retries within one ReviewAttempt. */
  readonly maxTransportRetries?: number;
  readonly baseDelayMs?: number;
  /**
   * Maximum time to wait for a reviewer `session.prompt` before classifying the
   * attempt as a retryable timeout and aborting the child session best-effort.
   * `0` or non-finite disables the bound.
   */
  readonly promptTimeoutMs?: number;
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
  maxTransportRetries: 2,
  baseDelayMs: 1000,
  promptTimeoutMs: DEFAULT_REVIEWER_PROMPT_TIMEOUT_MS,
  _sleepFn: retrySleep,
  _onAttemptFailed: () => {},
  _onAttemptSucceeded: () => {},
};

export async function invokeReviewer(
  client: OrchestratorClient,
  prompt: string,
  parentSessionId: string,
  options?: InvokeReviewerOptions,
): Promise<ReviewerResult | null> {
  const invokeOptions = { ...DEFAULT_INVOKE_OPTIONS, ...options };
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
      },
    });
    return reviewerIsolationUnavailableBlockedResult(error);
  }

  const maxAttempts = invokeOptions.maxTransportRetries + 1;
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

function reviewerIsolationUnavailableBlockedResult(error: unknown): ReviewerBlockedResult {
  const detail = error instanceof Error ? error.message : String(error);
  const recovery = `Install/register ${REVIEWER_SUBAGENT_TYPE} with its read-only host capability restrictions, then restart the host.`;
  return {
    blocked: true,
    code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
    reason: `Independent review is blocked because isolated reviewer capability is unavailable: ${detail}`,
    reviewInvocation: {
      status: 'blocked_capability_mismatch',
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
      reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
      invocationMode: 'sdk_session',
      recovery: [recovery],
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
  const invokedAt = new Date().toISOString();
  const race = await raceWithTimeout(
    client.session.prompt({
      path: { id: childSessionId },
      body: buildStructuredPromptBody(agent, prompt),
    }),
    options.promptTimeoutMs,
  );

  if (race.kind === 'timed_out') {
    return handlePromptTimeout(input, childSessionId);
  }

  const promptResult = race.value;

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

  const findings = extractStructuredFindings(info);
  if (!findings) return handleNoStructuredFindings(input, promptResult.data.parts, info);
  if (!ReviewerFindingsInput.safeParse(findings).success) {
    return { kind: 'done', result: hostStructuredOutputContractViolation(input.agent) };
  }
  options._onAttemptSucceeded({
    attempt,
    step: 'session_prompt',
    parentSessionId,
    childSessionId,
    durationMs: performance.now() - promptStartedAt,
  });
  return {
    kind: 'done',
    result: structuredReviewerResult(childSessionId, findings, invokedAt, new Date().toISOString()),
  };
}

function buildStructuredPromptBody(agent: string, prompt: string) {
  return {
    agent,
    parts: [{ type: 'text' as const, text: prompt }],
    format: { type: 'json_schema' as const, schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
  };
}

/** Classify a reviewer prompt timeout and abort the child session best-effort. */
async function handlePromptTimeout(
  input: InvokeAttemptInput & { childSessionId: string },
  childSessionId: string,
): Promise<InvokeAttemptResult> {
  const { client, agent, attempt, maxAttempts, options } = input;
  await abortReviewerSession(client, childSessionId);
  options._onAttemptFailed({
    attempt,
    step: 'session_prompt',
    error: { code: REVIEWER_PROMPT_TIMEOUT_CODE, isRetryable: true },
    details: { agent, childSessionId, timeoutMs: options.promptTimeoutMs },
  });
  return attempt < maxAttempts ? { kind: 'retry' } : { kind: 'done', result: null };
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
  return structuredOutputBlocked(input);
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
      reason: 'Session model does not support required structured output.',
      detectedPattern: capabilityError,
      recovery: `Configure the ${REVIEWER_SUBAGENT_TYPE} agent to use a structured-output-capable model.`,
    },
  });
}

function structuredOutputBlocked(_input: InvokeAttemptInput): InvokeAttemptResult {
  return {
    kind: 'done',
    result: {
      blocked: true,
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
      reason:
        'The configured reviewer model does not support required structured output. ' +
        `Configure ${REVIEWER_SUBAGENT_TYPE} to use a structured-output-capable model.`,
      reviewInvocation: {
        status: 'blocked_capability_mismatch',
        code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
        reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
        invocationMode: 'sdk_session',
        recovery: [`Configure ${REVIEWER_SUBAGENT_TYPE} to use a structured-output-capable model.`],
      },
    },
  };
}

function extractStructuredFindings(
  info: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const structuredRaw = info?.structured;
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
  return { kind: 'done', result: hostStructuredOutputRequired(input.agent) };
}

function hostStructuredOutputRequired(agent: string): ReviewerBlockedResult {
  return {
    blocked: true,
    code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
    reason: 'OpenCode did not return the required host-validated structured reviewer output.',
    reviewInvocation: {
      status: 'host_contract_violation',
      code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
      reviewerSubagentType: agent as typeof REVIEWER_SUBAGENT_TYPE,
      invocationMode: 'sdk_session',
      recovery: [
        'Use the validated OpenCode host version and a structured-output-capable reviewer model.',
      ],
    },
  };
}

function hostStructuredOutputContractViolation(agent: string): ReviewerBlockedResult {
  return {
    blocked: true,
    code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
    reason:
      "OpenCode returned structured reviewer output that violates FlowGuard's canonical input schema.",
    reviewInvocation: {
      status: 'host_contract_violation',
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      reviewerSubagentType: agent as typeof REVIEWER_SUBAGENT_TYPE,
      invocationMode: 'sdk_session',
      recovery: [
        'Align the OpenCode structured-output contract with the validated FlowGuard schema.',
      ],
    },
  };
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
  invokedAt: string,
  fulfilledAt: string,
): ReviewerSuccessResult {
  return {
    sessionId: childSessionId,
    rawResponse: JSON.stringify(findings),
    findings,
    reviewOutputMode: 'structured_output',
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high',
    invokedAt,
    fulfilledAt,
  };
}

export { REVIEW_COMPLETED_PREFIX } from './orchestrator-constants.js';
export { buildMutatedOutput, buildReviewContentMutatedOutput } from './orchestrator-output.js';
export { isReviewRequired, extractReviewContext } from './orchestrator-detection.js';
