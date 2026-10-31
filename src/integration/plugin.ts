/**
 * @module integration/plugin
 * @description OpenCode Plugin composition root. Creates workspace, logger,
 * audit, and orchestrator services, then wires hook handlers.
 *
 * Risk classification enforcement extracted to plugin-risk.ts (FG-REL-042).
 * After-hook processing extracted to plugin-afterhooks.ts.
 *
 * @version v11
 */

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from '@opencode-ai/plugin';

import { HttpTimestampAuthorityProvider } from '../audit/rfc-3161-http-provider.js';
import { PkijsTimestampVerifier } from '../audit/rfc-3161-pkijs-verifier.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import type { FlowGuardConfig } from '../config/flowguard-config.js';
import { repoConfigPath } from '../adapters/persistence.js';
import { toAdapterLogger } from '../logging/adapter-logger.js';
import { serializeError } from '../logging/error-serialize.js';
import type { SessionState } from '../state/schema.js';
import type { AuditDeps } from './plugin-audit.js';
import { commandBefore, toolBefore } from './plugin-beforehooks.js';
import { toolAfter, handlePluginEvent, handleCompaction } from './plugin-afterhooks.js';
import type { DiscoveryHealthEnforcementDeps } from './plugin-discovery-health.js';
import { createPluginLogger } from './plugin-logging.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import type { OrchestratorDeps } from './plugin-orchestrator.js';
import type { RiskEnforcementDeps } from './plugin-risk.js';
import { type ActiveCommandScope, type FlowGuardPluginRuntime } from './plugin-shared.js';
import { OpenCodeHostAdapter, HostCapabilityMismatchError } from './opencode-host-adapter.js';
import { createWorkspace } from './plugin-workspace.js';
import type { OrchestratorClient, ReviewerExecutionFailure } from './review/types.js';
import {
  isNativeReviewerTaskAfter,
  isNativeReviewerTaskBefore,
  nativeReviewTaskAfter,
  nativeReviewTaskBefore,
} from './review/dispatch/native-task-review.js';
import { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';
import { evaluateProofGraphGate } from '../audit/proofgraph/gate.js';
import { renderPlanClaimDeclarations } from '../presentation/index.js';
import { initHumanProjectionTelemetrySink } from '../telemetry/human-projection/sink.js';
import {
  createReviewerOutputCapHook,
  type ReviewerOutputCapFailure,
} from './reviewer-output-cap.js';
import { createReviewerOutputCapFailurePersister } from './reviewer-output-cap-failure.js';
import { createReviewerExecutionWatchdog } from './reviewer-execution-watchdog.js';
import {
  createReviewerExecutionFailurePersister,
  createReviewerExecutionTerminalReader,
} from './reviewer-execution-failure.js';
import { buildEnforcementError } from './blocked-result.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { ReviewerCaptureController } from './reviewer-capture.js';

export function isUsableWorktree(worktree: string | undefined): boolean {
  if (!worktree) return false;
  const normalized = path.resolve(worktree);
  if (normalized === '/' || /^[A-Za-z]:[\\/]?$/.test(normalized)) return false;
  try {
    if (!existsSync(normalized)) return false;
    return statSync(normalized).isDirectory();
  } catch {
    return false;
  }
}

export const FlowGuardAuditPlugin: Plugin = async ({ client, directory, worktree }) => {
  const candidateWorktree = worktree || directory;
  const auditWorktree = isUsableWorktree(candidateWorktree) ? candidateWorktree : undefined;

  const ws = createWorkspace({ auditWorktree });

  await resolveWorkspaceFingerprint(ws);

  const { log, config, configReadError, disposeLogging } = await createPluginLogger(
    client,
    ws.cachedWsDir,
    auditWorktree,
    ws.cachedFingerprint,
    auditWorktree ? repoConfigPath(auditWorktree) : undefined,
  );

  initHumanProjectionTelemetrySink(config.humanProjectionTelemetry.enabled);

  const adapterLog = toAdapterLogger(log);

  function logError(message: string, err: unknown): void {
    log.error('audit', message, { error: serializeError(err) });
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

  const adapter = new OpenCodeHostAdapter({
    client: typedClient,
    directory: candidateWorktree ?? '',
    worktree: candidateWorktree ?? '',
  });

  await initializeHostAdapter(adapter, log, disposeLogging);

  const hooks = createFlowGuardHooks({
    ws,
    log,
    adapterLog,
    config,
    configReadError,
    client: typedClient,
    auditWorktree,
    resolveSessionPolicy,
    logError,
  });

  hooks.dispose = async () => {
    try {
      await adapter.shutdown();
    } finally {
      await disposeLogging?.();
    }
  };

  return hooks;
};

type PluginLogger = Awaited<ReturnType<typeof createPluginLogger>>['log'];
type PluginWorkspaceRuntime = ReturnType<typeof createWorkspace>;
type PluginLoggingRuntime = Awaited<ReturnType<typeof createPluginLogger>>;

async function resolveWorkspaceFingerprint(ws: PluginWorkspaceRuntime): Promise<void> {
  try {
    await ws.resolveFingerprint();
  } catch (err) {
    console.warn(
      '[flowguard] workspace fingerprint resolution failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function initializeHostAdapter(
  adapter: OpenCodeHostAdapter,
  log: PluginLogger,
  disposeLogging: PluginLoggingRuntime['disposeLogging'],
): Promise<void> {
  // Fail-closed boot: on any initialization or capability failure, release the
  // resources acquired above (adapter + logging/OTLP/reloader) before
  // rethrowing. Without this, repeated failed boots would leak SIGUSR1
  // listeners and OTLP exporter timers while hooks.dispose never exists.
  try {
    await adapter.initialize();
    const capabilityValidation = await adapter.validateCapabilities();
    if (!capabilityValidation.valid) {
      throw new HostCapabilityMismatchError(capabilityValidation.mismatches);
    }
    log.warn('adapter', 'host capabilities are contract-attested only', {
      code: 'HOST_CAPABILITY_UNVERIFIED',
      runtimeVerified: capabilityValidation.runtimeVerified,
      contractAttested: capabilityValidation.contractAttested,
    });
  } catch (err) {
    try {
      await adapter.shutdown();
    } finally {
      await disposeLogging?.();
    }
    throw err;
  }
}

function createOrchestratorDeps(
  ws: PluginWorkspaceRuntime,
  log: PluginLogger,
  client: OrchestratorClient,
): OrchestratorDeps {
  return {
    reviewerCapture: new ReviewerCaptureController(),
    resolveSessionAuthority: (sid) => ws.resolveSessionAuthority(sid),
    updateReviewAssurance: ws.updateReviewAssurance,
    blockReviewOutcome: ws.blockReviewOutcome,
    getEnforcementState: ws.getEnforcementState,
    log,
    client,
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
    resolveSessionAuthority: (sid) => ws.resolveSessionAuthority(sid),
    resolveSessionPolicy,
    initChain: ws.initChain,
    invalidateChainState: ws.invalidateChainState,
    appendAndTrack: ws.appendAndTrack,
    nextDecisionSequence: ws.nextDecisionSequence,
    log,
    logError,
    mode: defaultMode ?? 'team',
    tsaProvider: new HttpTimestampAuthorityProvider(),
    timestampVerifier: new PkijsTimestampVerifier(),
  };
}

interface CreateFlowGuardHooksInput {
  readonly ws: PluginWorkspaceRuntime;
  readonly log: PluginLogger;
  readonly adapterLog: FlowGuardPluginRuntime['adapterLog'];
  readonly config: FlowGuardConfig;
  readonly configReadError?: unknown;
  readonly client: OrchestratorClient;
  readonly auditWorktree: string | undefined;
  readonly resolveSessionPolicy: (
    sessDir: string | null,
  ) => Promise<{ policy: FlowGuardPolicy; state: SessionState | null }>;
  readonly logError: (message: string, err: unknown) => void;
}

function createFlowGuardHooks(input: CreateFlowGuardHooksInput): Awaited<ReturnType<Plugin>> {
  const { ws, log, adapterLog, config, client, auditWorktree, resolveSessionPolicy, logError } =
    input;
  const orchestratorDeps = createOrchestratorDeps(ws, log, client);
  const toolTraceIds = new Map<string, string>();
  const toolLatencyStarts = new Map<string, number>();
  const activeCommandScopes = new Map<string, ActiveCommandScope>();
  const checkReworkContinuations = new Set<string>();
  const reviewerOutputCapFailures = new Map<string, ReviewerOutputCapFailure>();
  const reviewerExecutionFailures = new Map<string, ReviewerExecutionFailure>();
  const auditDeps = createAuditDeps(
    ws,
    log,
    logError,
    config.policy.defaultMode,
    resolveSessionPolicy,
  );
  const riskDeps: RiskEnforcementDeps = {
    resolveSessionAuthority: (sid) => ws.resolveSessionAuthority(sid),
    getWorktreeRoot: () => auditWorktree,
  };
  const discoveryHealthDeps: DiscoveryHealthEnforcementDeps = {
    resolveSessionAuthority: (sid) => ws.resolveSessionAuthority(sid),
    getWorkspaceDir: () => ws.cachedWsDir,
  };
  const runtime: FlowGuardPluginRuntime = {
    ws,
    log,
    adapterLog,
    riskDeps,
    discoveryHealthDeps,
    orchestratorDeps,
    auditDeps,
    toolTraceIds,
    toolLatencyStarts,
    activeCommandScopes,
    checkReworkContinuations,
    reviewerOutputCapFailures,
    reviewerExecutionFailures,
    reviewerExecutionTimeoutMs: config.reviewer.executionTimeoutMs,
    logError,
  };
  return createFlowGuardPluginHooks(runtime, createReviewerServices(input, runtime));
}

/** Construct services before registration; never replace already-registered hooks. */
function createReviewerServices(input: CreateFlowGuardHooksInput, runtime: FlowGuardPluginRuntime) {
  const deps = {
    client: input.client,
    ws: runtime.ws,
    orchestratorDeps: runtime.orchestratorDeps,
    log: runtime.log,
  };
  const cap = createReviewerOutputCapHook({
    config: input.config,
    configReadError: input.configReadError,
    log: runtime.log,
    failures: runtime.reviewerOutputCapFailures,
    persistFailure: createReviewerOutputCapFailurePersister(deps),
  });
  const watchdog = createReviewerExecutionWatchdog({
    config: input.config.reviewer,
    client: input.client,
    log: runtime.log,
    failures: runtime.reviewerExecutionFailures,
    capture: runtime.orchestratorDeps.reviewerCapture,
    persistFailure: createReviewerExecutionFailurePersister(deps),
  });
  return {
    cap,
    watchdog,
    isTerminal: createReviewerExecutionTerminalReader(deps),
    client: input.client,
  };
}

type ReviewerServices = ReturnType<typeof createReviewerServices>;

async function handleNativeTaskCompletion(
  runtime: FlowGuardPluginRuntime,
  services: ReviewerServices,
  input: Parameters<NonNullable<Awaited<ReturnType<Plugin>>['tool.execute.after']>>[0],
  output: Parameters<NonNullable<Awaited<ReturnType<Plugin>>['tool.execute.after']>>[1],
): Promise<void> {
  const { watchdog, isTerminal } = services;
  const childSessionId = output.metadata?.sessionId;
  if (typeof childSessionId === 'string' && childSessionId.length > 0) {
    watchdog.onSerializationStart(childSessionId);
  }
  if (!input.callID) {
    throw buildEnforcementError(
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
      'Task completion has no exact authorized call ID; its watchdog was retained.',
    );
  }
  const identity = {
    parentSessionId: input.sessionID,
    callId: input.callID,
    ...(typeof childSessionId === 'string' ? { childSessionId } : {}),
  };
  try {
    await nativeReviewTaskAfter(runtime, input, output);
    if (await isTerminal(identity)) {
      watchdog.finishTask(identity);
      return;
    }
  } catch (err) {
    await watchdog.failTask(identity);
    throw err;
  }
  if (!(await watchdog.failTask(identity))) {
    throw buildEnforcementError(
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
      'Task outcome is unresolved; execution monitoring and the failure fence were retained.',
    );
  }
}

function handleCaptureEvent(
  capture: ReviewerCaptureController | undefined,
  client: OrchestratorClient,
  event: Parameters<NonNullable<Awaited<ReturnType<Plugin>>['event']>>[0]['event'],
): void {
  const childSessionId =
    event.type === 'session.idle'
      ? event.properties.sessionID
      : event.type === 'session.status' && event.properties.status.type === 'idle'
        ? event.properties.sessionID
        : undefined;
  // Abort can publish idle itself. Never await its reconciliation from an event subscriber.
  if (childSessionId) void capture?.reconcileOnIdle(client, childSessionId);
  if (event.type === 'message.updated') {
    void capture?.reconcileOnTerminalMessage(client, event.properties.info);
  }
}

function createFlowGuardPluginHooks(
  runtime: FlowGuardPluginRuntime,
  services: ReviewerServices,
): Awaited<ReturnType<Plugin>> {
  const capture = runtime.orchestratorDeps.reviewerCapture;
  const { cap, watchdog } = services;
  return {
    'chat.message': async (input, output) => {
      capture?.onMessage(input, output);
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      capture?.onMessages(output);
    },
    'chat.params': async (input, output) => {
      await cap(input, output);
      if (input.agent === REVIEWER_SUBAGENT_TYPE) await watchdog.onReviewerRequest(input.sessionID);
      capture?.onParams(input, output);
    },
    'command.execute.before': (input: unknown, output: unknown) =>
      commandBefore(runtime, input, output),
    'tool.execute.before': async (input, output) => {
      // The capture fence always runs first, including before another handler denies.
      capture?.beforeTool(input);
      // The governed reviewer Task is its own host-transport boundary. It must
      // not traverse the generic host-tool path because that path has no child
      // identity/dispatch semantics; nativeReviewTaskBefore performs the exact
      // durable authorization and canonical prompt injection instead.
      if (isNativeReviewerTaskBefore(output)) {
        await nativeReviewTaskBefore(
          runtime,
          input,
          output,
          (sessionId, toolName) =>
            reconcilePendingAuditOperations(runtime.auditDeps, sessionId, toolName),
          { evaluateProofGraphGate, renderPlanClaimDeclarations },
        );
        if (typeof input.callID === 'string' && input.callID.length > 0) {
          watchdog.onTaskAuthorized(input.sessionID, input.callID);
        }
        return;
      }
      await toolBefore(runtime, input, output);
      watchdog.onToolStart(input.sessionID, input.callID);
    },
    'tool.execute.after': async (input, output) => {
      // Native Task text is transcript-only. Its dedicated after boundary
      // performs same-child structured capture and evidence binding before the
      // result reaches the parent agent.
      if (isNativeReviewerTaskAfter(input)) {
        await handleNativeTaskCompletion(runtime, services, input, output);
        return;
      }
      try {
        await toolAfter(runtime, input, output);
      } finally {
        watchdog.onToolEnd(input.sessionID, input.callID);
      }
    },
    event: async ({ event }) => {
      await handlePluginEvent(runtime, event);
      handleCaptureEvent(capture, services.client, event);
    },
    'experimental.session.compacting': (input, output) => handleCompaction(runtime, input, output),
  };
}
