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

import { REVIEW_REQUIRED_PREFIX } from './enforcement/types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';
import { parseToolResult } from '../plugin-helpers.js';
import {
  REASON_HOST_SUBAGENT_TASK_REQUIRED,
  RECOVERY_HOST_SUBAGENT_TASK,
} from '../../shared/flowguard-identifiers.js';
import type { OrchestratorClient } from './types.js';

import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { extractJsonFromTextWithMethod } from './text-extraction.js';
import {
  resolveReviewerAgent,
  REVIEWER_AGENT_FALLBACK,
  REVIEWER_SYSTEM_DIRECTIVE,
} from './agent-resolution.js';

// ─── Types ───────────────────────────────────────────────────────────────────

// OrchestratorClient lives in ./types.ts to break the circular type-only
// dependency between orchestrator.ts and agent-resolution.ts.
export type { OrchestratorClient } from './types.js';

export interface ReviewerBlockedResult {
  readonly blocked: true;
  readonly code: typeof REASON_HOST_SUBAGENT_TASK_REQUIRED;
  readonly reason: string;
  readonly reviewInvocation: {
    readonly policy: 'host_task_required';
    readonly status: 'blocked_until_host_task';
    readonly code: typeof REASON_HOST_SUBAGENT_TASK_REQUIRED;
    readonly reviewerSubagentType: typeof REVIEWER_SUBAGENT_TYPE;
    readonly invocationMode: 'host_subagent_task';
    readonly hostVisible: true;
    readonly recovery: readonly [typeof RECOVERY_HOST_SUBAGENT_TASK];
  };
}

/** Result of a reviewer invocation that reached review transport. */
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

/** Result of the full orchestration (including output mutation). */
export interface OrchestrationResult {
  readonly success: boolean;
  readonly reviewerResult: ReviewerResult | null;
  readonly mutatedOutput: string | null;
  readonly error: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Prefix used in the mutated output to indicate review was completed by plugin. */
export const REVIEW_COMPLETED_PREFIX = 'INDEPENDENT_REVIEW_COMPLETED';

/** Title for the reviewer child session. */
const REVIEWER_SESSION_TITLE = 'FlowGuard Independent Review';

// ─── SDK Invocation ──────────────────────────────────────────────────────────

/** Options for controlling retry behavior of reviewer invocation. */
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
}

/**
 * Sleep utility for retry backoff. Exported for testability.
 * @internal
 */
