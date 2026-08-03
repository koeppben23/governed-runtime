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
  TOOL_FLOWGUARD_RUN_CHECK,
} from './tool-names.js';
import { enforceRiskClassificationAfterBash as enforceRiskAfterBash } from './plugin-risk.js';
import { enforceDiscoveryHealthAfterBash } from './plugin-discovery-health.js';
import { trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import { strictBlockedOutput, getToolMetadata, getToolCallID } from './plugin-helpers.js';
import {
  ensureReviewAssurance,
  updateAttemptStatus,
  createAttemptForExistingObligation,
} from './review/assurance.js';
import type { ReviewAssuranceState, ReviewAttempt } from '../state/evidence-review.js';
import { readState as readPersistedState } from '../adapters/persistence.js';
import type { SessionState } from '../state/schema.js';
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
      const afterCtx: AfterHookContext = {
        toolName,
        sessionId,
        input,
        hookInput,
        hookOutput,
        now,
      };
      await handleAfterDiagnostics(runtime, afterCtx);
      await handleBashAfter(runtime, toolName, sessionId, hookOutput);
      await runOrchestrator(runtime.orchestratorDeps, {
        toolName,
        input,
        output: hookOutput,
        sessionId,
        now,
      });
      trackReviewableEnforcement(runtime, afterCtx);
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
    TOOL_FLOWGUARD_RUN_CHECK,
  ].includes(toolName);
}

function handleReviewableAfter(runtime: FlowGuardPluginRuntime, ctx: AfterHookContext): void {
  // Diagnostics observe the tool's own output: the host-task rewrite replaces
  // `code` wholesale, so running these afterwards would suppress real rejections.
  logNativeEnforcementDenial(runtime, ctx.sessionId, ctx.hookOutput);
  logHostTaskRejection(runtime, ctx.sessionId, ctx.hookOutput);
  logIdentityRejection(runtime, ctx.sessionId, ctx.hookOutput);
  if (ctx.toolName === TOOL_FLOWGUARD_REVIEW)
    logNativeAttestationRejection(runtime, ctx.sessionId, ctx.hookOutput);
  logAutoAdvanceOverflow(runtime, ctx.sessionId, ctx.hookOutput);
}

/**
 * Track review enforcement against the output the agent actually receives.
 *
 * Must run AFTER orchestration: the host-task handshake is what rewrites a
 * standalone /review response into INDEPENDENT_REVIEW_REQUIRED and attaches the
 * reviewAttemptId. Tracking the pre-orchestration output registered a pending
 * review with a null attempt id, so the reviewer child session could never be
 * bound and the captured evidence was discarded.
 */
function trackReviewableEnforcement(runtime: FlowGuardPluginRuntime, ctx: AfterHookContext): void {
  if (!isReviewableFlowGuardTool(ctx.toolName)) return;
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
    // Bind the child session to the pre-created attempt atomically
    // BEFORE the evidence binding callback runs.
    if (resolvedChildSessionId) {
      const binding = await bindAttemptSession(
        runtime,
        ctx.sessionId,
        resolvedChildSessionId,
        ctx.now,
      );
      if (!binding.ok) {
        runtime.log.warn('host-task', 'start binding failed, aborting evidence processing', {
          reason: binding.reason,
          sessionId: ctx.sessionId,
          childSessionId: resolvedChildSessionId,
        });
        return;
      }
    }
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

/**
 * Bind a child session to the attempt identified by the enforcement state's
 * pending review record. Uses pending.attemptId as the sole authority.
 *
 * All invariant guards are checked atomically inside the state update
 * callback so there is no check-then-write race window.
 */
/**
 * Attach a fresh attempt for a sequential reviewer re-invocation.
 *
 * Fails closed when the obligation can no longer legitimately receive evidence:
 * a consumed or blocked obligation must never be re-armed, otherwise a late or
 * replayed reviewer Task could attach evidence to an already-settled decision.
 */
function rearmAttempt(
  assurance: ReviewAssuranceState,
  spent: ReviewAttempt,
  childSessionId: string,
  now: string,
): ReviewAssuranceState {
  const obligation = assurance.obligations.find((o) => o.obligationId === spent.obligationId);
  if (!obligation) throw bindingFailed('rearm_obligation_not_found');
  if (obligation.status === 'consumed' || obligation.status === 'blocked') {
    throw bindingFailed('rearm_obligation_settled');
  }
  return createAttemptForExistingObligation(assurance, obligation, childSessionId, now);
}

async function bindAttemptSession(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  childSessionId: string,
  now: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) return { ok: false, reason: 'no_session_dir' };
  const state = await readPersistedState(sessDir);
  if (!state) return { ok: false, reason: 'no_state' };

  const eState = runtime.ws.getEnforcementState(sessionId);
  let attemptId: string | null = null;
  let obligationId: string | null = null;
  for (const pending of eState.pendingReviews.values()) {
    if (pending.subagentRecord?.sessionId !== childSessionId) continue;
    if (!pending.attemptId || !pending.obligationId) {
      return { ok: false, reason: 'pending_attempt_id_missing' };
    }
    attemptId = pending.attemptId;
    obligationId = pending.obligationId;
    break;
  }
  if (!attemptId || !obligationId) {
    return { ok: false, reason: 'no_matching_pending_review' };
  }

  try {
    await runtime.ws.updateReviewAssurance(sessDir, (s: SessionState) => {
      const assurance = ensureReviewAssurance(s.reviewAssurance);
      const attempts = assurance.attempts;
      const attempt = attempts?.find((a) => a.attemptId === attemptId);
      if (!attempt) throw bindingFailed('pending_attempt_not_found');
      if (attempt.obligationId !== obligationId) throw bindingFailed('attempt_obligation_mismatch');
      if (attempts?.some((a) => a.childSessionId === childSessionId)) {
        // One reviewer session binds at most once, whether to this attempt or
        // another: otherwise a single child session could satisfy two attempts.
        throw bindingFailed('child_session_already_bound');
      }
      if (attempt.status === 'created' && !attempt.childSessionId) {
        return {
          ...s,
          reviewAssurance: updateAttemptStatus(
            assurance,
            attempt.attemptId,
            'created',
            now,
            childSessionId,
          ),
        };
      }
      // Re-arm: the pre-registered attempt was already spent (a previous reviewer
      // Task bound it, or its capture was rejected). A sequential re-invocation
      // gets a NEW attempt so it can still satisfy the obligation, and the spent
      // attempt is staled so a late callback from it is hard-rejected.
      return {
        ...s,
        reviewAssurance: rearmAttempt(assurance, attempt, childSessionId, now),
      };
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof BindingFailure) {
      runtime.log.warn('host-task', 'bind attempt aborted', {
        reason: err.reason,
        attemptId,
        childSessionId,
      });
      return { ok: false, reason: err.reason };
    }
    throw err;
  }
}

class BindingFailure extends Error {
  constructor(public reason: string) {
    super(`Bind attempt failed: ${reason}`);
  }
}

function bindingFailed(reason: string): BindingFailure {
  return new BindingFailure(reason);
}
