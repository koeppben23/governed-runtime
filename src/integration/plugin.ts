/**
 * @module integration/plugin
 * @description OpenCode Plugin composition root. Creates workspace, logger,
 * audit, and orchestrator services, then wires hook handlers.
 *
 * Risk classification enforcement extracted to plugin-risk.ts (FG-REL-042).
 * After-hook processing extracted to plugin-afterhooks.ts.
 *
 * @version v10
 */

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from '@opencode-ai/plugin';

import { HttpTimestampAuthorityProvider } from '../audit/rfc-3161-http-provider.js';
import { PkijsTimestampVerifier } from '../audit/rfc-3161-pkijs-verifier.js';
import type { FlowGuardPolicy } from '../config/policy.js';
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
import { createOpenCodeHostAdapter } from './opencode-host-adapter.js';
import { createWorkspace } from './plugin-workspace.js';
import type { OrchestratorClient } from './review/orchestrator.js';
import { initHumanProjectionTelemetrySink } from '../telemetry/human-projection/sink.js';

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

// eslint-disable-next-line max-lines-per-function -- plugin runtime composition wires the workspace, logger, config, and every hook dependency together in one factory.
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

  const { log, config, disposeLogging } = await createPluginLogger(
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

  let currentSessionId = 'unknown';
  const adapter = createOpenCodeHostAdapter({
    client: typedClient,
    getSessionId: () => currentSessionId,
    directory: candidateWorktree ?? '',
    worktree: candidateWorktree ?? '',
    log,
  });

  const orchestratorDeps = createOrchestratorDeps(ws, log, typedClient, adapter);
  const toolTraceIds = new Map<string, string>();
  const activeCommandScopes = new Map<string, ActiveCommandScope>();
  const checkReworkContinuations = new Set<string>();
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

  const hooks = createFlowGuardPluginHooks({
    ws,
    log,
    adapterLog,
    riskDeps,
    discoveryHealthDeps,
    orchestratorDeps,
    auditDeps,
    toolTraceIds,
    activeCommandScopes,
    checkReworkContinuations,
    setCurrentSessionId: (sessionId) => {
      currentSessionId = sessionId;
    },
    logError,
  });

  // Use OpenCode's plugin teardown hook (Hooks.dispose) to flush + release log
  // sinks (OTLP shutdown + SIGUSR1 detach). OpenCode awaits dispose, giving the
  // OTLP batch exporter a real completion point — unlike global process-exit
  // listeners, this is per-instance and is not leaked across plugin inits.
  if (disposeLogging) {
    hooks.dispose = disposeLogging;
  }

  return hooks;
};

type PluginLogger = Awaited<ReturnType<typeof createPluginLogger>>['log'];
type PluginWorkspaceRuntime = ReturnType<typeof createWorkspace>;

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
    resolveCanonicalSessionDir: ws.resolveCanonicalSessionDir,
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
