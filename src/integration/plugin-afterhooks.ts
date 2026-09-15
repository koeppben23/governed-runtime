/**
 * @module integration/plugin-afterhooks
 * @description After-hook processing and diagnostic logging for the
 *              FlowGuard OpenCode plugin.
 *
 * After-hook processing for diagnostics, audit finalisation, and
 * post-execution output handling. Before-hook Allow/Deny enforcement
 * remains in plugin.ts.
 *
 * @version v1
 */

import { runWithAdapterLoggerAsync } from '../logging/adapter-logger.js';
import { runWithLogContextAsync } from '../logging/log-context.js';
import {
  getToolOutput,
  isNativeEnforcementUnavailableDenial,
  getAutoAdvanceOverflow,
  getSessionLockSignal,
  getHostTaskFindingsRejection,
  getReviewIdentityRejection,
  getNativeAttestationRejection,
  strictBlockedOutput,
} from './plugin-helpers.js';
import { trackFlowGuardEnforcement } from './plugin-enforcement-tracking.js';
import { runReviewOrchestration as runOrchestrator } from './plugin-orchestrator.js';
import { runAudit as runAuditModule } from './plugin-audit.js';
import { handleEvent, type EventHandlerDeps } from './plugin-events.js';
import { appendReviewAuditEventForState } from './review/audit-events.js';
import { readState } from '../adapters/persistence.js';
import { buildCompactionContext, type CompactionDeps } from './plugin-compaction.js';
import {
  isReviewableFlowGuardTool,
  updateCheckReworkContinuation,
} from './plugin-rework-continuation.js';
export { updateCheckReworkContinuation } from './plugin-rework-continuation.js';
import {
  REASON_PLUGIN_ENFORCEMENT_UNAVAILABLE,
  REVIEW_ACCEPTANCE_PATH_NATIVE,
  REASON_SESSION_LOCK_CONTENDED,
  DIAGNOSTIC_SESSION_LOCK_WAITED,
} from '../shared/flowguard-identifiers.js';
import type { ToolHookAfterInput, ToolHookAfterOutput } from './types.js';
import {
  FG_PREFIX,
  cleanupSessionRuntime,
  getToolTraceId,
  type FlowGuardPluginRuntime,
} from './plugin-shared.js';
import {
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_HYDRATE,
} from './tool-names.js';
import { enforceRiskClassificationAfterBash as enforceRiskAfterBash } from './plugin-risk.js';
import { enforceDiscoveryHealthAfterBash } from './plugin-discovery-health.js';
import { recordMutationCompletion } from './plugin-mutation-episodes.js';

export async function toolAfter(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
  output: unknown,
): Promise<void> {
  return runWithAdapterLoggerAsync(runtime.adapterLog, async () => {
    const hookInput = input as ToolHookAfterInput;
    const hookOutput = output as ToolHookAfterOutput;
    // Stryker disable next-line OptionalChaining
    const toolName = hookInput?.tool ?? '';
    // Stryker disable next-line OptionalChaining
    const sessionId = hookInput?.sessionID ?? 'unknown';
    const traceId = getToolTraceId(runtime, input, 'after');
    return runWithLogContextAsync({ traceId, sessionId }, async () => {
      const now = new Date().toISOString();
      // Stryker disable next-line ObjectLiteral
      runtime.log.info('hook', 'tool.execute.after', {
        tool: toolName,
      });
      const afterCtx: AfterHookContext = {
        toolName,
        sessionId,
        input,
        hookInput,
        hookOutput,
        now,
      };
      await handleAfterDiagnostics(runtime, afterCtx);
      await recordMutationCompletion({ runtime, ...afterCtx });
      await handleBashAfter(runtime, toolName, sessionId, hookOutput);
      // The durable transition outbox must be reconciled BEFORE the orchestrator
      // may persist its post-commit side effects (obligations, attempts):
      // otherwise the operation's committed postStateDigest no longer matches
      // the persisted state and the mutation cycle would fail closed.
      await runFlowGuardAuditAfter({ runtime, toolName, input, output, sessionId, hookOutput });
      await runOrchestrator(runtime.orchestratorDeps, {
        toolName,
        input,
        output: hookOutput,
        sessionId,
        now,
      });
      await updateCheckReworkContinuation(runtime, toolName, sessionId);
      trackReviewableEnforcement(runtime, afterCtx);
    });
  });
}

