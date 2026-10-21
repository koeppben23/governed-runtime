import { randomUUID } from 'node:crypto';
import { readState } from '../adapters/persistence.js';
import { workspacesHome } from '../adapters/workspace/index.js';
import { buildEnforcementError } from './blocked-result.js';

import {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  hostMutationIntegrityGate,
} from './phase-tool-gate.js';
import { isAllowedReworkContinuation } from './plugin-rework-continuation.js';
import { isMutatingFlowGuardTool } from './tool-classification.js';
import { enforceBeforeVerdict } from './review/enforcement/enforcement.js';
import { reviewSignalOwner } from './review/obligations/obligation-tools.js';
import type { CommandHookBeforeInput, ToolHookBeforeInput, ToolHookBeforeOutput } from './types.js';
import { recordUserDecisionIntentFromCommand } from './user-decision-intent.js';
import {
  getToolTraceId,
  recordToolLatencyStart,
  type ActiveCommandScope,
  type FlowGuardPluginRuntime,
} from './plugin-shared.js';
import {
  FLOWGUARD_TOOL_PREFIX,
  isFlowGuardVerdictTool,
  TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
  TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_RUN_CHECK,
  TOOL_FLOWGUARD_STATUS,
} from './tool-names.js';
import { runWithAdapterLoggerAsync } from '../logging/adapter-logger.js';
import { runWithLogContextAsync } from '../logging/log-context.js';
import type { SessionState } from '../state/schema.js';
import { enforceRiskClassificationBefore as enforceRiskBefore } from './plugin-risk.js';
import { enforceDiscoveryHealthBefore } from './plugin-discovery-health.js';
import { resolveAttemptByCapability } from './review/observations/observation-resolution.js';
import { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';
import { auditEnforcementDenied } from './plugin-audit.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import { recoverRegulatedCompletion } from './plugin-regulated-recovery.js';
import { writeStateWithAuditOperationsAlreadyLocked } from './audit-outbox.js';
import { authorizeMutationEpisode } from '../state/evidence-mutation-episode.js';
import { getRuntimeInstanceId } from './runtime-instance.js';
import { acquireRuntimeLease } from './runtime-lease.js';
import { enforceGitPrerequisiteBeforeMutation } from './plugin-git-gate.js';

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

    // Stryker disable next-line OptionalChaining — equivalent: sessionID-missing inputs return at the guard above before this line is reached.
    updateCommandScope(runtime, rawSessionId, hookInput?.command ?? '');

    await maybeReleaseCapacityLock(runtime, rawSessionId, hookInput?.command ?? '');

    const intent = recordUserDecisionIntentFromCommand({
      sessionId: rawSessionId,
      // Stryker disable next-line OptionalChaining — equivalent: the `?? ''` fallback keeps removed optional chains observationally identical.
      command: hookInput?.command ?? '',
      // Stryker disable next-line OptionalChaining — equivalent: decision commands ignore the arguments value when absent; the `?? ''` fallback neutralizes single-`?.` removals.
      arguments: hookInput?.arguments ?? '',
    });
    if (!intent) return;

    runtime.log.info('decision', 'recorded user decision command intent', {
      sessionId: rawSessionId,
      command: intent.command,
      expectedVerdict: intent.expectedVerdict,
      expiresAt: intent.expiresAt,
    });
  });
}

const REVIEW_CAPACITY_RELEASE_COMMANDS: ReadonlySet<string> = new Set([
  'plan',
  'architecture',
  'review',
  'implement',
]);

async function maybeReleaseCapacityLock(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  rawCommand: string,
): Promise<void> {
  const command = rawCommand.trim().replace(/^\/+/, '');
  if (!REVIEW_CAPACITY_RELEASE_COMMANDS.has(command)) return;
  await clearCapacityLock(runtime, sessionId, command);
}

