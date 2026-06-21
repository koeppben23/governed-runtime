/**
 * @module integration/plugin
 * @description OpenCode Plugin composition root. Creates workspace, logger,
 * audit, and orchestrator services, then wires hook handlers.
 *
 * Risk classification enforcement extracted to plugin-risk.ts (FG-REL-042).
 *
 * @version v10
 */

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode-ai/plugin';
import { readState } from '../adapters/persistence.js';
import { createPluginLogger } from './plugin-logging.js';
import {
  toAdapterLogger,
  runWithAdapterLoggerAsync,
  runWithTraceContextAsync,
  getLogTraceFields,
} from '../logging/adapter-logger.js';
import {
  strictBlockedOutput,
  buildEnforcementError,
  getToolArgs,
  getToolMetadata,
  getToolOutput,
  getToolCallID,
  isNativeEnforcementUnavailableDenial,
  getAutoAdvanceOverflow,
  getSessionLockSignal,
  getHostTaskFindingsRejection,
  getReviewIdentityRejection,
  getNativeAttestationRejection,
} from './plugin-helpers.js';
import { isMutatingHostTool, isHostToolAllowedInPhase } from './phase-tool-gate.js';
import { trackFlowGuardEnforcement, trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import {
  runReviewOrchestration as runOrchestrator,
  type OrchestratorDeps,
} from './plugin-orchestrator.js';
import { runAudit as runAuditModule, type AuditDeps } from './plugin-audit.js';
import { HttpTimestampAuthorityProvider } from '../audit/rfc-3161-http-provider.js';
import { PkijsTimestampVerifier } from '../audit/rfc-3161-pkijs-verifier.js';
import { createWorkspace } from './plugin-workspace.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import { handleEvent, type EventHandlerDeps } from './plugin-events.js';
import { appendReviewAuditEvent } from './review/audit-events.js';
import { buildCompactionContext, type CompactionDeps } from './plugin-compaction.js';
import type { SessionState } from '../state/schema.js';
import type { FlowGuardPolicy } from '../config/policy.js';

import {
  enforceBeforeVerdict,
  enforceBeforeSubagentCall,
} from './review/enforcement/enforcement.js';
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

import type {
  CommandHookBeforeInput,
  ToolHookBeforeInput,
  ToolHookBeforeOutput,
  ToolHookAfterInput,
  ToolHookAfterOutput,
} from './types.js';
import { recordUserDecisionIntentFromCommand } from './user-decision-intent.js';

import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_HYDRATE,
  isFlowGuardVerdictTool,
} from './tool-names.js';
import type { OrchestratorClient } from './review/orchestrator.js';
import { createOpenCodeHostAdapter } from './opencode-host-adapter.js';

import {
  type RiskEnforcementDeps,
  enforceRiskClassificationBefore as enforceRiskBefore,
  enforceRiskClassificationAfterBash as enforceRiskAfterBash,
} from './plugin-risk.js';
import {
  type DiscoveryHealthEnforcementDeps,
  enforceDiscoveryHealthBefore,
  enforceDiscoveryHealthAfterBash,
} from './plugin-discovery-health.js';

const FG_PREFIX = 'flowguard_';
const TRACE_REGISTRY_LIMIT = 1000;