export function retrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default retry configuration. */
const DEFAULT_INVOKE_OPTIONS: Required<InvokeReviewerOptions> = {
  reviewOutputPolicy: 'structured_required',
  reviewInvocationPolicy: 'host_task_required',
  maxRetries: 2,
  baseDelayMs: 1000,
  _sleepFn: retrySleep,
  _onAttemptFailed: () => {},
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

/**
 * Execute a format-free prompt on a child session and extract JSON findings.
 * @internal
 */
async function executeFormatFreePrompt(
  input: ExecuteFormatFreePromptInput,
): Promise<ReviewerResult | null> {
  const { client, agent, prompt, sessionId, attempt, modelCapabilityError, onFailed } = input;
  const formatFreeBody: {
    agent: string;
    parts: Array<{ type: 'text'; text: string }>;
    system?: string;
  } = {
    agent,
    parts: [{ type: 'text' as const, text: prompt }],
  };

  if (agent === REVIEWER_AGENT_FALLBACK) {
    formatFreeBody.system = REVIEWER_SYSTEM_DIRECTIVE;
  }

  const formatFreeResult = await client.session.prompt({
    path: { id: sessionId },
    body: formatFreeBody,
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
  const extractedFindings = extraction.value;

  const reviewedBy = extractedFindings.reviewedBy as Record<string, unknown> | undefined;
  if (reviewedBy && typeof reviewedBy === 'object') {
    reviewedBy.sessionId = sessionId;
  } else {
    extractedFindings.reviewedBy = { sessionId: sessionId };
  }

  return {
    sessionId,
    rawResponse: JSON.stringify(extractedFindings),
    findings: extractedFindings,
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
  if (options?.reviewInvocationPolicy === 'host_task_required') return hostTaskRequiredBlockedResult();

  const invokeOptions = { ...DEFAULT_INVOKE_OPTIONS, ...options };
  const maxAttempts = invokeOptions.maxRetries + 1;
  const agent = await resolveReviewerAgent(client);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await invokeOptions._sleepFn(invokeOptions.baseDelayMs * Math.pow(2, attempt - 2));
    const result = await invokeReviewerAttempt({ client, prompt, parentSessionId, agent, attempt, maxAttempts, options: invokeOptions });
    if (result.kind === 'retry') continue;
    return result.result;
  }

  return null;
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

  return promptReviewerSession({ ...input, childSessionId: createResult.data.id });
}

async function promptReviewerSession(
  input: InvokeAttemptInput & { childSessionId: string },
): Promise<InvokeAttemptResult> {
  const { client, prompt, agent, childSessionId, attempt, options } = input;
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

  const findings = extractStructuredFindings(info);
  if (!findings) return handleNoStructuredFindings(input, promptResult.data.parts, info);
  return { kind: 'done', result: structuredReviewerResult(childSessionId, findings) };
}

function buildStructuredPromptBody(agent: string, prompt: string) {
  const body = {
    agent,
    parts: [{ type: 'text' as const, text: prompt }],
    format: { type: 'json_schema' as const, schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
  };
  if (agent === REVIEWER_AGENT_FALLBACK) (body as { system?: string }).system = REVIEWER_SYSTEM_DIRECTIVE;
  return body;
}

function handlePromptTransportFailure(
  input: InvokeAttemptInput & { childSessionId: string },
  error: unknown,
  hasData: boolean,
): InvokeAttemptResult {
  const { agent, attempt, maxAttempts, options } = input;
  const errorObj = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
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
  const errorObj = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : { value: error };
  logInfoError(input, error, errorObj);
  const capabilityError = structuredOutputCapabilityError(errorObj);
  return capabilityError ? handleStructuredCapabilityError(input, error, capabilityError) : null;
}

function logInfoError(input: InvokeAttemptInput, error: unknown, errorObj: Record<string, unknown>): void {
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
  const structured = ['tool_choice', 'tools', 'function calling', 'structured output'].some((term) => lower.includes(term));
  return unsupported && structured ? lower.trim() : null;
}

async function handleStructuredCapabilityError(
  input: InvokeAttemptInput & { childSessionId: string },
  error: unknown,
  capabilityError: string,
): Promise<InvokeAttemptResult> {
  logCapabilityError(input, error, capabilityError);
  if (input.options.reviewOutputPolicy !== 'text_compat_allowed') return textCompatBlocked(input, error);
  await showTextCompatToast(input.client);
  const retrySessionId = await createFormatFreeRetrySession(input, error);
  if (!retrySessionId) return { kind: 'done', result: null };
  const result = await executeFormatFreePrompt({
    client: input.client,
    agent: input.agent,
    prompt: input.prompt,
    sessionId: retrySessionId,
    attempt: input.attempt,
    modelCapabilityError: capabilityError,
    onFailed: input.options._onAttemptFailed,
  });
  return { kind: 'done', result };
}

function logCapabilityError(input: InvokeAttemptInput, error: unknown, capabilityError: string): void {
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
  return { kind: 'done', result: null };
}

async function showTextCompatToast(client: OrchestratorClient): Promise<void> {
  try {
    await client.tui?.showToast({
      body: { message: 'FlowGuard Reviewer: using lower-assurance text compatibility mode', variant: 'info' },
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

function extractStructuredFindings(info: Record<string, unknown> | undefined): Record<string, unknown> | null {
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
  return parts
    ?.filter((p) => p.type === 'text' && p.text)
    .reduce((sum, p) => sum + (p.text?.length ?? 0), 0) ?? 0;
}

function structuredReviewerResult(
  childSessionId: string,
  findings: Record<string, unknown>,
): ReviewerSuccessResult {
  const reviewedBy = findings.reviewedBy as Record<string, unknown> | undefined;
  if (reviewedBy && typeof reviewedBy === 'object') reviewedBy.sessionId = childSessionId;
  else findings.reviewedBy = { sessionId: childSessionId };
  return {
    sessionId: childSessionId,
    rawResponse: JSON.stringify(findings),
    findings,
    reviewOutputMode: 'structured_output',
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high',
  };
}

// ─── Output Mutation ─────────────────────────────────────────────────────────

/**
 * Build mutated tool output with reviewer findings injected.
 * Fail-closed: requires `reviewerResult.findings` to be non-null.
 */
export function buildMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerSuccessResult,
): string | null {
  if (!reviewerResult.findings) return null;

  const parsed = parseToolResult(originalOutput);
  if (!parsed || Array.isArray(parsed)) return null;

  parsed.next =
    `${REVIEW_COMPLETED_PREFIX}: The FlowGuard plugin has automatically invoked the ` +
    `${REVIEWER_SUBAGENT_TYPE} subagent. Review findings are included in ` +
    `pluginReviewFindings. Submit your reviewVerdict based on the ` +
    `overallVerdict, and include the reviewFindings object from ` +
    `pluginReviewFindings in your flowguard_plan, flowguard_architecture, or flowguard_implement call.`;

  parsed.pluginReviewFindings = reviewerResult.findings;
  parsed._pluginReviewSessionId = reviewerResult.sessionId;
  parsed.pluginReviewOutput = {
    reviewOutputMode: reviewerResult.reviewOutputMode,
    structuredOutputUsed: reviewerResult.structuredOutputUsed,
    reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
    ...(reviewerResult.extractionMethod
      ? { extractionMethod: reviewerResult.extractionMethod }
      : {}),
    ...(reviewerResult.modelCapabilityError
      ? { modelCapabilityError: reviewerResult.modelCapabilityError }
      : {}),
  };

  return JSON.stringify(parsed);
}

/**
 * Build mutated output for content-aware standalone /review.
 */
export function buildReviewContentMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerSuccessResult,
): string | null {
  if (!reviewerResult.findings) return null;

  const parsed = parseToolResult(originalOutput);
  if (!parsed || Array.isArray(parsed)) return null;

  parsed.next =
    `PLUGIN_REVIEW_COMPLETED: The FlowGuard plugin has automatically invoked the ` +
    `${REVIEWER_SUBAGENT_TYPE} subagent. Review findings are included in ` +
    `pluginReviewFindings. Call flowguard_review again with the same content ` +
    `input (prNumber/branch/url/text) and set reviewFindings to the ` +
    `complete pluginReviewFindings object. Do NOT modify or map the findings. ` +
    `Include attestation.toolObligationId from requiredReviewAttestation.`;

  parsed.pluginReviewFindings = reviewerResult.findings;
  parsed._pluginReviewSessionId = reviewerResult.sessionId;
  parsed.pluginReviewOutput = {
    reviewOutputMode: reviewerResult.reviewOutputMode,
    structuredOutputUsed: reviewerResult.structuredOutputUsed,
    reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
    ...(reviewerResult.extractionMethod
      ? { extractionMethod: reviewerResult.extractionMethod }
      : {}),
    ...(reviewerResult.modelCapabilityError
      ? { modelCapabilityError: reviewerResult.modelCapabilityError }
      : {}),
  };

  return JSON.stringify(parsed);
}

// ─── Orchestration Detection ─────────────────────────────────────────────────

/**
 * Determine if a tool output signals INDEPENDENT_REVIEW_REQUIRED.
 */
export function isReviewRequired(toolOutput: string, toolName?: string): boolean {
  const parsed = parseToolResult(toolOutput);
  if (!parsed || Array.isArray(parsed)) return false;
  const next = typeof parsed.next === 'string' ? parsed.next : '';
  if (next.startsWith(REVIEW_REQUIRED_PREFIX)) return true;
  if (
    toolName === TOOL_FLOWGUARD_REVIEW &&
    parsed.error === true &&
    parsed.code === 'CONTENT_ANALYSIS_REQUIRED' &&
    typeof parsed.requiredReviewAttestation === 'object'
  ) {
    return true;
  }
  return false;
}

/**
 * Extract review context from a FlowGuard tool response.
 */
export function extractReviewContext(
  toolName: string,
  toolOutput: Record<string, unknown>,
): {
  iteration: number;
  planVersion: number;
  obligationId: string;
  criteriaVersion: string;
  mandateDigest: string;
} | null {
  if (toolName === TOOL_FLOWGUARD_REVIEW) return extractStandaloneReviewContext(toolOutput);
  const obligation = extractReviewObligationFields(toolOutput);
  const next = typeof toolOutput.next === 'string' ? toolOutput.next : '';
  const iteration = obligation.iteration ?? numberFromNext(next, 'iteration');
  const planVersion = obligation.planVersion ?? numberFromNext(next, 'planVersion');
  if (!obligation.obligationId || !obligation.criteriaVersion || !obligation.mandateDigest) return null;
  if (iteration === null || planVersion === null) return null;
  if (!matchesPlanSelfReviewIteration(toolName, toolOutput, iteration)) return null;
  return {
    iteration,
    planVersion,
    obligationId: obligation.obligationId,
    criteriaVersion: obligation.criteriaVersion,
    mandateDigest: obligation.mandateDigest,
  };
}

interface ExtractedReviewObligationFields {
  readonly obligationId: string | null;
  readonly criteriaVersion: string | null;
  readonly mandateDigest: string | null;
  readonly iteration: number | null;
  readonly planVersion: number | null;
}

function extractStandaloneReviewContext(
  toolOutput: Record<string, unknown>,
): ReturnType<typeof extractReviewContext> {
  const att = toolOutput.requiredReviewAttestation as Record<string, unknown> | undefined;
  const obligationId = stringValue(att?.toolObligationId);
  const mandateDigest = stringValue(att?.mandateDigest);
  const criteriaVersion = stringValue(att?.criteriaVersion);
  if (!obligationId || !mandateDigest || !criteriaVersion) return null;
  return { iteration: 1, planVersion: 1, obligationId, criteriaVersion, mandateDigest };
}

function extractReviewObligationFields(
  toolOutput: Record<string, unknown>,
): ExtractedReviewObligationFields {
  const obligation = reviewObligationObject(toolOutput);
  return {
    obligationId: stringValue(obligation?.obligationId) ?? stringValue(toolOutput.reviewObligationId),
    criteriaVersion:
      stringValue(obligation?.criteriaVersion) ?? stringValue(toolOutput.reviewCriteriaVersion),
    mandateDigest: stringValue(obligation?.mandateDigest) ?? stringValue(toolOutput.reviewMandateDigest),
    iteration: numberValue(obligation?.iteration) ?? numberValue(toolOutput.reviewObligationIteration),
    planVersion: numberValue(obligation?.planVersion) ?? numberValue(toolOutput.reviewObligationPlanVersion),
  };
}

function reviewObligationObject(toolOutput: Record<string, unknown>): Record<string, unknown> | null {
  const value = toolOutput.reviewObligation;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function numberFromNext(next: string, key: 'iteration' | 'planVersion'): number | null {
  const match = next.match(new RegExp(`${key}[=:\\s]+(\\d+)`, 'i'));
  return match ? parseInt(match[1]!, 10) : null;
}

function matchesPlanSelfReviewIteration(
  toolName: string,
  toolOutput: Record<string, unknown>,
  iteration: number,
): boolean {
  if (toolName !== TOOL_FLOWGUARD_PLAN) return true;
  const selfReviewIteration = toolOutput.selfReviewIteration;
  return typeof selfReviewIteration !== 'number' || selfReviewIteration === iteration;
}
