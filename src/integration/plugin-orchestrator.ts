/**
 * @module integration/plugin-orchestrator
 * @description Deterministic review subagent orchestration — extracted from plugin.ts.
 *
 * Invokes the flowguard-reviewer subagent via the host adapter when a
 * FlowGuard tool response signals INDEPENDENT_REVIEW_REQUIRED. Handles:
 * - Review obligation creation + audit
 * - Prompt building (plan, architecture, or impl)
 * - Subagent invocation
 * - Structured findings validation
 * - Evidence recording with reuse detection
 * - Fail-closed output mutation
 *
 * @version v2
 */

import { serializeError } from '../logging/error-serialize.js';
import { readState } from '../adapters/persistence.js';
import { getToolOutput, parseToolResult, strictBlockedOutput } from './plugin-helpers.js';
import { TOOL_FLOWGUARD_REVIEW } from './tool-names.js';
import { isReviewRequired, extractReviewContext } from './review/orchestrator.js';
import { handleHostTaskPolicy } from './review/host-task-policy.js';
import { runReviewContentPipeline } from './review/content-review-pipeline.js';
import { runStandardReviewPipeline } from './review/standard-review-pipeline.js';
import type { SessionState } from '../state/schema.js';
import type { OrchestratorDeps, ToolCallEvent, PipelineContext } from './review/pipeline-types.js';

// ─── Re-exports ───────────────────────────────────────────────────────────────

export type { OrchestratorDeps, ToolCallEvent } from './review/pipeline-types.js';

// ─── Internal types ──────────────────────────────────────────────────────────

interface ValidatedSession {
  sessionState: SessionState;
  sessDir: string;
  reviewCtx: NonNullable<ReturnType<typeof extractReviewContext>>;
  parsedOutput: Record<string, unknown>;
}

// ─── Session Validation ──────────────────────────────────────────────────────

async function validateSessionContext(
  deps: OrchestratorDeps,
  output: ToolCallEvent['output'],
  toolName: string,
  sessionId: string,
): Promise<ValidatedSession | null> {
  await deps.resolveFingerprint();
  const sessDir = deps.getSessionDir(sessionId);

  if (!sessDir) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: 'session directory unavailable for review orchestration',
    });
    return null;
  }
  const sessionState = await readState(sessDir);
  if (!sessionState) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: 'session state unavailable for review orchestration',
    });
    return null;
  }

  const rawOutput = getToolOutput(output);
  const parsedOutput = parseToolResult(rawOutput);
  if (!parsedOutput || Array.isArray(parsedOutput)) {
    output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'review-required tool output could not be parsed for orchestration',
    });
    return null;
  }
  const reviewCtx = extractReviewContext(toolName, parsedOutput);
  if (!reviewCtx) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: 'review context missing for orchestration',
    });
    return null;
  }

  return { sessionState, sessDir, reviewCtx, parsedOutput };
}

function handleOrchestrationError(
  deps: OrchestratorDeps,
  output: { output: string },
  err: unknown,
): void {
  output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
    reason: 'reviewer orchestration threw an exception',
  });
  deps.log.warn('audit', 'review orchestration failed — blocked', {
    error: serializeError(err),
  });
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Run the review orchestrator for a single tool invocation.
 *
 * Thin dispatcher that validates the session, checks host-task policy,
 * and delegates to the appropriate pipeline (content or standard).
 */
export async function runReviewOrchestration(
  deps: OrchestratorDeps,
  event: ToolCallEvent,
): Promise<void> {
  const { toolName, input, output, sessionId, now } = event;

  const inReviewPath = isReviewRequired(getToolOutput(output), toolName);
  if (!inReviewPath) return;

  try {
    const v = await validateSessionContext(deps, output, toolName, sessionId);
    if (!v) return;
    const { sessionState, sessDir, reviewCtx, parsedOutput } = v;
    const rawOutput = getToolOutput(output);

    if (await handleHostTaskPolicy(deps, sessionState, sessDir, reviewCtx, output, sessionId)) {
      return;
    }

    const ctx: PipelineContext = {
      deps,
      sessionState,
      sessDir,
      reviewCtx,
      parsedOutput,
      output,
      sessionId,
      now,
      rawOutput,
    };

    if (toolName === TOOL_FLOWGUARD_REVIEW) {
      await runReviewContentPipeline(ctx);
    } else {
      await runStandardReviewPipeline(ctx, toolName, input);
    }
  } catch (err) {
    handleOrchestrationError(deps, output, err);
  }
}
