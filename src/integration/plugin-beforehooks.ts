import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readState } from '../adapters/persistence.js';
import { workspacesHome } from '../adapters/workspace/index.js';
import { buildEnforcementError } from './plugin-helpers.js';
import { isMutatingHostTool, isHostToolAllowedInPhase } from './phase-tool-gate.js';
import { isAllowedReworkContinuation } from './plugin-rework-continuation.js';
import { isMutatingFlowGuardTool } from './tool-classification.js';
import {
  enforceBeforeVerdict,
  enforceBeforeSubagentCall,
  enforceReviewerObligation,
} from './review/enforcement/enforcement.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { CommandHookBeforeInput, ToolHookBeforeInput, ToolHookBeforeOutput } from './types.js';
import { recordUserDecisionIntentFromCommand } from './user-decision-intent.js';
import {
  getToolTraceId,
  FG_PREFIX,
  type ActiveCommandScope,
  type FlowGuardPluginRuntime,
} from './plugin-shared.js';
import {
  isFlowGuardVerdictTool,
  TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
} from './tool-names.js';
import { runWithAdapterLoggerAsync } from '../logging/adapter-logger.js';
import { runWithLogContextAsync } from '../logging/log-context.js';
import type { SessionState } from '../state/schema.js';
import { projectUnaddressedImplementationChallengeIds } from '../state/implementation-review-findings.js';
import { enforceRiskClassificationBefore as enforceRiskBefore } from './plugin-risk.js';
import { enforceDiscoveryHealthBefore } from './plugin-discovery-health.js';
import { registerExecutedTaskPrompt } from './review/enforcement/execution-provenance.js';
import type { ExecutedTaskPrompt } from './review/enforcement/types.js';
import { resolveAttemptByCapability } from './review/observation-resolution.js';
import { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';
import { auditEnforcementDenied } from './plugin-audit.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import { recoverRegulatedCompletion } from './plugin-regulated-recovery.js';
import { writeStateWithAuditOperationsAlreadyLocked } from './tools/audit-outbox.js';
import { authorizeMutationEpisode } from '../state/evidence-mutation-episode.js';
import { persistAuthorizedDispatch, rearmInterruptedReviewerDispatch } from './durable-dispatch.js';
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
      if (toolName.startsWith(FG_PREFIX) || isMutatingHostTool(toolName)) {
        await recoverRegulatedCompletion(runtime, sessionId);
      }
      const args = (output as ToolHookBeforeOutput)?.args ?? {};
      runtime.log.info('hook', 'tool.execute.before', {
        tool: toolName,
      });
      try {
        await enforceBeforeRules(runtime, toolName, sessionId, hookInput?.callID ?? '', args);
      } catch (err) {
        if (!toolName.startsWith(FG_PREFIX)) {
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
    const sessDir = runtime.ws.getSessionDir(sessionId);
    return sessDir ? await readState(sessDir) : null;
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
  await enforceCommandScope(runtime, toolName, sessionId);

  if (toolName === 'task') {
    await enforceTaskBefore(runtime, toolName, sessionId, callId, args);
    return;
  }

  const mutatingHost = isMutatingHostTool(toolName);

  let hostResolution: { sessDir: string; state: SessionState } | null = null;
  if (mutatingHost) {
    hostResolution = await resolveHostToolStateOrThrow(runtime, toolName, sessionId);
  }

  await enforceVerdictCheck(runtime, toolName, sessionId, args);

  if (toolName === 'flowguard_observe_repository') {
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
  const fingerprint = runtime.auditDeps.cachedFingerprint ?? runtime.ws.cachedFingerprint;
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
  await reconcileBeforeMutation(runtime, resolution.sessionId, 'flowguard_observe_repository');
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
  const sessDir = runtime.ws.getSessionDir(sessionId);
  return sessDir ? await readState(sessDir) : null;
}

async function isAllowedInImplReview(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<boolean> {
  const reviewSurface =
    toolName === 'flowguard_review_implementation' ||
    toolName === 'task' ||
    toolName === TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE;
  if (!reviewSurface) return false;
  return (await readScopedState(runtime, sessionId))?.phase === 'IMPL_REVIEW';
}

async function enforceCommandScope(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<void> {
  const scope = runtime.activeCommandScopes.get(sessionId);
  if (scope !== 'check') return;

  const allowed = new Set(['flowguard_status', 'flowguard_run_check']);
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

// eslint-disable-next-line complexity, max-lines-per-function -- the reviewer Task before-gate is one sequential fail-closed chain; splitting it would interleave the durable rearm recovery with the dispatch checks.
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
    const sessionState = await resolveEnforcement(runtime, sessionId, 'subagent');
    await enforceReviewerObligationCheck(runtime, sessionState);
    enforceImplementationChallengeResolutionCheck(sessionState);

    await reconcileBeforeMutation(runtime, sessionId, toolName);

    const registered = registerExecutedTaskPrompt(
      eState,
      sessionState?.reviewAssurance,
      callId,
      args.prompt,
      new Date().toISOString(),
    );
    let gateAssurance = sessionState?.reviewAssurance;
    let prompt: ExecutedTaskPrompt;
    if (registered.kind === 'in_flight') {
      const rearmed = await rearmInterruptedReviewerDispatch(
        runtime,
        sessionId,
        eState,
        registered,
      );
      if (rearmed.kind === 'blocked') {
        throw buildEnforcementError(
          rearmed.code ?? 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
          rearmed.reason,
        );
      }
      gateAssurance = rearmed.assurance;
      const reRegistered = registerExecutedTaskPrompt(
        eState,
        rearmed.assurance,
        callId,
        args.prompt,
        new Date().toISOString(),
      );
      if (reRegistered.kind !== 'ready') {
        throw buildEnforcementError(
          'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
          reRegistered.kind === 'blocked'
            ? reRegistered.reason
            : 're-armed attempt is still reported in-flight',
        );
      }
      prompt = reRegistered.prompt;
    } else if (registered.kind === 'ready') {
      prompt = registered.prompt;
    } else {
      throw buildEnforcementError(
        'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
        registered.reason,
      );
    }
    args.description = 'FlowGuard reviewer task';
    args.prompt = prompt.canonicalPrompt;

    const result = enforceBeforeSubagentCall(eState, args, gateAssurance);
    if (result.allowed) {
      await persistAuthorizedDispatch(runtime, sessionId, prompt);
      return;
    }
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

// eslint-disable-next-line complexity -- the fail-closed obligation gate keeps every rejection condition explicit.
async function enforceReviewerObligationCheck(
  runtime: FlowGuardPluginRuntime,
  sessionState: SessionState | null,
): Promise<void> {
  const obligationResult = enforceReviewerObligation({
    obligations: sessionState?.reviewAssurance?.obligations ?? [],
    invocations: sessionState?.reviewAssurance?.invocations ?? [],
    reviewInvocationPolicy: sessionState?.policySnapshot?.reviewInvocationPolicy,
    maxIncoherentReviewerCaptureRetries:
      sessionState?.policySnapshot?.maxIncoherentReviewerCaptureRetries,
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

/** Deny implementation reviewer dispatch until every open prior challenge has current-digest author evidence. */
function enforceImplementationChallengeResolutionCheck(sessionState: SessionState | null): void {
  const hasPendingImplementationObligation = sessionState?.reviewAssurance?.obligations.some(
    (obligation) => obligation.obligationType === 'implement' && obligation.status === 'pending',
  );
  if (!hasPendingImplementationObligation) return;
  const unaddressed = projectUnaddressedImplementationChallengeIds(
    sessionState?.implReviewFindings,
    sessionState?.challengeResolutions ?? [],
    sessionState?.implementation?.digest,
  );
  if (unaddressed.length === 0) return;
  throw buildEnforcementError(
    'SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED',
    'Record current-digest author resolution evidence for every prior failing implementation challenge before dispatching the reviewer Task.',
  );
}

async function resolveHostToolStateOrThrow(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<{ sessDir: string; state: SessionState }> {
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
  const sessionState = await resolveEnforcement(runtime, sessionId, 'verdict');
  const result = enforceBeforeVerdict(eState, toolName, args, sessionState);
  if (result.allowed) return;
  runtime.log.warn('enforcement', 'blocked verdict submission', {
    tool: toolName,
    sessionId,
    code: result.code,
  });
  throw buildEnforcementError(result.code ?? 'INTERNAL_ERROR', result.reason ?? '');
}
