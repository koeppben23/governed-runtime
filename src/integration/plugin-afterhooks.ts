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
  getToolArgs,
  getToolOutput,
  isNativeEnforcementUnavailableDenial,
  getAutoAdvanceOverflow,
  getSessionLockSignal,
  getHostTaskFindingsRejection,
  getReviewIdentityRejection,
  getNativeAttestationRejection,
} from './plugin-helpers.js';
import { trackFlowGuardEnforcement } from './plugin-enforcement-tracking.js';
import { runReviewOrchestration as runOrchestrator } from './plugin-orchestrator.js';
import { runAudit as runAuditModule } from './plugin-audit.js';
import { handleEvent, type EventHandlerDeps } from './plugin-events.js';
import { appendReviewAuditEvent } from './review/audit-events.js';
import { readState } from '../adapters/persistence.js';
import { buildCompactionContext, type CompactionDeps } from './plugin-compaction.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';
import { handleHostTaskEvidence } from './plugin-task-evidence.js';
import {
  REASON_PLUGIN_ENFORCEMENT_UNAVAILABLE,
  REVIEW_ACCEPTANCE_PATH_NATIVE,
  REASON_SESSION_LOCK_CONTENDED,
  DIAGNOSTIC_SESSION_LOCK_WAITED,
} from '../shared/flowguard-identifiers.js';
import {
  resolveSubagentSessionId,
  injectSessionIdIntoOutput,
} from './review/enforcement/extraction.js';
import type { ToolHookAfterInput, ToolHookAfterOutput } from './types.js';
import { FG_PREFIX, getToolTraceId, type FlowGuardPluginRuntime } from './plugin-shared.js';
import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_HYDRATE,
} from './tool-names.js';
import { enforceRiskClassificationAfterBash as enforceRiskAfterBash } from './plugin-risk.js';
import { enforceDiscoveryHealthAfterBash } from './plugin-discovery-health.js';
import { trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import { strictBlockedOutput, getToolMetadata, getToolCallID } from './plugin-helpers.js';
export async function toolAfter(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
  output: unknown,
): Promise<void> {
  return runWithAdapterLoggerAsync(runtime.adapterLog, async () => {
    const hookInput = input as ToolHookAfterInput;
    const hookOutput = output as ToolHookAfterOutput;
    const toolName = hookInput?.tool ?? '';
    const sessionId = hookInput?.sessionID ?? 'unknown';
    const traceId = getToolTraceId(runtime, input, 'after');
    return runWithLogContextAsync({ traceId, sessionId }, async () => {
      const now = new Date().toISOString();
      runtime.setCurrentSessionId(sessionId);
      runtime.log.info('hook', 'tool.execute.after', {
        tool: toolName,
      });
      await handleAfterDiagnostics(runtime, {
        toolName,
        sessionId,
        input,
        hookInput,
        hookOutput,
        now,
      });
      await handleBashAfter(runtime, toolName, sessionId, hookOutput);
      await runOrchestrator(runtime.orchestratorDeps, {
        toolName,
        input,
        output: hookOutput,
        sessionId,
        now,
      });
      await runFlowGuardAuditAfter({ runtime, toolName, input, output, sessionId, hookOutput });
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
  if (ctx.toolName === TOOL_FLOWGUARD_CONTINUE)
    logIdentityRejection(runtime, ctx.sessionId, ctx.hookOutput);
  if (ctx.toolName === TOOL_FLOWGUARD_HYDRATE)
    logHydrateLockSignal(runtime, ctx.sessionId, ctx.hookOutput);
  if (ctx.toolName === 'task') await handleTaskAfter(runtime, ctx);
}

function isReviewableFlowGuardTool(toolName: string): boolean {
  return [
    TOOL_FLOWGUARD_PLAN,
    TOOL_FLOWGUARD_IMPLEMENT,
    TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
    TOOL_FLOWGUARD_ARCHITECTURE,
    TOOL_FLOWGUARD_REVIEW,
  ].includes(toolName);
}

function handleReviewableAfter(runtime: FlowGuardPluginRuntime, ctx: AfterHookContext): void {
  try {
    trackFlowGuardEnforcement(
      runtime.ws.getEnforcementState(ctx.sessionId),
      ctx.toolName,
      ctx.input,
      ctx.hookOutput,
      ctx.now,
    );
  } catch (err) {
    runtime.logError('enforcement tracking failed', err);
  }
  logNativeEnforcementDenial(runtime, ctx.sessionId, ctx.hookOutput);
  logHostTaskRejection(runtime, ctx.sessionId, ctx.hookOutput);
  logIdentityRejection(runtime, ctx.sessionId, ctx.hookOutput);
  if (ctx.toolName === TOOL_FLOWGUARD_REVIEW)
    logNativeAttestationRejection(runtime, ctx.sessionId, ctx.hookOutput);
  logAutoAdvanceOverflow(runtime, ctx.sessionId, ctx.hookOutput);
}

function logNativeEnforcementDenial(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  hookOutput: ToolHookAfterOutput,
): void {
  if (!isNativeEnforcementUnavailableDenial(getToolOutput(hookOutput))) return;
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

async function handleTaskAfter(
  runtime: FlowGuardPluginRuntime,
  ctx: AfterHookContext,
): Promise<void> {
  const taskArgs = getToolArgs(ctx.input);
  const resolvedChildSessionId = resolveReviewerTaskSessionId(
    ctx.hookInput,
    ctx.hookOutput,
    taskArgs,
  );
  if (resolvedChildSessionId)
    ctx.hookOutput.output = injectSessionIdIntoOutput(
      ctx.hookOutput.output,
      resolvedChildSessionId,
    );
  try {
    trackTaskEnforcement(
      runtime.ws.getEnforcementState(ctx.sessionId),
      ctx.input,
      ctx.hookOutput,
      ctx.now,
    );
  } catch (err) {
    runtime.logError('enforcement tracking failed', err);
  }
  if (taskArgs.subagent_type === REVIEWER_SUBAGENT_TYPE) {
    await handleHostTaskEvidence(
      { ws: runtime.ws, log: runtime.log, logError: runtime.logError },
      ctx.sessionId,
      resolvedChildSessionId,
      ctx.now,
      ctx.hookOutput,
    );
  }
}

function resolveReviewerTaskSessionId(
  hookInput: ToolHookAfterInput,
  hookOutput: ToolHookAfterOutput,
  taskArgs: Record<string, unknown>,
): string | null {
  if (taskArgs.subagent_type !== REVIEWER_SUBAGENT_TYPE) return null;
  // Canonical three-tier resolution shared with onTaskToolAfter so the id injected
  // into the reviewer output matches the id persisted as invocation evidence.
  return resolveSubagentSessionId(
    getToolMetadata(hookOutput),
    getToolOutput(hookOutput),
    getToolCallID(hookInput),
  );
}

async function handleBashAfter(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  hookOutput: ToolHookAfterOutput,
): Promise<void> {
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
      hookOutput.output = strictBlockedOutput(auditResult.code!, {
        reason: auditResult.reason ?? 'audit persistence failed',
      });
    }
  });
}

/**
 * Resolve the FlowGuard phase for a session-error audit detail.
 *
 * A silent host/LLM stall (e.g. a long inference hang between tool calls, which
 * the user can only resolve by aborting) surfaces to FlowGuard as a
 * `session.error` event. That event hook has NO conversation-output channel, so
 * FlowGuard cannot tell the user anything live; the audit trail is the only
 * place it can record WHERE the session was when the host reported the error.
 * Including the phase makes such a stall post-mortem LOCATABLE.
 *
 * Fail-safe: returns an empty object when the state is missing or unreadable —
 * the audit event must always record, with or without a phase.
 *
 * @param sessDir - Resolved session directory.
 * @returns `{ phase }` when the persisted state has a phase, else `{}`.
 */
export async function resolveSessionErrorPhaseDetail(
  sessDir: string,
): Promise<Record<string, string>> {
  try {
    const state = await readState(sessDir);
    return state?.phase ? { phase: state.phase } : {};
  } catch {
    return {};
  }
}

export async function handlePluginEvent(
  runtime: FlowGuardPluginRuntime,
  event: unknown,
): Promise<void> {
  return runWithAdapterLoggerAsync(runtime.adapterLog, async () => {
    const eventDeps: EventHandlerDeps = {
      log: runtime.log,
      cleanupSession: (sessionId: string) => runtime.ws.invalidateChainState(sessionId),
      async emitSessionErrorAudit(sessionId, errorMessage, detail) {
        const sessDir = runtime.ws.getSessionDir(sessionId);
        if (!sessDir) return;
        await appendReviewAuditEvent(sessDir, sessionId, 'unknown', 'error:SESSION_ERROR', {
          code: 'SESSION_ERROR',
          message: errorMessage,
          ...(await resolveSessionErrorPhaseDetail(sessDir)),
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
    if (!sessionId) return;
    const compactionDeps: CompactionDeps = {
      getSessionDir: runtime.ws.getSessionDir,
      log: runtime.log,
    };
    const context = await buildCompactionContext(compactionDeps, sessionId);
    if (context) output.context.push(context);
  });
}
