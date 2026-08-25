import { existsSync } from 'node:fs';
import { readState } from '../adapters/persistence.js';
import { buildEnforcementError } from './plugin-helpers.js';
import { isMutatingHostTool, isHostToolAllowedInPhase } from './phase-tool-gate.js';
import {
  enforceBeforeVerdict,
  enforceBeforeSubagentCall,
  enforceReviewerObligation,
} from './review/enforcement/enforcement.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';
import type { CommandHookBeforeInput, ToolHookBeforeInput, ToolHookBeforeOutput } from './types.js';
import { recordUserDecisionIntentFromCommand } from './user-decision-intent.js';
import {
  getToolTraceId,
  type ActiveCommandScope,
  type FlowGuardPluginRuntime,
} from './plugin-shared.js';
import { isFlowGuardVerdictTool } from './tool-names.js';
import { runWithAdapterLoggerAsync } from '../logging/adapter-logger.js';
import { runWithLogContextAsync } from '../logging/log-context.js';
import type { SessionState } from '../state/schema.js';
import { enforceRiskClassificationBefore as enforceRiskBefore } from './plugin-risk.js';
import { enforceDiscoveryHealthBefore } from './plugin-discovery-health.js';
import { registerExecutedTaskPrompt } from './review/enforcement/execution-provenance.js';

export async function commandBefore(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
  _output: unknown,
): Promise<void> {
  return runWithAdapterLoggerAsync(runtime.adapterLog, async () => {
    const hookInput = input as CommandHookBeforeInput;
    const rawSessionId = hookInput?.sessionID;
    if (!rawSessionId) {
      runtime.log.warn('decision', 'command.execute.before missing sessionID');
      return;
    }

    updateCommandScope(runtime, rawSessionId, hookInput?.command ?? '');

    const intent = recordUserDecisionIntentFromCommand({
      sessionId: rawSessionId,
      command: hookInput?.command ?? '',
      arguments: hookInput?.arguments ?? '',
    });
    if (!intent) return;

    runtime.setCurrentSessionId(rawSessionId);
    runtime.log.info('decision', 'recorded user decision command intent', {
      sessionId: rawSessionId,
      command: intent.command,
      expectedVerdict: intent.expectedVerdict,
      expiresAt: intent.expiresAt,
    });
  });
}

export async function toolBefore(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
  output: unknown,
): Promise<void> {
  return runWithAdapterLoggerAsync(runtime.adapterLog, async () => {
    const hookInput = input as ToolHookBeforeInput;
    const toolName = hookInput?.tool ?? '';
    const sessionId = hookInput?.sessionID ?? 'unknown';
    const traceId = getToolTraceId(runtime, input, 'before');
    return runWithLogContextAsync({ traceId, sessionId }, async () => {
      runtime.setCurrentSessionId(sessionId);
      const args = (output as ToolHookBeforeOutput)?.args ?? {};
      runtime.log.info('hook', 'tool.execute.before', {
        tool: toolName,
      });
      await enforceBeforeRules(runtime, toolName, sessionId, hookInput?.callID ?? '', args);
    });
  });
}

async function resolveEnforcement(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  context: 'subagent' | 'verdict',
): Promise<{ strictEnforcement: boolean; sessionState: SessionState | null }> {
  try {
    const sessDir = runtime.ws.getSessionDir(sessionId);
    const sessionState = sessDir ? await readState(sessDir) : null;
    return {
      sessionState,
      strictEnforcement: sessionState?.policySnapshot?.selfReview?.strictEnforcement === true,
    };
  } catch {
    runtime.log.warn(
      'enforcement',
      `Failed to read session state for ${context} enforcement check`,
      { sessionId },
    );
    return { strictEnforcement: true, sessionState: null };
  }
}

async function enforceBeforeRules(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  callId: string,
  args: Record<string, unknown>,
): Promise<void> {
  await enforceCommandScope(runtime, toolName, sessionId);
  if (toolName === 'task') {
    await enforceTaskBefore(runtime, toolName, sessionId, callId, args);
    return;
  }
  await enforceMutatingToolCheck(runtime, toolName, sessionId, args);
  await enforceVerdictCheck(runtime, toolName, sessionId, args);
}

function updateCommandScope(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  command: string,
): void {
  const normalized = command.trim().replace(/^\/+/, '');
  const scope: ActiveCommandScope | undefined = normalized === 'check' ? 'check' : undefined;
  if (scope) {
    runtime.activeCommandScopes.set(sessionId, scope);
    return;
  }
  runtime.activeCommandScopes.delete(sessionId);
}

