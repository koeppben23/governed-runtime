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
import type { Plugin } from '@opencode-ai/plugin';
import { readState } from '../adapters/persistence.js';
import { createPluginLogger } from './plugin-logging.js';
import { toAdapterLogger, runWithAdapterLoggerAsync } from '../logging/adapter-logger.js';
import {
  strictBlockedOutput,
  buildEnforcementError,
  getToolArgs,
  getToolMetadata,
} from './plugin-helpers.js';
import { isMutatingHostTool, isHostToolAllowedInPhase } from './phase-tool-gate.js';
import { trackFlowGuardEnforcement, trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import {
  runReviewOrchestration as runOrchestrator,
  type OrchestratorDeps,
} from './plugin-orchestrator.js';
import { runAudit as runAuditModule, type AuditDeps } from './plugin-audit.js';
import { HttpTimestampAuthorityProvider } from '../audit/rfc3161-http-provider.js';
import { PkijsTimestampVerifier } from '../audit/rfc3161-pkijs-verifier.js';
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
  resolveSessionIdFromMetadata,
  injectSessionIdIntoOutput,
} from './review/enforcement/extraction.js';

import type {
  ToolHookBeforeInput,
  ToolHookBeforeOutput,
  ToolHookAfterInput,
  ToolHookAfterOutput,
} from './types.js';

