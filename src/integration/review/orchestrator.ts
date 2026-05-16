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
  if (options?.reviewInvocationPolicy === 'host_task_required') {
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

  const {
    maxRetries,
    baseDelayMs,
    reviewOutputPolicy,
    _sleepFn: sleep,
    _onAttemptFailed: onFailed,
  } = {
    ...DEFAULT_INVOKE_OPTIONS,
    ...options,
  };
  const maxAttempts = maxRetries + 1;

  const agent = await resolveReviewerAgent(client);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await sleep(baseDelayMs * Math.pow(2, attempt - 2));
    }

    const createResult = await client.session.create({
      body: {
        parentID: parentSessionId,
        title: REVIEWER_SESSION_TITLE,
      },
    });

    if (createResult.error || !createResult.data?.id) {
      onFailed({
        attempt,
        step: 'session_create',
        error: createResult.error,
        details: { hasData: !!createResult.data },
      });
      if (attempt < maxAttempts) continue;
      return null;
    }

    const childSessionId = createResult.data.id;

    const body = {
      agent,
      parts: [{ type: 'text' as const, text: prompt }],
      format: { type: 'json_schema' as const, schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
    };

    if (agent === REVIEWER_AGENT_FALLBACK) {
      (body as { system?: string }).system = REVIEWER_SYSTEM_DIRECTIVE;
    }

    const promptResult = await client.session.prompt({
      path: { id: childSessionId },
      body,
    });

    if (promptResult.error || !promptResult.data) {
      const promptErrObj =
        typeof promptResult.error === 'object' && promptResult.error !== null
          ? (promptResult.error as Record<string, unknown>)
          : null;
      const isNonRetryable = promptErrObj?.isRetryable === false;

      onFailed({
        attempt,
        step: 'session_prompt',
        error: promptResult.error,
        details: { hasData: !!promptResult.data, agent, hasFormat: true, isNonRetryable },
      });

      if (isNonRetryable) return null;
      if (attempt < maxAttempts) continue;
      return null;
    }

    const info = promptResult.data.info;

    if (info?.error && info.error.name === 'StructuredOutputError') {
      onFailed({
        attempt,
        step: 'structured_output_error',
        error: info.error,
        details: { agent, retries: info.error.data?.retries },
      });
      return null;
    }

    if (info?.error) {
      const errorObj: Record<string, unknown> =
        typeof info.error === 'object' && info.error !== null ? info.error : { value: info.error };
      onFailed({
        attempt,
        step: 'info_error',
        error: info.error,
        details: {
          agent,
          errorName: typeof errorObj.name === 'string' ? errorObj.name : typeof info.error,
          errorMessage:
            typeof errorObj.message === 'string'
              ? errorObj.message
              : typeof errorObj.value === 'string'
                ? errorObj.value
                : undefined,
        },
      });

      const errMsgRaw =
        typeof errorObj.message === 'string'
          ? errorObj.message
          : typeof errorObj.value === 'string'
            ? errorObj.value
            : '';
      const errDataMsg =
        typeof errorObj.data === 'object' &&
        errorObj.data !== null &&
        typeof (errorObj.data as Record<string, unknown>).message === 'string'
          ? ((errorObj.data as Record<string, unknown>).message as string)
          : '';
      const errMsgLower = `${errMsgRaw} ${errDataMsg}`.toLowerCase();

      if (
        errMsgLower.includes('does not support') &&
        (errMsgLower.includes('tool_choice') ||
          errMsgLower.includes('tools') ||
          errMsgLower.includes('function calling') ||
          errMsgLower.includes('structured output'))
      ) {
        const capabilityError = errMsgLower.trim();

        onFailed({
          attempt,
          step: 'model_capability_incompatible',
          error: info.error,
          details: {
            agent,
            reason:
              'Session model does not support structured output (tool_choice/function calling). ' +
              (reviewOutputPolicy === 'text_compat_allowed'
                ? 'Creating new child session for text compatibility retry.'
                : 'Policy requires structured output.'),
            detectedPattern: capabilityError,
            reviewOutputPolicy,
          },
        });

        if (reviewOutputPolicy !== 'text_compat_allowed') {
          onFailed({
            attempt,
            step: 'text_compat_blocked_by_policy',
            error: info.error,
            details: {
              agent,
              reviewOutputPolicy,
              recovery: `Configure the ${REVIEWER_SUBAGENT_TYPE} agent to use a structured-output-capable model.`,
            },
          });
          return null;
        }

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

        const retryCreateResult = await client.session.create({
          body: {
            parentID: parentSessionId,
            title: REVIEWER_SESSION_TITLE + ' (format-free)',
          },
        });

        if (retryCreateResult.error || !retryCreateResult.data?.id) {
          onFailed({
            attempt,
            step: 'format_free_retry_session_create',
            error: retryCreateResult.error,
            details: { agent, originalSessionId: childSessionId },
          });
          return null;
        }

        const retrySessionId = retryCreateResult.data.id;

        const result = await executeFormatFreePrompt({
          client,
          agent,
          prompt,
          sessionId: retrySessionId,
          attempt,
          modelCapabilityError: capabilityError,
          onFailed,
        });
        if (result) return result;
        return null;
      }
    }

    let findings: Record<string, unknown> | null = null;

    const structuredRaw = info?.structured_output ?? info?.structured;
    if (structuredRaw && typeof structuredRaw === 'object' && !Array.isArray(structuredRaw)) {
      findings = structuredRaw as Record<string, unknown>;
    }

    if (!findings) {
      onFailed({
        attempt,
        step: 'no_findings',
        details: {
          agent,
          hasInfo: !!info,
          infoError: info?.error ?? null,
          hasStructuredOutput: info ? 'structured_output' in info : false,
          hasStructured: info ? 'structured' in info : false,
          infoKeys: info ? Object.keys(info) : [],
          partsCount: promptResult.data.parts?.length ?? 0,
          textPartsLength:
            promptResult.data.parts
              ?.filter((p: { type?: string; text?: string }) => p.type === 'text' && p.text)
              .reduce((sum: number, p: { text?: string }) => sum + (p.text?.length ?? 0), 0) ?? 0,
        },
      });
      if (attempt < maxAttempts) continue;
      return null;
    }

    const reviewedBy = findings.reviewedBy as Record<string, unknown> | undefined;
    if (reviewedBy && typeof reviewedBy === 'object') {
      reviewedBy.sessionId = childSessionId;
    } else {
      findings.reviewedBy = { sessionId: childSessionId };
    }

    return {
      sessionId: childSessionId,
      rawResponse: JSON.stringify(findings),
      findings,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
    };
  }

  return null;
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
  if (toolName === TOOL_FLOWGUARD_REVIEW) {
    const att = toolOutput.requiredReviewAttestation as Record<string, unknown> | undefined;
    if (!att) return null;
    const obligationId = typeof att.toolObligationId === 'string' ? att.toolObligationId : '';
    const mandateDigest = typeof att.mandateDigest === 'string' ? att.mandateDigest : '';
    const criteriaVersion = typeof att.criteriaVersion === 'string' ? att.criteriaVersion : '';
    if (!obligationId || !mandateDigest || !criteriaVersion) return null;
    return {
      iteration: 1,
      planVersion: 1,
      obligationId,
      criteriaVersion,
      mandateDigest,
    };
  }

  const obl = toolOutput.reviewObligation as
    | {
        obligationId?: unknown;
        obligationType?: unknown;
        iteration?: unknown;
        planVersion?: unknown;
        criteriaVersion?: unknown;
        mandateDigest?: unknown;
      }
    | undefined;

  const obligationId =
    (obl?.obligationId as string | undefined) ??
    (typeof toolOutput.reviewObligationId === 'string' ? toolOutput.reviewObligationId : null);
  const criteriaVersion =
    (obl?.criteriaVersion as string | undefined) ??
    (typeof toolOutput.reviewCriteriaVersion === 'string'
      ? toolOutput.reviewCriteriaVersion
      : null);
  const mandateDigest =
    (obl?.mandateDigest as string | undefined) ??
    (typeof toolOutput.reviewMandateDigest === 'string' ? toolOutput.reviewMandateDigest : null);

  let iteration: number | null =
    (obl?.iteration as number | undefined) ??
    (typeof toolOutput.reviewObligationIteration === 'number'
      ? toolOutput.reviewObligationIteration
      : null);
  let planVersion: number | null =
    (obl?.planVersion as number | undefined) ??
    (typeof toolOutput.reviewObligationPlanVersion === 'number'
      ? toolOutput.reviewObligationPlanVersion
      : null);

  const next = typeof toolOutput.next === 'string' ? toolOutput.next : '';

  if (iteration === null) {
    const match = next.match(/iteration[=:\s]+(\d+)/i);
    if (!match) return null;
    iteration = parseInt(match[1]!, 10);
  }
  if (planVersion === null) {
    const match = next.match(/planVersion[=:\s]+(\d+)/i);
    if (!match) return null;
    planVersion = parseInt(match[1]!, 10);
  }

  if (!obligationId || !criteriaVersion || !mandateDigest) return null;

  if (toolName === TOOL_FLOWGUARD_PLAN) {
    const selfReviewIteration = toolOutput.selfReviewIteration;
    if (typeof selfReviewIteration === 'number' && selfReviewIteration !== iteration) {
      return null;
    }
  }

  return { iteration, planVersion, obligationId, criteriaVersion, mandateDigest };
}