async function enforceCommandScope(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<void> {
  const scope = runtime.activeCommandScopes.get(sessionId);
  if (scope !== 'check') return;

  const allowed = new Set(['flowguard_status', 'flowguard_run_check']);
  if (toolName === 'flowguard_review_implementation' || toolName === 'task') {
    const sessDir = runtime.ws.getSessionDir(sessionId);
    const state = sessDir ? await readState(sessDir) : null;
    if (state?.phase === 'IMPL_REVIEW') allowed.add(toolName);
  }
  if (allowed.has(toolName)) return;

  throw buildEnforcementError(
    'COMMAND_SCOPE_DENIED',
    `Tool '${toolName}' is not permitted while the explicit /check command is active. Report the check result and wait for the user to invoke the next command.`,
    { sessionId, tool: toolName, command: '/check' },
  );
}

async function enforceTaskBefore(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  callId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : '';
  if (subagentType === REVIEWER_SUBAGENT_TYPE) {
    if (!callId) {
      throw buildEnforcementError(
        'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
        'Reviewer Task requires a non-empty host callID.',
      );
    }
    const eState = runtime.ws.getEnforcementState(sessionId);
    const { strictEnforcement, sessionState } = await resolveEnforcement(
      runtime,
      sessionId,
      'subagent',
    );
    await enforceReviewerObligationCheck(runtime, sessionState, strictEnforcement);

    const execution = registerExecutedTaskPrompt(
      eState,
      sessionState?.reviewAssurance,
      callId,
      args.prompt,
      new Date().toISOString(),
    );
    if (execution.kind === 'blocked') {
      throw buildEnforcementError('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', execution.reason);
    }
    args.prompt = execution.prompt.canonicalPrompt;

    // Dispatch authority is the DURABLE attempt lifecycle (session assurance),
    // never the transient capture: a bare Task call cannot re-arm a rejected
    // attempt — only the originating FlowGuard command can re-issue one.
    const result = enforceBeforeSubagentCall(
      eState,
      args,
      strictEnforcement,
      sessionState?.reviewAssurance,
    );
    if (result.allowed) return;
    eState.executedTaskPrompts.delete(callId);
    runtime.log.warn('enforcement', 'blocked subagent call', {
      tool: toolName,
      sessionId,
      code: result.code,
    });
    throw buildEnforcementError(result.code ?? 'INTERNAL_ERROR', result.reason ?? '');
  }
  if (subagentType === '') return;
  runtime.log.warn('enforcement', 'blocked unauthorized subagent type', {
    tool: toolName,
    subagentType,
    sessionId,
  });
  throw buildEnforcementError(
    'SUBAGENT_TYPE_UNAUTHORIZED',
    `Subagent type '${subagentType}' is not authorized by FlowGuard governance. Only '${REVIEWER_SUBAGENT_TYPE}' is allowed.`,
  );
}

// This host-hook coordinator preserves sequential fail-closed checks.
// eslint-disable-next-line complexity
async function enforceReviewerObligationCheck(
  runtime: FlowGuardPluginRuntime,
  sessionState: SessionState | null,
  strictEnforcement: boolean,
): Promise<void> {
  const obligationResult = enforceReviewerObligation({
    obligations: sessionState?.reviewAssurance?.obligations ?? [],
    invocations: sessionState?.reviewAssurance?.invocations ?? [],
    reviewInvocationPolicy: sessionState?.policySnapshot?.reviewInvocationPolicy,
    maxIncoherentReviewerCaptureRetries:
      sessionState?.policySnapshot?.maxIncoherentReviewerCaptureRetries,
    strictEnforcement,
    stateAvailable: sessionState !== null,
  });
  if (obligationResult.allowed) return;
  const obligations = sessionState?.reviewAssurance?.obligations ?? [];
  runtime.log.warn('enforcement', `reviewer task blocked — ${obligationResult.code}`, {
    policy: sessionState?.policySnapshot?.reviewInvocationPolicy,
    pendingObligationCount: obligations.filter((o) => o.status === 'pending').length,
  });
  throw buildEnforcementError(obligationResult.code, obligationResult.reason);
}

async function enforceMutatingToolCheck(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<void> {
  // An absent tool identity is malformed host input and cannot be governed.
  // Unknown non-empty tools fail closed through the host phase gate.
  if (!toolName || !isMutatingHostTool(toolName)) return;
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) {
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Cannot verify host tool phase gate because no authoritative FlowGuard session mapping exists. Run /hydrate before mutating the workspace.',
      { sessionId, tool: toolName, sessionMapping: 'unresolved' },
    );
  }
  const state = await readRequiredHostToolState(sessDir, sessionId, toolName);
  if (state.error) {
    throw buildEnforcementError(state.error.code, state.error.message, {
      sessionId,
      tool: toolName,
      recoveryHint: state.error.recoveryHint,
      occurredAt: state.error.occurredAt,
    });
  }
  enforceHostToolPhase(runtime, toolName, sessionId, state);
  await enforceRiskBefore(runtime.riskDeps, sessDir, state, toolName, args);
  await enforceDiscoveryHealthBefore(runtime.discoveryHealthDeps, sessDir, state, toolName);
}

