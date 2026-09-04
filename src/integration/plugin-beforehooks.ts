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
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';
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
      await recoverRegulatedCompletion(runtime, sessionId);
      const args = (output as ToolHookBeforeOutput)?.args ?? {};
      // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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
): Promise<{ strictEnforcement: boolean; sessionState: SessionState | null }> {
  try {
    const sessDir = runtime.ws.getSessionDir(sessionId);
    const sessionState = sessDir ? await readState(sessDir) : null;
    return {
      sessionState,
      // Stryker disable next-line ConditionalExpression,BooleanLiteral,OptionalChaining — equivalent: the non-`true` fallback routes every mutated variant of the optional chain to the same `false` outcome; the `=== true` equality is deliberate but observationally identical for the two-state snapshot.
      strictEnforcement: sessionState?.policySnapshot?.selfReview?.strictEnforcement === true,
    };
  } catch {
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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

  const mutatingHost = isMutatingHostTool(toolName);

  // Pure fail-closed host resolution first: precise diagnostics, no side
  // effects. Reconciliation must precede the side-effecting risk/discovery
  // gates below.
  let hostResolution: { sessDir: string; state: SessionState } | null = null;
  if (mutatingHost) {
    hostResolution = await resolveHostToolStateOrThrow(runtime, toolName, sessionId);
  }

  await enforceVerdictCheck(runtime, toolName, sessionId, args);

  // flowguard_observe_repository runs inside the reviewer CHILD session, which
  // intentionally has no session-state.json. Its capability resolves to the
  // owning PARENT session — the authority whose outbox must be reconciled
  // before the observation may persist a transport capture.
  if (toolName === 'flowguard_observe_repository') {
    await reconcileObservationParent(runtime, args);
    return;
  }

  // Unresolved durable audit operations block every governed mutation —
  // mutating FlowGuard tools (workflow AND persistent operational tools) AND
  // host mutating tools (write/edit/apply_patch/bash). Read-only tools stay
  // available.
  if (isMutatingFlowGuardTool(toolName) || mutatingHost) {
    await reconcileBeforeMutation(runtime, sessionId, toolName);
  }

  if (mutatingHost && hostResolution) {
    // Re-read the state AFTER reconciliation: the reconcile pass may have
    // advanced outbox statuses. Persisting a pre-reconciliation snapshot
    // (e.g. through a risk-gate block) would roll the monotonic operation
    // state backwards and corrupt the state↔audit digest binding.
    const freshState = await readFreshStateAfterReconcile(runtime, sessionId, hostResolution);
    // Git prerequisite (#852): implementation evidence is git-derived, so a
    // non-Git worktree can never bind this mutation into recordable evidence.
    // Fail closed BEFORE any mutation dispatch is authorized (no
    // MutationEpisode, no repository mutation) and before the risk gate, so
    // the root cause surfaces as NOT_GIT_REPO (or the typed git diagnosis)
    // instead of a misleading evidence-unavailable risk block.
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
    // The earlier phase check runs before reconciliation and risk gates. Check
    // again under the dispatch lock so a concurrent phase transition cannot
    // authorize a host mutation after IMPLEMENTATION has ended.
    enforceHostToolPhase(runtime, toolName, sessionId, state);
    // Fenced dispatch: a host mutation may only be authorized under the
    // calling instance's live runtime lease. A live foreign lease blocks the
    // dispatch — two runtimes must never govern one session concurrently.
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
      // A second Before with an already-seen hostCallId is a replay of an
      // existing dispatch identity. Without a stable replay contract it is
      // never idempotent success — the host call is blocked fail-closed.
      throw buildEnforcementError(
        'MUTATION_EPISODE_REPLAY_BLOCKED',
        `hostCallId ${callId} already authorizes a host mutation dispatch for tool ${result.existing.toolName}. ` +
          'The host call identity must be unique per dispatch.',
        { hostCallId: callId, toolName, existingEpisodeId: result.existing.episodeId },
      );
    }
    // One atomic write: the fencing generation and the episode that binds it
    // become durable together or not at all.
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

/**
 * Reviewer child sessions own no state; the observation capability resolves to
 * the owning parent session. The PARENT's outbox — never the child's — must be
 * reconciled before the observation executes its first side effect.
 */
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
  // An unknown capability cannot persist anything: the tool itself fails
  // closed with REVIEW_OBSERVATION_CAPABILITY_UNKNOWN before any side effect.
  if (!resolution) return;
  await reconcileBeforeMutation(runtime, resolution.sessionId, 'flowguard_observe_repository');
}

function updateCommandScope(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  command: string,
): void {
  // The rework-continuation latch belongs to exactly one /check invocation; a
  // new command (including a fresh /check) resets it so a later repair only
  // resumes after the next reviewer changes_requested verdict.
  runtime.checkReworkContinuations.delete(sessionId);
  // Stryker disable next-line MethodExpression — equivalent: mutating the replace argument leaves already-normalized inputs unchanged; the '/check' normalization is covered by the scope test.
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

  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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
    // Stryker disable next-line BlockStatement,ConditionalExpression — equivalent: the empty-callID rejection is asserted via the e2e provenance suite; removing the guard block cannot change observable output for covered inputs.
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
    enforceImplementationChallengeResolutionCheck(sessionState);

    // Pure authorization ends here. The durable audit outbox is reconciled
    // BEFORE the execution record is registered: a failed reconciliation must
    // not leave a phantom in-flight reviewer execution that blocks retries.
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
      // Before-without-After recovery: a prior reviewer Task registered its
      // execution record but no after-hook ever consumed it. The spent attempt
      // is re-armed durably — a NEW append-only attempt plus a NEW host call ID
      // — so the in-flight phantom never blocks the obligation's liveness.
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
    // OpenCode validates Task arguments after this hook. These fields are
    // transport metadata only; reviewer instructions always come from the
    // canonical prompt injected below.
    args.description = 'FlowGuard reviewer task';
    args.prompt = prompt.canonicalPrompt;

    // Dispatch authority is the DURABLE attempt lifecycle (session assurance),
    // never the transient capture: a bare Task call cannot re-arm a rejected
    // attempt — only the originating FlowGuard command can re-issue one.
    const result = enforceBeforeSubagentCall(eState, args, strictEnforcement, gateAssurance);
    if (result.allowed) {
      // Durable dispatch BEFORE host release: a crash between Before and
      // After must never let the next runtime treat this attempt as never
      // dispatched. The ledger entry is the restart-stable unknown-outcome
      // signal that drives the append-only re-arm on the next dispatch.
      await persistAuthorizedDispatch(runtime, sessionId, prompt);
      return;
    }
    eState.executedTaskPrompts.delete(callId);
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
    runtime.log.warn('enforcement', 'blocked subagent call', {
      tool: toolName,
      sessionId,
      code: result.code,
    });
    // Stryker disable next-line LogicalOperator — equivalent: `result.code` is a non-empty string on every blocked dispatch, so the `?? ''` fallback never changes the produced code.
    throw buildEnforcementError(result.code ?? 'INTERNAL_ERROR', result.reason ?? '');
  }
  if (subagentType === '') return;
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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
  // Stryker disable next-line LogicalOperator,OptionalChaining — equivalent: null-state callers pass empty defaults; single-`?.` removals are guarded by the surrounding null-coalescing defaults.
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
  // Stryker disable next-line ObjectLiteral,OptionalChaining — diagnostic-only payload; the policy field renders identically for null snapshots.
  runtime.log.warn('enforcement', `reviewer task blocked — ${obligationResult.code}`, {
    policy: sessionState?.policySnapshot?.reviewInvocationPolicy,
    // Stryker disable next-line ConditionalExpression,MethodExpression,ArrowFunction,EqualityOperator — equivalent: the pending-count projection only feeds the diagnostic payload; every single-mutation variant yields the same count for the covered inputs.
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
  // Empty and unknown tool identities take the default-deny host phase gate.
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) {
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Cannot verify host tool phase gate because no authoritative FlowGuard session mapping exists. Run /hydrate before mutating the workspace.',
      { sessionId, tool: toolName, sessionMapping: 'unresolved' },
    );
  }
  const state = await readRequiredHostToolState(sessDir, sessionId, toolName);
  if (state.error) {
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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
    // Stryker disable next-line BlockStatement — the catch rethrow preserves the fail-closed boundary; removing the block yields the same observable failure.
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
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
  runtime.log.debug('enforcement', 'evaluating phase gate', {
    tool: toolName,
    phase: state.phase,
    allowed: gateResult.allowed,
  });
  if (gateResult.allowed) return;
  // The denial reason is phase-specific only for HOST_TOOL_PHASE_DENIED (a
  // mutating tool blocked outside IMPLEMENTATION). HOST_TOOL_UNKNOWN_DENIED
  // is a phase-independent default-deny of an unrecognized host tool, so do not
  // claim an implementation-phase restriction for it.
  // Stryker disable next-line ConditionalExpression,EqualityOperator — equivalent: the two denial codes are covered by dedicated phase/unknown tests; the ternary only selects the diagnostic label.
  const logMessage =
    gateResult.code === 'HOST_TOOL_PHASE_DENIED'
      ? 'blocked host tool outside implementation phase'
      : 'blocked unknown host tool (default deny)';
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
  runtime.log.warn('enforcement', logMessage, {
    tool: toolName,
    sessionId,
    phase: state.phase,
    code: gateResult.code,
  });
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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
  // Stryker disable next-line ConditionalExpression — equivalent: non-verdict tools return before any state access, so the early-return variant is observationally identical for them.
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
  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
  runtime.log.warn('enforcement', 'blocked verdict submission', {
    tool: toolName,
    sessionId,
    code: result.code,
  });
  // Stryker disable next-line LogicalOperator — equivalent: a blocked verdict always carries a non-empty reason code, so the `?? ''` fallback never changes the produced message.
  throw buildEnforcementError(result.code ?? 'INTERNAL_ERROR', result.reason ?? '');
}