interface AfterHookContext {
  readonly toolName: string;
  readonly sessionId: string;
  readonly input: unknown;
  readonly hookInput: ToolHookAfterInput;
  readonly hookOutput: ToolHookAfterOutput;
  readonly now: string;
}

async function handleAfterDiagnostics(
  runtime: FlowGuardPluginRuntime,
  ctx: AfterHookContext,
): Promise<void> {
  if (isReviewableFlowGuardTool(ctx.toolName)) {
    handleReviewableAfter(runtime, ctx);
    return;
  }
  // Stryker disable next-line ConditionalExpression
  if (ctx.toolName === TOOL_FLOWGUARD_CONTINUE)
    logIdentityRejection(runtime, ctx.sessionId, ctx.hookOutput);
  // Stryker disable next-line ConditionalExpression
  if (ctx.toolName === TOOL_FLOWGUARD_HYDRATE)
    logHydrateLockSignal(runtime, ctx.sessionId, ctx.hookOutput);
}

function handleReviewableAfter(runtime: FlowGuardPluginRuntime, ctx: AfterHookContext): void {
  // Diagnostics observe the tool's own output before the orchestration result is tracked.
  logNativeEnforcementDenial(runtime, ctx.sessionId, ctx.hookOutput);
  logHostTaskRejection(runtime, ctx.sessionId, ctx.hookOutput);
  logIdentityRejection(runtime, ctx.sessionId, ctx.hookOutput);
  // Stryker disable next-line ConditionalExpression
  if (ctx.toolName === TOOL_FLOWGUARD_REVIEW)
    logNativeAttestationRejection(runtime, ctx.sessionId, ctx.hookOutput);
  logAutoAdvanceOverflow(runtime, ctx.sessionId, ctx.hookOutput);
}

/**
 * Track review enforcement against the output the agent actually receives.
 *
 * Must run AFTER orchestration because it attaches the review attempt identity
 * emitted by the SDK review pipeline.
 */
function trackReviewableEnforcement(runtime: FlowGuardPluginRuntime, ctx: AfterHookContext): void {
  // Stryker disable next-line ConditionalExpression
  if (!isReviewableFlowGuardTool(ctx.toolName)) return;
  try {
    trackFlowGuardEnforcement(
      runtime.ws.getEnforcementState(ctx.sessionId),
      ctx.toolName,
      ctx.input,
      ctx.hookOutput,
      ctx.now,
    );
    // Stryker disable next-line BlockStatement
  } catch (err) {
    runtime.logError('enforcement tracking failed', err);
  }
}

function logNativeEnforcementDenial(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  hookOutput: ToolHookAfterOutput,
): void {
  // Stryker disable next-line ConditionalExpression
  if (!isNativeEnforcementUnavailableDenial(getToolOutput(hookOutput))) return;
  // Stryker disable next-line ObjectLiteral
  runtime.log.warn('review', 'native review acceptance denied: plugin enforcement unavailable', {
    path: REVIEW_ACCEPTANCE_PATH_NATIVE,
    reason: REASON_PLUGIN_ENFORCEMENT_UNAVAILABLE,
    sessionId,
  });
}

function logHostTaskRejection(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  hookOutput: ToolHookAfterOutput,
): void {
  const rejection = getHostTaskFindingsRejection(getToolOutput(hookOutput));
  if (!rejection) return;
  // Stryker disable next-line ObjectLiteral
  runtime.log.warn('review', 'host-task findings rejected by shared guard', {
    sessionId,
    path: rejection.path,
    reason: rejection.reason,
    status: rejection.status,
    ...(rejection.obligationId ? { obligationId: rejection.obligationId } : {}),
  });
}

function logIdentityRejection(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  hookOutput: ToolHookAfterOutput,
): void {
  const rejection = getReviewIdentityRejection(getToolOutput(hookOutput));
  if (!rejection) return;
  runtime.log.warn('review', 'self-review rejected', {
    sessionId,
    reason: rejection.reason,
    ...(rejection.obligationId ? { obligationId: rejection.obligationId } : {}),
  });
}