import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_REVIEW,
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

  const orchestratorDeps: OrchestratorDeps = {
    resolveFingerprint: ws.resolveFingerprint,
    getSessionDir: ws.getSessionDir,
    updateReviewAssurance: ws.updateReviewAssurance,
    blockReviewOutcome: ws.blockReviewOutcome,
    getEnforcementState: ws.getEnforcementState,
    log,
    client: typedClient,
    adapter,
  };

  const auditDeps: AuditDeps = {
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
    mode: config.policy.defaultMode ?? 'solo',
    tsaProvider: new HttpTimestampAuthorityProvider(),
    timestampVerifier: new PkijsTimestampVerifier(),
  };

  const riskDeps: RiskEnforcementDeps = {
    getSessionDir: ws.getSessionDir,
    getWorktreeRoot: () => auditWorktree,
  };

  const discoveryHealthDeps: DiscoveryHealthEnforcementDeps = {
    getSessionDir: ws.getSessionDir,
    getWorkspaceDir: () => ws.cachedWsDir,
  };

  async function resolveEnforcement(
    sessionId: string,
    context: 'subagent' | 'verdict',
  ): Promise<{ strictEnforcement: boolean; sessionState: SessionState | null }> {
    let sessionState: SessionState | null = null;
    let strictEnforcement = true;
    try {
      const sessDir = ws.getSessionDir(sessionId);
      if (sessDir) {
        sessionState = await readState(sessDir);
        if (sessionState) {
          strictEnforcement = sessionState.policySnapshot?.selfReview?.strictEnforcement === true;
        }
      }
    } catch {
      log.warn('enforcement', `Failed to read session state for ${context} enforcement check`, {
        sessionId,
      });
    }
    return { strictEnforcement, sessionState };
  }

  // ── Hook handlers ──────────────────────────────────────────────────────
  return {
    'tool.execute.before': async (input: unknown, output: unknown) => {
      return runWithAdapterLoggerAsync(adapterLog, async () => {
        const hookInput = input as ToolHookBeforeInput;
        const hookOutput = output as ToolHookBeforeOutput;
        const toolName: string = hookInput?.tool ?? '';
        const sessionId: string = hookInput?.sessionID ?? 'unknown';
        currentSessionId = sessionId;
        const args = hookOutput?.args ?? {};

        log.info('hook', 'tool.execute.before', { tool: toolName, sessionId });

        if (toolName === 'task') {
          const st = typeof args.subagent_type === 'string' ? args.subagent_type : '';
          if (st === REVIEWER_SUBAGENT_TYPE) {
            const eState = ws.getEnforcementState(sessionId);
            const { strictEnforcement } = await resolveEnforcement(sessionId, 'subagent');
            const result = enforceBeforeSubagentCall(eState, args, strictEnforcement);
            if (!result.allowed) {
              log.warn('enforcement', 'blocked subagent call', {
                tool: toolName,
                sessionId,
                code: result.code,
              });
              throw buildEnforcementError(result.code ?? 'INTERNAL_ERROR', result.reason ?? '');
            }
          } else if (st !== '') {
            log.warn('enforcement', 'blocked unauthorized subagent type', {
              tool: toolName,
              subagentType: st,
              sessionId,
            });
            throw buildEnforcementError(
              'SUBAGENT_TYPE_UNAUTHORIZED',
              `Subagent type '${st}' is not authorized by FlowGuard governance. ` +
                `Only '${REVIEWER_SUBAGENT_TYPE}' is allowed.`,
            );
          }
          return;
        }

        if (isMutatingHostTool(toolName)) {
          const sessDir = ws.getSessionDir(sessionId);
          if (!sessDir) return;

          if (!existsSync(sessDir)) {
            throw buildEnforcementError(
              'SESSION_DIR_NOT_FOUND',
              `FlowGuard session directory expected at "${sessDir}" but not found on disk. ` +
                `Run /hydrate to initialize the session.`,
              { sessionId, tool: toolName, sessDir, stateReadable: 'false' },
            );
          }

          let state: SessionState | null;
          try {
            state = await readState(sessDir);
          } catch (err) {
            log.warn('enforcement', 'Failed to read session state for phase gate check', {
              sessionId,
              tool: toolName,
              error: err instanceof Error ? err.message : String(err),
            });
            throw buildEnforcementError(
              'PLUGIN_ENFORCEMENT_UNAVAILABLE',
              `Cannot verify host tool phase gate — session state exists at ` +
                `"${sessDir}" but is unreadable ` +
                `(${err instanceof Error ? err.message : String(err)}). ` +
                `Run FlowGuard doctor, re-hydrate the session, or restore a valid session state.`,
              {
                sessionId,
                tool: toolName,
                stateFile: `${sessDir}/session-state.json`,
                stateReadable: 'false',
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }

          if (!state) {
            log.warn('enforcement', 'Session directory exists but no state file for phase gate', {
              sessionId,
              tool: toolName,
              sessDir,
            });
            throw buildEnforcementError(
              'PLUGIN_ENFORCEMENT_UNAVAILABLE',
              `Cannot verify host tool phase gate — session directory exists at ` +
                `"${sessDir}" but contains no state file. ` +
                `Run FlowGuard doctor, re-hydrate the session, or restore a valid session state.`,
              {
                sessionId,
                tool: toolName,
                stateFile: `${sessDir}/session-state.json`,
                stateReadable: 'false',
              },
            );
          }

          if (state.error) {
            throw buildEnforcementError(state.error.code, state.error.message, {
              sessionId,
              tool: toolName,
              recoveryHint: state.error.recoveryHint,
              occurredAt: state.error.occurredAt,
            });
          }

          const gateResult = isHostToolAllowedInPhase(toolName, state.phase);
          if (!gateResult.allowed) {
            log.warn('enforcement', 'blocked host tool in investigation-only phase', {
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

          await enforceRiskBefore(riskDeps, sessDir, state, toolName, args);
          await enforceDiscoveryHealthBefore(discoveryHealthDeps, sessDir, state, toolName);
        }

        if (!isFlowGuardVerdictTool(toolName)) return;

        for (const key of Object.keys(args)) {
          if (args[key] === null) {
            delete args[key];
          }
        }

        const eState = ws.getEnforcementState(sessionId);
        const { strictEnforcement: strict, sessionState } = await resolveEnforcement(
          sessionId,
          'verdict',
        );
        const result = enforceBeforeVerdict(eState, toolName, args, sessionState, strict);
        if (!result.allowed) {
          log.warn('enforcement', 'blocked verdict submission', {
            tool: toolName,
            sessionId,
            code: result.code,
          });
          throw buildEnforcementError(result.code ?? 'INTERNAL_ERROR', result.reason ?? '');
        }
      });
    },

    'tool.execute.after': async (input: unknown, output: unknown) => {
      return runWithAdapterLoggerAsync(adapterLog, async () => {
        const hookInput = input as ToolHookAfterInput;
        const hookOutput = output as ToolHookAfterOutput;
        const toolName: string = hookInput?.tool ?? '';
        const sessionId: string = hookInput?.sessionID ?? 'unknown';
        currentSessionId = sessionId;
        const now = new Date().toISOString();

        log.info('hook', 'tool.execute.after', { tool: toolName, sessionId });

        if (
          toolName === TOOL_FLOWGUARD_PLAN ||
          toolName === TOOL_FLOWGUARD_IMPLEMENT ||
          toolName === TOOL_FLOWGUARD_ARCHITECTURE ||
          toolName === TOOL_FLOWGUARD_REVIEW
        ) {
          try {
            trackFlowGuardEnforcement(
              ws.getEnforcementState(sessionId),
              toolName,
              input,
              output,
              now,
            );
          } catch (err) {
            logError('enforcement tracking failed', err);
          }
        } else if (toolName === 'task') {
          const taskArgs = getToolArgs(input);
          let resolvedChildSessionId: string | null = null;
          if (taskArgs.subagent_type === REVIEWER_SUBAGENT_TYPE) {
            const metadata = getToolMetadata(hookOutput);
            const callID = hookInput.callID ?? '';
            resolvedChildSessionId = resolveSessionIdFromMetadata(metadata);
            if (!resolvedChildSessionId && callID) {
              resolvedChildSessionId = `derived:call:${callID}`;
            }
            if (resolvedChildSessionId) {
              hookOutput.output = injectSessionIdIntoOutput(
                hookOutput.output,
                resolvedChildSessionId,
              );
            }
          }

          try {
            trackTaskEnforcement(ws.getEnforcementState(sessionId), input, hookOutput, now);
          } catch (err) {
            logError('enforcement tracking failed', err);
          }

          if (taskArgs.subagent_type === REVIEWER_SUBAGENT_TYPE) {
            await handleHostTaskEvidence(
              { ws, log, logError },
              sessionId,
              resolvedChildSessionId,
              now,
              hookOutput,
            );
          }
        }

        if (toolName === 'bash') {
          await enforceRiskAfterBash(riskDeps, sessionId, hookOutput);
          await enforceDiscoveryHealthAfterBash(discoveryHealthDeps, sessionId, hookOutput);
        }

        await runOrchestrator(orchestratorDeps, {
          toolName,
          input,
          output: hookOutput,
          sessionId,
          now,
        });

        if (!toolName.startsWith(FG_PREFIX)) return;

        await ws.runSerializedForSession(sessionId, async () => {
          const auditResult = await runAuditModule(auditDeps, toolName, input, output, sessionId);
          if (auditResult?.block) {
            hookOutput.output = strictBlockedOutput(auditResult.code!, {
              reason: auditResult.reason ?? 'audit persistence failed',
            });
          }
        });
      });
    },

    event: async ({ event }) => {
      return runWithAdapterLoggerAsync(adapterLog, async () => {
        const eventDeps: EventHandlerDeps = {
          log,
          cleanupSession: (sessionId: string) => {
            ws.invalidateChainState(sessionId);
          },
          async emitSessionErrorAudit(sessionId, errorMessage, detail) {
            const sessDir = ws.getSessionDir(sessionId);
            if (!sessDir) return;
            await appendReviewAuditEvent(sessDir, sessionId, 'unknown', 'error:SESSION_ERROR', {
              code: 'SESSION_ERROR',
              message: errorMessage,
              ...detail,
            });
          },
        };
        await handleEvent(eventDeps, event);
      });
    },

    'experimental.session.compacting': async (input, output) => {
      return runWithAdapterLoggerAsync(adapterLog, async () => {
        const sessionId = input.sessionID ?? '';
        if (!sessionId) return;

        const compactionDeps: CompactionDeps = {
          getSessionDir: ws.getSessionDir,
          log,
        };
        const context = await buildCompactionContext(compactionDeps, sessionId);
        if (context) {
          output.context.push(context);
        }
      });
    },
  };
};