/** Release the capacity lock only at the start of a new explicit review command. */
async function clearCapacityLock(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  command: string,
): Promise<void> {
  const resolution = await runtime.ws.resolveSessionAuthority(sessionId);
  if (resolution.status !== 'resolved') return;
  const lock = resolution.state.reviewAssurance?.capacityLock;
  if (!lock) return;
  await runtime.ws.updateReviewAssurance(resolution.sessDir, (state) => {
    const assurance = state.reviewAssurance;
    if (!assurance?.capacityLock) return state;
    return {
      ...state,
      reviewAssurance: { ...assurance, capacityLock: null },
    };
  });
  runtime.log.info('review', 'capacity lock released by explicit command', {
    sessionId,
    command,
    obligationId: lock.obligationId,
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
      if (toolName.startsWith(FLOWGUARD_TOOL_PREFIX) || isMutatingHostTool(toolName)) {
        await recoverRegulatedCompletion(runtime, sessionId);
      }
      const args = (output as ToolHookBeforeOutput)?.args ?? {};
      runtime.log.info('hook', 'tool.execute.before', {
        tool: toolName,
      });
      try {
        await enforceBeforeRules(runtime, toolName, sessionId, hookInput?.callID ?? '', args);
      } catch (err) {
        if (!toolName.startsWith(FLOWGUARD_TOOL_PREFIX)) {
          const reasonCode = enforcementReasonCode(err);
          if (reasonCode) {
            await auditEnforcementDenied({
              deps: runtime.auditDeps,
              sessionId,
              tool: toolName,
              reasonCode,
              hostCallId: hookInput?.callID ?? '',
              traceId,
            });
          }
        }
        throw err;
      }
      // Diagnostic only: the last statement of a fully passed before-hook, so
      // a blocked call never leaves a latency start behind.
      recordToolLatencyStart(runtime, input);
    });
  });
}

function enforcementReasonCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.name !== 'FlowGuardEnforcementError') return undefined;
  const { message } = err;
  const prefix = '[FlowGuard] ';
  if (!message.startsWith(prefix)) return undefined;
  try {
    const parsed: unknown = JSON.parse(message.slice(prefix.length));
    return typeof (parsed as { code?: unknown }).code === 'string'
      ? (parsed as { code: string }).code
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveEnforcement(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  context: 'subagent' | 'verdict',
): Promise<SessionState | null> {
  try {
    const resolution = await runtime.ws.resolveSessionAuthority(sessionId);
    return resolution.status === 'resolved' ? resolution.state : null;
  } catch {
    runtime.log.warn(
      'enforcement',
      `Failed to read session state for ${context} enforcement check`,
      { sessionId },
    );
    return null;
  }
}

async function enforceBeforeRules(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  callId: string,
  args: Record<string, unknown>,
): Promise<void> {
  await enforceCapacityLock(runtime, toolName, sessionId);
  await enforceCommandScope(runtime, toolName, sessionId);

  const mutatingHost = isMutatingHostTool(toolName);

  let hostResolution: { sessDir: string; state: SessionState } | null = null;
  if (mutatingHost) {
    hostResolution = await resolveHostToolStateOrThrow(runtime, toolName, sessionId);
    const integrity = hostMutationIntegrityGate(
      toolName,
      hostResolution.state,
      args,
      hostResolution.sessDir,
    );
    if (integrity.kind === 'blocked') throw buildEnforcementError(integrity.code, integrity.reason);
  }

  await enforceVerdictCheck(runtime, toolName, sessionId, args);

  if (toolName === TOOL_FLOWGUARD_OBSERVE_REPOSITORY) {
    await reconcileObservationParent(runtime, args);
    return;
  }

  if (isMutatingFlowGuardTool(toolName) || mutatingHost) {
    await reconcileBeforeMutation(runtime, sessionId, toolName);
  }

  if (mutatingHost && hostResolution) {
    const freshState = await readFreshStateAfterReconcile(runtime, sessionId, hostResolution);
    await enforceGitPrerequisiteBeforeMutation(runtime.riskDeps, toolName);
    await enforceRiskBefore(runtime.riskDeps, hostResolution.sessDir, freshState, toolName, args);
    await enforceDiscoveryHealthBefore(
      runtime.discoveryHealthDeps,
      hostResolution.sessDir,
      freshState,
      toolName,
    );
    await recordMutationDispatch(runtime, hostResolution.sessDir, sessionId, callId, toolName);
  }
}

async function recordMutationDispatch(
  runtime: FlowGuardPluginRuntime,
  sessDir: string,
  sessionId: string,
  callId: string,
  toolName: string,
): Promise<void> {
  if (!callId) {
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'A mutating host tool requires a host callID for durable dispatch authorization.',
    );
  }
  await withSessionWriteLock(sessDir, async () => {
    const state = await readState(sessDir);
    if (!state) {
      throw buildEnforcementError(
        'PLUGIN_ENFORCEMENT_UNAVAILABLE',
        'FlowGuard session state disappeared before mutation dispatch authorization.',
      );
    }
    enforceHostToolPhase(runtime, toolName, sessionId, state);
    const leaseAcquisition = acquireRuntimeLease({
      current: state.runtimeLease,
      runtimeInstanceId: getRuntimeInstanceId(),
      pid: process.pid,
      now: new Date().toISOString(),
    });
    if (leaseAcquisition.kind === 'blocked') {
      throw buildEnforcementError(
        'MUTATION_EPISODE_LEASE_UNAVAILABLE',
        `Session is governed by another live runtime instance (generation ${leaseAcquisition.lease.generation}). ` +
          'The host mutation dispatch is blocked.',
        {
          activeLeaseGeneration: String(leaseAcquisition.lease.generation),
        },
      );
    }
    const result = authorizeMutationEpisode(state.mutationEpisodes, {
      episodeId: randomUUID(),
      hostCallId: callId,
      toolName,
      runtimeInstanceId: getRuntimeInstanceId(),
      leaseGeneration: leaseAcquisition.lease.generation,
      authorizedAt: new Date().toISOString(),
    });
    if (result.kind === 'replay_blocked') {
      throw buildEnforcementError(
        'MUTATION_EPISODE_REPLAY_BLOCKED',
        `hostCallId ${callId} already authorizes a host mutation dispatch for tool ${result.existing.toolName}. ` +
          'The host call identity must be unique per dispatch.',
        { hostCallId: callId, toolName, existingEpisodeId: result.existing.episodeId },
      );
    }
    await writeStateWithAuditOperationsAlreadyLocked(sessDir, {
      ...state,
      runtimeLease: leaseAcquisition.lease,
      mutationEpisodes: result.episodes,
    });
  });
}

