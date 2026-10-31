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
import {
  createReviewerExecutionWatchdog,
  type ReviewerExecutionWatchdog,
} from './reviewer-execution-watchdog.js';
import {
  createReviewerExecutionFailurePersister,
  createReviewerExecutionTerminalReader,
} from './reviewer-execution-failure.js';
import { buildEnforcementError } from './blocked-result.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { ReviewerCaptureController } from './reviewer-capture.js';
import { attachReviewerCaptureHooks } from './plugin-reviewer-capture.js';

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
  const {
    ws,
    log,
    adapterLog,
    config,
    configReadError,
    client,
    auditWorktree,
    resolveSessionPolicy,
    logError,
  } = input;
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
  const hooks = createFlowGuardPluginHooks({
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
  });
  attachReviewerOutputCapHook(hooks, {
    config,
    configReadError,
    log,
    failures: reviewerOutputCapFailures,
    client,
    ws,
    orchestratorDeps,
  });
  attachReviewerExecutionWatchdog(hooks, {
    config,
    log,
    client,
    ws,
    orchestratorDeps,
    failures: reviewerExecutionFailures,
  });
  if (orchestratorDeps.reviewerCapture) {
    attachReviewerCaptureHooks(hooks, orchestratorDeps.reviewerCapture, client);
  }
  return hooks;
}

function attachReviewerOutputCapHook(
  hooks: Awaited<ReturnType<Plugin>>,
  deps: {
    readonly config: FlowGuardConfig;
    readonly configReadError?: unknown;
    readonly log: PluginLogger;
    readonly failures: Map<string, ReviewerOutputCapFailure>;
    readonly client: OrchestratorClient;
    readonly ws: PluginWorkspaceRuntime;
    readonly orchestratorDeps: OrchestratorDeps;
  },
): void {
  hooks['chat.params'] = createReviewerOutputCapHook({
    config: deps.config,
    configReadError: deps.configReadError,
    log: deps.log,
    failures: deps.failures,
    persistFailure: createReviewerOutputCapFailurePersister({
      client: deps.client,
      ws: deps.ws,
      orchestratorDeps: deps.orchestratorDeps,
      log: deps.log,
    }),
  });
}

function finishNativeTaskWatchdog(
  watchdog: ReviewerExecutionWatchdog,
  input: { readonly sessionID: string; readonly callID?: string },
  childSessionId: string | undefined,
): void {
  watchdog.finishTask({
    ...(typeof input.callID === 'string' && input.callID.length > 0
      ? { callId: input.callID }
      : {}),
    parentSessionId: input.sessionID,
    ...(childSessionId === undefined ? {} : { childSessionId }),
  });
}

function attachReviewerExecutionWatchdog(
  hooks: Awaited<ReturnType<Plugin>>,
  deps: {
    readonly config: FlowGuardConfig;
    readonly log: PluginLogger;
    readonly client: OrchestratorClient;
    readonly ws: PluginWorkspaceRuntime;
    readonly orchestratorDeps: OrchestratorDeps;
    readonly failures: Map<string, ReviewerExecutionFailure>;
  },
): ReviewerExecutionWatchdog {
  const watchdog = createReviewerExecutionWatchdog({
    config: deps.config.reviewer,
    client: deps.client,
    log: deps.log,
    failures: deps.failures,
    capture: deps.orchestratorDeps.reviewerCapture,
    persistFailure: createReviewerExecutionFailurePersister(deps),
  });
  const isTerminal = createReviewerExecutionTerminalReader(deps);

  const cap = hooks['chat.params'];
  hooks['chat.params'] = async (input, output) => {
    await cap?.(input, output);
    if (input.agent === REVIEWER_SUBAGENT_TYPE) await watchdog.onReviewerRequest(input.sessionID);
  };

  const before = hooks['tool.execute.before'];
  hooks['tool.execute.before'] = async (input, output) => {
    await before?.(input, output);
    if (isNativeReviewerTaskBefore(output)) {
      if (typeof input.callID === 'string' && input.callID.length > 0) {
        watchdog.onTaskAuthorized(input.sessionID, input.callID);
      }
      return;
    }
    watchdog.onToolStart(input.sessionID, input.callID);
  };

  const after = hooks['tool.execute.after'];
  hooks['tool.execute.after'] = async (input, output) => {
    if (isNativeReviewerTaskAfter(input)) {
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
        await after?.(input, output);
        if (await isTerminal(identity)) {
          finishNativeTaskWatchdog(watchdog, input, identity.childSessionId);
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
      return;
    }
    try {
      await after?.(input, output);
    } finally {
      watchdog.onToolEnd(input.sessionID, input.callID);
    }
  };

  return watchdog;
}

function createFlowGuardPluginHooks(runtime: FlowGuardPluginRuntime): Awaited<ReturnType<Plugin>> {
  return {
    'command.execute.before': (input: unknown, output: unknown) =>
      commandBefore(runtime, input, output),
    'tool.execute.before': async (input: unknown, output: unknown) => {
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
        return;
      }
      await toolBefore(runtime, input, output);
    },
    'tool.execute.after': async (input: unknown, output: unknown) => {
      // Native Task text is transcript-only. Its dedicated after boundary
      // performs same-child structured capture and evidence binding before the
      // result reaches the parent agent.
      if (isNativeReviewerTaskAfter(input)) {
        await nativeReviewTaskAfter(runtime, input, output);
        return;
      }
      await toolAfter(runtime, input, output);
    },
    event: ({ event }) => handlePluginEvent(runtime, event),
    'experimental.session.compacting': (input, output) => handleCompaction(runtime, input, output),
  };
}