function logNativeAttestationRejection(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  hookOutput: ToolHookAfterOutput,
): void {
  const rejection = getNativeAttestationRejection(getToolOutput(hookOutput));
  if (!rejection) return;
  runtime.log.warn('review', 'native attestation not upgraded', {
    sessionId,
    reason: rejection.reason,
    ...(rejection.obligationId ? { obligationId: rejection.obligationId } : {}),
  });
}

function logAutoAdvanceOverflow(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  hookOutput: ToolHookAfterOutput,
): void {
  const overflow = getAutoAdvanceOverflow(getToolOutput(hookOutput));
  if (!overflow) return;
  runtime.log.error('autoAdvance', 'auto-advance overflow: topology may be non-terminating', {
    sessionId,
    phase: overflow.phase,
    limit: overflow.limit,
  });
}

function logHydrateLockSignal(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  hookOutput: ToolHookAfterOutput,
): void {
  const lockSignal = getSessionLockSignal(getToolOutput(hookOutput));
  if (lockSignal === 'contended') {
    runtime.log.error('hydrate', 'session write lock contended: hydrate blocked', {
      sessionId,
      reason: REASON_SESSION_LOCK_CONTENDED,
    });
  } else if (lockSignal === 'waited') {
    runtime.log.warn('hydrate', 'session write lock contended: waited for concurrent holder', {
      sessionId,
      reason: DIAGNOSTIC_SESSION_LOCK_WAITED,
    });
  }
}

async function handleBashAfter(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  hookOutput: ToolHookAfterOutput,
): Promise<void> {
  // Stryker disable next-line ConditionalExpression
  if (toolName !== 'bash') return;
  await enforceRiskAfterBash(runtime.riskDeps, sessionId, hookOutput);
  await enforceDiscoveryHealthAfterBash(runtime.discoveryHealthDeps, sessionId, hookOutput);
}

async function runFlowGuardAuditAfter(args: {
  runtime: FlowGuardPluginRuntime;
  toolName: string;
  input: unknown;
  output: unknown;
  sessionId: string;
  hookOutput: ToolHookAfterOutput;
}): Promise<void> {
  const { runtime, toolName, input, output, sessionId, hookOutput } = args;
  if (!toolName.startsWith(FG_PREFIX)) return;
  await runtime.ws.runSerializedForSession(sessionId, async () => {
    const auditResult = await runAuditModule(runtime.auditDeps, toolName, input, output, sessionId);
    if (auditResult?.block) {
      // Stryker disable next-line ObjectLiteral
      hookOutput.output = strictBlockedOutput(auditResult.code!, {
        reason: auditResult.reason ?? 'audit persistence failed',
      });
    }
  });
}

export async function handlePluginEvent(
  runtime: FlowGuardPluginRuntime,
  event: unknown,
): Promise<void> {
  return runWithAdapterLoggerAsync(runtime.adapterLog, async () => {
    const eventDeps: EventHandlerDeps = {
      log: runtime.log,
      cleanupSession: (sessionId: string) => cleanupSessionRuntime(runtime, sessionId),
      async emitSessionErrorAudit(sessionId, errorMessage, detail) {
        const sessDir = runtime.ws.getSessionDir(sessionId);
        if (!sessDir) return;
        const state = await readState(sessDir);
        // Without durable session identity there is no canonical audit event
        // to append. The outer event handler remains fail-safe for the host.
        if (!state) return;
        // Stryker disable next-line ObjectLiteral
        await appendReviewAuditEventForState(sessDir, sessionId, state, 'error:SESSION_ERROR', {
          code: 'SESSION_ERROR',
          message: errorMessage,
          ...detail,
        });
      },
    };
    await handleEvent(eventDeps, event as Parameters<typeof handleEvent>[1]);
  });
}

export async function handleCompaction(
  runtime: FlowGuardPluginRuntime,
  input: { sessionID?: string },
  output: { context: string[] },
): Promise<void> {
  return runWithAdapterLoggerAsync(runtime.adapterLog, async () => {
    const sessionId = input.sessionID ?? '';
    // Stryker disable next-line ConditionalExpression
    if (!sessionId) return;
    const compactionDeps: CompactionDeps = {
      getSessionDir: runtime.ws.getSessionDir,
      log: runtime.log,
    };
    const context = await buildCompactionContext(compactionDeps, sessionId);
    if (context) output.context.push(context);
  });
}