async function readFreshStateAfterReconcile(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  hostResolution: { sessDir: string; state: SessionState },
): Promise<SessionState> {
  const fresh = await readState(hostResolution.sessDir);
  if (!fresh) {
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'FlowGuard session state disappeared during audit reconciliation. Run FlowGuard doctor or re-hydrate the session.',
      { sessionId, stateReadable: 'false' },
    );
  }
  return fresh;
}

async function reconcileBeforeMutation(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  toolName: string,
): Promise<void> {
  const audit = await reconcilePendingAuditOperations(runtime.auditDeps, sessionId, toolName);
  if (audit?.block) {
    throw buildEnforcementError(audit.code ?? 'AUDIT_PERSISTENCE_FAILED', audit.reason ?? '');
  }
}

async function reconcileObservationParent(
  runtime: FlowGuardPluginRuntime,
  args: Record<string, unknown>,
): Promise<void> {
  const capability = typeof args.capability === 'string' ? args.capability : '';
  if (!capability) return;
  const fingerprint = runtime.ws.cachedFingerprint;
  if (!fingerprint) {
    throw buildEnforcementError(
      'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
      'Cannot resolve the observation capability authority: workspace fingerprint unavailable.',
    );
  }
  const resolution = await resolveAttemptByCapability({
    workspaceHome: workspacesHome(),
    fingerprint,
    capability,
  });
  if (!resolution) return;
  await reconcileBeforeMutation(runtime, resolution.sessionId, TOOL_FLOWGUARD_OBSERVE_REPOSITORY);
}

function updateCommandScope(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  command: string,
): void {
  runtime.checkReworkContinuations.delete(sessionId);
  const normalized = command.trim().replace(/^\/+/, '');
  const scope: ActiveCommandScope | undefined = normalized === 'check' ? 'check' : undefined;
  if (scope) {
    runtime.activeCommandScopes.set(sessionId, scope);
    return;
  }
  runtime.activeCommandScopes.delete(sessionId);
}

async function readScopedState(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
): Promise<SessionState | null> {
  const resolution = await runtime.ws.resolveSessionAuthority(sessionId);
  return resolution.status === 'resolved' ? resolution.state : null;
}