export function isUsableWorktree(worktree: string | undefined): boolean {
  if (!worktree) return false;
  const normalized = path.resolve(worktree);
  if (normalized === '/' || /^[A-Za-z]:[\\/]?$/.test(normalized)) return false;
  try {
    const gitPath = path.join(normalized, '.git');
    if (!existsSync(gitPath)) return false;
    const st = statSync(gitPath);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

export const FlowGuardAuditPlugin: Plugin = async ({ client, directory, worktree }) => {
  const candidateWorktree = worktree || directory;
  const auditWorktree = isUsableWorktree(candidateWorktree) ? candidateWorktree : undefined;

  const ws = createWorkspace({ auditWorktree });

  try {
    await ws.resolveFingerprint();
  } catch (err) {
    console.warn(
      '[flowguard] workspace fingerprint resolution failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    );
  }

  const { log, config } = await createPluginLogger(
    client,
    ws.cachedWsDir,
    auditWorktree,
    ws.cachedFingerprint,
  );

  const adapterLog = toAdapterLogger(log);

  function logError(message: string, err: unknown): void {
    log.error('audit', message, { error: err instanceof Error ? err.message : String(err) });
  }

  async function resolveSessionPolicy(
    sessDir: string | null,
  ): Promise<{ policy: FlowGuardPolicy; state: SessionState | null }> {
    return resolvePluginSessionPolicy({
      sessDir,
      configDefaultMode: config.policy.defaultMode,
      log,
    });
  }

  const typedClient = client as OrchestratorClient;

  let currentSessionId = 'unknown';
  const adapter = createOpenCodeHostAdapter({
    client: typedClient,
    getSessionId: () => currentSessionId,
    directory: candidateWorktree ?? '',
    worktree: candidateWorktree ?? '',
  });

  const orchestratorDeps = createOrchestratorDeps(ws, log, typedClient, adapter);
  const toolTraceIds = new Map<string, string>();
  const auditDeps = createAuditDeps(
    ws,
    log,
    logError,
    config.policy.defaultMode,
    resolveSessionPolicy,
  );

  const riskDeps: RiskEnforcementDeps = {
    getSessionDir: ws.getSessionDir,
    getWorktreeRoot: () => auditWorktree,
  };

  const discoveryHealthDeps: DiscoveryHealthEnforcementDeps = {
    getSessionDir: ws.getSessionDir,
    getWorkspaceDir: () => ws.cachedWsDir,
  };

  return createFlowGuardPluginHooks({
    ws,
    log,
    adapterLog,
    riskDeps,
    discoveryHealthDeps,
    orchestratorDeps,
    auditDeps,
    toolTraceIds,
    setCurrentSessionId: (sessionId) => {
      currentSessionId = sessionId;
    },
    logError,
  });
};

type PluginLogger = Awaited<ReturnType<typeof createPluginLogger>>['log'];
type PluginWorkspaceRuntime = ReturnType<typeof createWorkspace>;
type AdapterLoggerRuntime = Parameters<typeof runWithAdapterLoggerAsync>[0];

function createOrchestratorDeps(
  ws: PluginWorkspaceRuntime,
  log: PluginLogger,
  client: OrchestratorClient,
  adapter: OrchestratorDeps['adapter'],
): OrchestratorDeps {
  return {
    resolveFingerprint: ws.resolveFingerprint,
    getSessionDir: ws.getSessionDir,
    updateReviewAssurance: ws.updateReviewAssurance,
    blockReviewOutcome: ws.blockReviewOutcome,
    getEnforcementState: ws.getEnforcementState,
    log,
    client,
    adapter,
  };
}

function createAuditDeps(
  ws: PluginWorkspaceRuntime,
  log: PluginLogger,
  logError: (message: string, err: unknown) => void,
  defaultMode: string | undefined,
  resolveSessionPolicy: AuditDeps['resolveSessionPolicy'],
): AuditDeps {
  return {
    resolveFingerprint: ws.resolveFingerprint,
    getSessionDir: ws.getSessionDir,
    resolveSessionPolicy,
    initChain: ws.initChain,
    invalidateChainState: ws.invalidateChainState,
    appendAndTrack: ws.appendAndTrack,
    nextDecisionSequence: ws.nextDecisionSequence,
    log,
    logError,
    cachedFingerprint: ws.cachedFingerprint,
    mode: defaultMode ?? 'team',
    tsaProvider: new HttpTimestampAuthorityProvider(),
    timestampVerifier: new PkijsTimestampVerifier(),
  };
}

interface FlowGuardPluginRuntime {
  readonly ws: PluginWorkspaceRuntime;
  readonly log: PluginLogger;
  readonly adapterLog: AdapterLoggerRuntime;
  readonly riskDeps: RiskEnforcementDeps;
  readonly discoveryHealthDeps: DiscoveryHealthEnforcementDeps;
  readonly orchestratorDeps: OrchestratorDeps;
  readonly auditDeps: AuditDeps;
  readonly toolTraceIds: Map<string, string>;
  readonly setCurrentSessionId: (sessionId: string) => void;
  readonly logError: (message: string, err: unknown) => void;
}

function createFlowGuardPluginHooks(runtime: FlowGuardPluginRuntime): Awaited<ReturnType<Plugin>> {
  return {
    'command.execute.before': (input: unknown, output: unknown) =>
      commandBefore(runtime, input, output),
    'tool.execute.before': (input: unknown, output: unknown) => toolBefore(runtime, input, output),
    'tool.execute.after': (input: unknown, output: unknown) => toolAfter(runtime, input, output),
    event: ({ event }) => handlePluginEvent(runtime, event),
    'experimental.session.compacting': (input, output) => handleCompaction(runtime, input, output),
  };
}

async function commandBefore(
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
      {
        sessionId,
      },
    );
    return { strictEnforcement: true, sessionState: null };
  }
}

async function toolBefore(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
  output: unknown,
): Promise<void> {
  return runWithAdapterLoggerAsync(runtime.adapterLog, async () => {
    const toolName = (input as ToolHookBeforeInput)?.tool ?? '';
    const sessionId = (input as ToolHookBeforeInput)?.sessionID ?? 'unknown';
    const traceId = getToolTraceId(runtime, input, 'before');
    return runWithTraceContextAsync(traceId, async () => {
      runtime.setCurrentSessionId(sessionId);
      const args = (output as ToolHookBeforeOutput)?.args ?? {};
      runtime.log.info('hook', 'tool.execute.before', {
        tool: toolName,
        sessionId,
        ...getLogTraceFields(),
      });
      await enforceBeforeRules(runtime, toolName, sessionId, args);
    });
  });
}

function getToolTraceId(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
  phase: 'before' | 'after',
): string {
  const hookInput = isRecord(input)
    ? (input as Partial<ToolHookBeforeInput & ToolHookAfterInput>)
    : {};
  if (typeof hookInput.callID === 'string' && hookInput.callID.length > 0) {
    return hookInput.callID;
  }

  const key = fallbackToolTraceKey(hookInput);
  if (!key) return randomUUID();

  if (phase === 'after') {
    const existing = runtime.toolTraceIds.get(key);
    if (existing) runtime.toolTraceIds.delete(key);
    return existing ?? randomUUID();
  }

  const traceId = randomUUID();
  if (runtime.toolTraceIds.size >= TRACE_REGISTRY_LIMIT) runtime.toolTraceIds.clear();
  runtime.toolTraceIds.set(key, traceId);
  return traceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fallbackToolTraceKey(
  input: Partial<ToolHookBeforeInput & ToolHookAfterInput>,
): string | null {
  if (typeof input.sessionID !== 'string' || typeof input.tool !== 'string') return null;
  return `${input.sessionID}:${input.tool}`;
}

async function enforceBeforeRules(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (toolName === 'task') {
    await enforceTaskBefore(runtime, toolName, sessionId, args);
    return;
  }
  await enforceMutatingToolCheck(runtime, toolName, sessionId, args);
  await enforceVerdictCheck(runtime, toolName, sessionId, args);
}

async function enforceTaskBefore(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : '';
  if (subagentType === REVIEWER_SUBAGENT_TYPE) {
    const eState = runtime.ws.getEnforcementState(sessionId);
    const { strictEnforcement } = await resolveEnforcement(runtime, sessionId, 'subagent');
    const result = enforceBeforeSubagentCall(eState, args, strictEnforcement);
    if (result.allowed) return;
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

async function enforceMutatingToolCheck(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (!isMutatingHostTool(toolName)) return;
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) return;
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
  if (gateResult.allowed) return;
  runtime.log.warn('enforcement', 'blocked host tool in investigation-only phase', {
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

async function toolAfter(
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
    return runWithTraceContextAsync(traceId, async () => {
      const now = new Date().toISOString();
      runtime.setCurrentSessionId(sessionId);
      runtime.log.info('hook', 'tool.execute.after', {
        tool: toolName,
        sessionId,
        ...getLogTraceFields(),
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

async function handlePluginEvent(runtime: FlowGuardPluginRuntime, event: unknown): Promise<void> {
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
          ...detail,
        });
      },
    };
    await handleEvent(eventDeps, event as Parameters<typeof handleEvent>[1]);
  });
}

async function handleCompaction(
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
