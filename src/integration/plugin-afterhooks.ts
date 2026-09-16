/**
 * @module integration/plugin-afterhooks
 * @description After-hook processing and diagnostic logging for the
 *              FlowGuard OpenCode plugin.
 *
 * After-hook processing for diagnostics, audit finalisation, and
 * post-execution output handling. Before-hook Allow/Deny enforcement
 * remains in plugin.ts.
 *
 * Independent review is intentionally NOT auto-spawned here. A review-required
 * FlowGuard response remains pending so the parent agent invokes OpenCode's
 * native Task surface; that host-visible Task is the single productive review
 * transport and owns the child-session lifecycle.
 *
 * @version v2
 */

import { runWithAdapterLoggerAsync } from '../logging/adapter-logger.js';
import { runWithLogContextAsync } from '../logging/log-context.js';
import {
  getToolOutput,
  getAutoAdvanceOverflow,
  getSessionLockSignal,
  strictBlockedOutput,
} from './plugin-helpers.js';
import { trackFlowGuardEnforcement } from './plugin-enforcement-tracking.js';
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
import { TOOL_FLOWGUARD_HYDRATE } from './tool-names.js';
import { resumePendingSystemWork as runSystemWorkResume } from './tools/auto-validation.js';
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
      // Reconcile the FlowGuard mutation/audit boundary before the pending
      // review signal is exposed. The response itself stays untouched: native
      // Task invocation is a subsequent host-visible action, never a hidden
      // post-hook side effect.
      await runFlowGuardAuditAfter({ runtime, toolName, input, output, sessionId, hookOutput });
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
  if (ctx.toolName === TOOL_FLOWGUARD_HYDRATE)
    logHydrateLockSignal(runtime, ctx.sessionId, ctx.hookOutput);
}

function handleReviewableAfter(runtime: FlowGuardPluginRuntime, ctx: AfterHookContext): void {
  // Diagnostics observe the FlowGuard tool's own output before the pending
  // review signal is registered in transient enforcement state.
  logAutoAdvanceOverflow(runtime, ctx.sessionId, ctx.hookOutput);
}

/** Track the exact pending review signal exposed to the parent agent. */
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

/**
 * Resume interrupted canonical system work at the session lifecycle boundary.
 * `system_work` phases carry no commands, so the runtime — not a later user
 * command — owns the continuation. Fail-safe: the event handler catches.
 */
async function resumeSystemWorkForSession(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
): Promise<void> {
  const worktreeRoot = runtime.riskDeps.getWorktreeRoot?.();
  if (!worktreeRoot) return;
  const outcome = await runSystemWorkResume({
    sessionID: sessionId,
    worktree: worktreeRoot,
    directory: worktreeRoot,
  });
  if (outcome.kind === 'blocked') {
    runtime.log.error('system-work', 'system work resume blocked', {
      sessionId,
      code: outcome.code,
    });
    return;
  }
  if (outcome.kind === 'none') return;
  runtime.log.info('system-work', 'system work resume finished', {
    sessionId,
    outcome: outcome.kind,
    phase: outcome.phase,
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
      resumePendingSystemWork: (sessionId: string) =>
        resumeSystemWorkForSession(runtime, sessionId),
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
