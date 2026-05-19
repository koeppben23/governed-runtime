/**
 * @module integration/plugin-orchestrator
 * @description Deterministic review subagent orchestration — extracted from plugin.ts.
 *
 * Invokes the flowguard-reviewer subagent via the OpenCode SDK client when a
 * FlowGuard tool response signals INDEPENDENT_REVIEW_REQUIRED. Handles:
 * - Review obligation creation + audit
 * - Prompt building (plan, architecture, or impl)
 * - Subagent invocation
 * - Structured findings validation (P35 strict / non-strict)
 * - Evidence recording with reuse detection
 * - Output mutation (strict blocked or success)
 *
 * @version v2
 */

import { readState } from '../adapters/persistence.js';
import { getToolOutput, parseToolResult, strictBlockedOutput } from './plugin-helpers.js';
import { TOOL_FLOWGUARD_REVIEW } from './tool-names.js';
import { isReviewRequired, extractReviewContext } from './review/orchestrator.js';
import { handleHostTaskPolicy } from './review/host-task-policy.js';
import { runReviewContentPipeline } from './review/content-review-pipeline.js';
import { runStandardReviewPipeline } from './review/standard-review-pipeline.js';
import type { SessionState } from '../state/schema.js';
import type { OrchestratorDeps, ToolCallEvent, PipelineContext } from './review/pipeline-types.js';

// ─── Re-exports (preserving pre-refactor public API surface) ─────────────────

export type { OrchestratorDeps, ToolCallEvent } from './review/pipeline-types.js';

// ─── Internal types ──────────────────────────────────────────────────────────

interface ValidatedSession {
  sessionState: SessionState;
  sessDir: string;
  reviewCtx: NonNullable<ReturnType<typeof extractReviewContext>>;
  parsedOutput: Record<string, unknown>;
  strictEnforcement: boolean | null;
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
      reason: 'session directory unavailable for strict review orchestration',
    });
    return null;
  }
  const sessionState = await readState(sessDir);
  if (!sessionState) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: 'session state unavailable for strict review orchestration',
    });
    return null;
  }

  const rawOutput = getToolOutput(output);
  const parsedOutput = parseToolResult(rawOutput);
  if (!parsedOutput || Array.isArray(parsedOutput)) {
    output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'review-required tool output could not be parsed for strict orchestration',
    });
    return null;
  }
  const reviewCtx = extractReviewContext(toolName, parsedOutput);
  let strictEnforcement: boolean | null = null;
  if (!reviewCtx) {
    strictEnforcement = sessionState?.policySnapshot?.selfReview?.strictEnforcement === true;
    if (strictEnforcement) {
      output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
        reason: 'review context missing for strict orchestration',
      });
    }
    return null;
  }

  return { sessionState, sessDir, reviewCtx, parsedOutput, strictEnforcement };
}

function handleOrchestrationError(
  deps: OrchestratorDeps,
  inReviewPath: boolean,
  strictEnforcement: boolean | null,
  output: { output: string },
  err: unknown,
): void {
  if (inReviewPath && strictEnforcement !== false) {
    output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'reviewer orchestration threw an exception',
    });
    deps.log.warn('audit', 'review orchestration failed (strict mode blocked)', {
      error: err instanceof Error ? err.message : String(err),
    });
  } else {
    deps.log.warn('audit', 'review orchestration failed (fallback to LLM-driven)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

  let strictEnforcement: boolean | null = null;
  const inReviewPath = isReviewRequired(getToolOutput(output), toolName);
  if (!inReviewPath) return;

  try {
    const v = await validateSessionContext(deps, output, toolName, sessionId);
    if (!v) return;
    strictEnforcement = v.strictEnforcement;
    const { sessionState, sessDir, reviewCtx, parsedOutput } = v;
    const rawOutput = getToolOutput(output);

    if (await handleHostTaskPolicy(deps, sessionState, sessDir, reviewCtx, output)) {
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
      strictEnforcement: sessionState?.policySnapshot?.selfReview?.strictEnforcement === true,
    };

    if (toolName === TOOL_FLOWGUARD_REVIEW) {
      await runReviewContentPipeline(ctx, input);
    } else {
      await runStandardReviewPipeline(ctx, toolName, input);
    }
  } catch (err) {
    handleOrchestrationError(deps, inReviewPath, strictEnforcement, output, err);
  }
}