async function readRequiredHostToolState(
  sessDir: string,
  sessionId: string,
  toolName: string,
): Promise<SessionState> {
  if (!existsSync(sessDir)) {
    throw buildEnforcementError(
      'SESSION_DIR_NOT_FOUND',
      `FlowGuard session directory expected at "${sessDir}" but not found on disk. Run /hydrate to initialize the session.`,
      { sessionId, tool: toolName, sessDir, stateReadable: 'false' },
    );
  }
  try {
    const state = await readState(sessDir);
    if (state) return state;
  } catch (err) {
    throw unreadableStateError(sessDir, sessionId, toolName, err);
  }
  throw missingStateError(sessDir, sessionId, toolName);
}

function unreadableStateError(
  sessDir: string,
  sessionId: string,
  toolName: string,
  err: unknown,
): Error {
  return buildEnforcementError(
    'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    `Cannot verify host tool phase gate — session state exists at "${sessDir}" but is unreadable (${err instanceof Error ? err.message : String(err)}). Run FlowGuard doctor, re-hydrate the session, or restore a valid session state.`,
    {
      sessionId,
      tool: toolName,
      stateFile: `${sessDir}/session-state.json`,
      stateReadable: 'false',
      error: err instanceof Error ? err.message : String(err),
    },
  );
}

function missingStateError(sessDir: string, sessionId: string, toolName: string): Error {
  return buildEnforcementError(
    'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    `Cannot verify host tool phase gate — session directory exists at "${sessDir}" but contains no state file. Run FlowGuard doctor, re-hydrate the session, or restore a valid session state.`,
    {
      sessionId,
      tool: toolName,
      stateFile: `${sessDir}/session-state.json`,
      stateReadable: 'false',
    },
  );
}

function enforceHostToolPhase(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  state: SessionState,
): void {
  const gateResult = isHostToolAllowedInPhase(toolName, state.phase);
  runtime.log.debug('enforcement', 'evaluating phase gate', {
    tool: toolName,
    phase: state.phase,
    allowed: gateResult.allowed,
  });
  if (gateResult.allowed) return;
  // The denial reason is phase-specific only for HOST_TOOL_PHASE_DENIED (a
  // mutating tool blocked in an investigation-only phase). HOST_TOOL_UNKNOWN_DENIED
  // is a phase-independent default-deny of an unrecognized host tool, so do not
  // claim "investigation-only phase" for it.
  const logMessage =
    gateResult.code === 'HOST_TOOL_PHASE_DENIED'
      ? 'blocked host tool in investigation-only phase'
      : 'blocked unknown host tool (default deny)';
  runtime.log.warn('enforcement', logMessage, {
    tool: toolName,
    sessionId,
    phase: state.phase,
    code: gateResult.code,
  });
  throw buildEnforcementError(gateResult.code!, gateResult.reason!, {
    sessionId,
    tool: toolName,
    phase: state.phase,
  });
}

async function enforceVerdictCheck(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (!isFlowGuardVerdictTool(toolName)) return;
  for (const key of Object.keys(args)) if (args[key] === null) delete args[key];
  const eState = runtime.ws.getEnforcementState(sessionId);
  const { strictEnforcement, sessionState } = await resolveEnforcement(
    runtime,
    sessionId,
    'verdict',
  );
  const result = enforceBeforeVerdict(eState, toolName, args, sessionState, strictEnforcement);
  if (result.allowed) return;
  runtime.log.warn('enforcement', 'blocked verdict submission', {
    tool: toolName,
    sessionId,
    code: result.code,
  });
  throw buildEnforcementError(result.code ?? 'INTERNAL_ERROR', result.reason ?? '');
}