async function isAllowedInImplReview(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<boolean> {
  const reviewSurface =
    toolName === TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION ||
    toolName === TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE;
  if (!reviewSurface) return false;
  return (await readScopedState(runtime, sessionId))?.phase === 'IMPL_REVIEW';
}

async function enforceCapacityLock(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<void> {
  if (reviewSignalOwner(toolName) === undefined) return;
  const state = await resolveEnforcement(runtime, sessionId, 'verdict');
  const lock = state?.reviewAssurance?.capacityLock;
  if (!lock) return;
  throw buildEnforcementError(
    'REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND',
    'A previous reviewer exhausted its execution capacity and the review obligation is blocked. ' +
      'No new review may start in the same user turn. Report the blocker and wait for a new explicit review command.',
    { obligationId: lock.obligationId, code: lock.code },
  );
}

async function enforceCommandScope(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<void> {
  const scope = runtime.activeCommandScopes.get(sessionId);
  if (scope !== 'check') return;

  const allowed = new Set([TOOL_FLOWGUARD_STATUS, TOOL_FLOWGUARD_RUN_CHECK]);
  if (await isAllowedInImplReview(runtime, toolName, sessionId)) {
    allowed.add(toolName);
  }
  if (await isAllowedReworkContinuation(runtime, toolName, sessionId)) {
    allowed.add(toolName);
  }
  if (allowed.has(toolName)) return;

  throw buildEnforcementError(
    'COMMAND_SCOPE_DENIED',
    `Tool '${toolName}' is not permitted while the explicit /check command is active. Report the check result and wait for the user to invoke the next command.`,
    { sessionId, tool: toolName, command: '/check' },
  );
}

async function resolveHostToolStateOrThrow(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<{ sessDir: string; state: SessionState }> {
  const resolution = await runtime.ws.resolveSessionAuthority(sessionId);
  if (resolution.status === 'unavailable') {
    throw buildEnforcementError(resolution.code, resolution.reason, {
      sessionId,
      tool: toolName,
      sessionMapping: 'unresolved',
    });
  }
  if (resolution.status === 'absent') {
    throw buildEnforcementError(
      'SESSION_DIR_NOT_FOUND',
      'Cannot verify host tool phase gate because no authoritative FlowGuard session state exists. Run /hydrate before mutating the workspace.',
      { sessionId, tool: toolName, stateReadable: 'false' },
    );
  }

  const { sessDir, state } = resolution;
  if (state.error) {
    // A persisted blocking error (e.g. strict TSA assurance failure) is a
    // durable fail-closed latch: the next governed host mutation must not
    // extend a session whose recorded authority is already broken. Surface the
    // persisted code so the root cause — not a downstream phase-gate symptom —
    // is what the host sees.
    throw buildEnforcementError(state.error.code, state.error.message, {
      sessionId,
      tool: toolName,
      recoveryHint: state.error.recoveryHint,
      occurredAt: state.error.occurredAt,
    });
  }
  enforceHostToolPhase(runtime, toolName, sessionId, state);
  return { sessDir, state };
}

function enforceHostToolPhase(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  state: SessionState,
): void {
  const integrity = hostMutationIntegrityGate(toolName, state);
  if (integrity.kind === 'blocked') throw buildEnforcementError(integrity.code, integrity.reason);
  const gateResult = isHostToolAllowedInPhase(toolName, state.phase);
  runtime.log.debug('enforcement', 'evaluating phase gate', {
    tool: toolName,
    phase: state.phase,
    allowed: gateResult.allowed,
  });
  if (gateResult.allowed) return;
  const logMessage =
    gateResult.code === 'HOST_TOOL_PHASE_DENIED'
      ? 'blocked host tool outside implementation phase'
      : 'blocked unknown host tool (default deny)';
  runtime.log.warn('enforcement', logMessage, {
    tool: toolName,
    sessionId,
    phase: state.phase,
    code: gateResult.code,
  });
  throw buildEnforcementError(gateResult.code, gateResult.reason, {
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
  const sessionState = await resolveEnforcement(runtime, sessionId, 'verdict');
  const result = enforceBeforeVerdict(eState, toolName, args, sessionState);
  if (result.allowed) return;
  runtime.log.warn('enforcement', 'blocked verdict submission', {
    tool: toolName,
    sessionId,
    code: result.code,
  });
  throw buildEnforcementError(result.code, result.reason);
}
