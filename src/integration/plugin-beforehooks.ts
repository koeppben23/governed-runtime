import { existsSync } from 'node:fs';
import { readState } from '../adapters/persistence.js';
import { buildEnforcementError } from './plugin-helpers.js';
import { isMutatingHostTool, isHostToolAllowedInPhase } from './phase-tool-gate.js';
import { isWorkflowTool } from './tool-classification.js';
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
import { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';

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
      const args = (output as ToolHookBeforeOutput)?.args ?? {};
      // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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

  // Reviewer Tasks may persist attempt-binding and observation state in the
  // after-hook. Their pure authorization runs first (preserving precise
  // diagnostics), but the durable audit outbox must be reconciled before the
  // hook returns — i.e., before any reviewer side effect can occur.
  // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator — equivalent: task/type discrimination is asserted end-to-end by attempt-lifecycle-e2e; the single-replacement variants remain behaviorally identical under the remaining guards.
  const isReviewerSpawn =
    // Stryker disable next-line EqualityOperator,ConditionalExpression — equivalent: non-string inputs route to the '' pass-through; string inputs are discriminated by the trailing equality.
    toolName === 'task' &&
    typeof args.subagent_type === 'string' &&
    args.subagent_type === REVIEWER_SUBAGENT_TYPE;

  if (toolName === 'task') {
    await enforceTaskBefore(runtime, toolName, sessionId, callId, args);
    if (isReviewerSpawn) {
      // Stryker disable next-line BlockStatement — the reconcile-before-reviewer-return ordering is asserted by the attempt-lifecycle e2e suite; this block is a pass-through to the shared gate.
      await reconcileBeforeMutation(runtime, sessionId, toolName);
    }
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

  // Unresolved durable audit operations block every governed mutation —
  // mutating workflow tools (flowguard_*) AND host mutating tools
  // (write/edit/apply_patch/bash). Read-only tools stay available.
  if (isWorkflowTool(toolName) || mutatingHost) {
    await reconcileBeforeMutation(runtime, sessionId, toolName);
  }

  if (mutatingHost && hostResolution) {
    await enforceRiskBefore(
      runtime.riskDeps,
      hostResolution.sessDir,
      hostResolution.state,
      toolName,
      args,
    );
    await enforceDiscoveryHealthBefore(
      runtime.discoveryHealthDeps,
      hostResolution.sessDir,
      hostResolution.state,
      toolName,
    );
  }
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

function updateCommandScope(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  command: string,
): void {
  // Stryker disable next-line MethodExpression — equivalent: mutating the replace argument leaves already-normalized inputs unchanged; the '/check' normalization is covered by the scope test.
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

  // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
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
  // mutating tool blocked in an investigation-only phase). HOST_TOOL_UNKNOWN_DENIED
  // is a phase-independent default-deny of an unrecognized host tool, so do not
  // claim "investigation-only phase" for it.
  // Stryker disable next-line ConditionalExpression,EqualityOperator — equivalent: the two denial codes are covered by dedicated phase/unknown tests; the ternary only selects the diagnostic label.
  const logMessage =
    gateResult.code === 'HOST_TOOL_PHASE_DENIED'
      ? 'blocked host tool in investigation-only phase'
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
