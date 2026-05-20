/**
 * @module integration/plugin
 * @description OpenCode Plugin composition root. Creates workspace, logger,
 * audit, and orchestrator services, then wires hook handlers.
 *
 * All behavior logic lives in extracted modules: plugin-workspace,
 * plugin-audit, plugin-orchestrator, plugin-enforcement-tracking,
 * plugin-review-state, plugin-review-audit.
 *
 * @version v9
 */

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from '@opencode-ai/plugin';
import { readState, writeState } from '../adapters/persistence.js';
import { changedFiles } from '../adapters/git.js';
import { createPluginLogger } from './plugin-logging.js';
import { toAdapterLogger, runWithAdapterLoggerAsync } from '../logging/adapter-logger.js';
import {
  strictBlockedOutput,
  buildEnforcementError,
  getToolArgs,
  getToolMetadata,
} from './plugin-helpers.js';
import {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  isRiskClassificationAllowed,
  type RiskClassificationDecision,
} from './phase-tool-gate.js';
import { trackFlowGuardEnforcement, trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import {
  runReviewOrchestration as runOrchestrator,
  type OrchestratorDeps,
} from './plugin-orchestrator.js';
import { runAudit as runAuditModule, type AuditDeps } from './plugin-audit.js';
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

const FG_PREFIX = 'flowguard_';

/**
 * Determine whether a worktree path points at a real git repository.
 *
 * Fail-closed: returns false for empty paths, the filesystem root, or any
 * path without a `.git` entry. This prevents the plugin from materializing
 * a workspace folder under `~/.config/opencode/workspaces/<fp>/` for non-repo
 * bootstrap contexts (e.g. when OpenCode starts from `$HOME` or `/`).
 *
 * Invariant: one fingerprint folder per repository. Any worktree that does
 * not look like a repo MUST NOT produce a workspace folder.
 *
 * @param worktree - Candidate worktree path (may be empty/undefined).
 * @returns true if the path is a non-root directory containing a `.git` entry.
 */
export function isUsableWorktree(worktree: string | undefined): boolean {
  if (!worktree) return false;
  // Reject filesystem root and Windows drive roots.
  const normalized = path.resolve(worktree);
  if (normalized === '/' || /^[A-Za-z]:[\\/]?$/.test(normalized)) return false;
  try {
    const gitPath = path.join(normalized, '.git');
    if (!existsSync(gitPath)) return false;
    // `.git` is either a directory (normal repo) or a file (worktree/submodule).
    const st = statSync(gitPath);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * FlowGuard Audit Plugin.
 *
 * Consumes only { client, directory, worktree } from PluginInput.
 * Unused fields and rationale:
 * - project: Identity resolved via git fingerprint, not OpenCode project metadata.
 * - $: FlowGuard never spawns shell commands from the plugin layer.
 * - experimental_workspace: Not applicable to FlowGuard's audit model.
 * - serverUrl: Communication is tool-hook-only, no HTTP callbacks needed.
 */
export const FlowGuardAuditPlugin: Plugin = async ({ client, directory, worktree }) => {
  const candidateWorktree = worktree || directory;
  // Fail-closed: only resolve a fingerprint and create a workspace file sink
  // when the worktree is a real git repo. Otherwise we would create a rogue
  // `workspaces/<fp>/.opencode/logs/` folder for every non-repo bootstrap.
  const auditWorktree = isUsableWorktree(candidateWorktree) ? candidateWorktree : undefined;

  // ── Workspace + Logger ──────────────────────────────────────────────────
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

  // Wire adapter-layer logging via AsyncLocalStorage DI.
  // Each hook handler executes within an ALS scope so adapter I/O
  // (persistence, git, archive, etc.) receives the plugin logger.
  // No global setAdapterLogger — scopes are per-hook-invocation.
  const adapterLog = toAdapterLogger(log);

  // ── Log-dependent helpers (kept here pending ws DI) ─────────────────────
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

  // ── Service dependencies ────────────────────────────────────────────────
  const typedClient = client as OrchestratorClient;

  // HAI #242: Create host adapter for platform-agnostic reviewer invocation.
  // The adapter wraps the OpenCode SDK client and provides the HostAdapter contract.
  // Session ID is resolved dynamically per-invocation (not fixed at init time).
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

  function targetPathsForRisk(toolName: string, args: Record<string, unknown>): string[] {
    if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
      const worktreeRoot = auditWorktree ? path.resolve(auditWorktree) : null;
      const filePath = path.resolve(args.filePath);
      if (worktreeRoot && filePath.startsWith(`${worktreeRoot}${path.sep}`)) {
        return [path.relative(worktreeRoot, filePath)];
      }
      return [args.filePath];
    }
    return [];
  }

  async function currentChangedFilesForRisk(): Promise<string[]> {
    if (!auditWorktree) {
      throw buildEnforcementError(
        'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
        'Cannot verify risk classification because the worktree is unavailable.',
      );
    }
    try {
      return await changedFiles(auditWorktree);
    } catch (err) {
      throw buildEnforcementError(
        'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
        `Cannot verify risk classification evidence: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function evidenceUnavailableRiskDecision(
    state: SessionState,
    reason: string,
  ): RiskClassificationDecision {
    return {
      allowed: false,
      code: 'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
      reason,
      decisionId: `RISK-${new Date().toISOString().replace(/[^0-9]/g, '')}-evidence-unavailable`,
      claimedTaskClass: state.claimedTaskClass,
      minimumTaskClass: 'HIGH-RISK',
      touchedSurfaces: ['risk-classification-evidence'],
      changedFiles: [],
    };
  }

  async function persistRiskDecisionBlock(
    sessDir: string,
    state: SessionState,
    decision: RiskClassificationDecision,
    code: string,
    message: string,
  ): Promise<void> {
    const blockedAt = new Date().toISOString();
    const nextState: SessionState = {
      ...state,
      riskGate: {
        status: 'blocked',
        code,
        message,
        blockedAt,
        lastDecisionId: decision.decisionId,
      },
    };
    await writeState(sessDir, nextState);
    await appendRiskDecisionAudit(sessDir, state, decision, 'blocked', code);
  }

  async function appendRiskDecisionAudit(
    sessDir: string,
    state: SessionState,
    decision: RiskClassificationDecision,
    result: 'allowed' | 'blocked',
    reasonCode: string,
  ): Promise<void> {
    await appendReviewAuditEvent(
      sessDir,
      state.binding.sessionId,
      state.phase,
      'risk:classification_checked',
      {
        decisionId: decision.decisionId,
        decision: result,
        reasonCode,
        claimedTaskClass: decision.claimedTaskClass ?? null,
        minimumTaskClass: decision.minimumTaskClass,
        touchedSurfaces: decision.touchedSurfaces,
        changedFilesSummary: decision.changedFiles,
        policyMode: state.policySnapshot.mode,
        enforceRiskClassification: state.policySnapshot.enforceRiskClassification,
        allowRiskDowngradeOverride: state.policySnapshot.allowRiskDowngradeOverride,
        riskGateStatus: result === 'blocked' ? 'blocked' : (state.riskGate?.status ?? 'clear'),
      },
    );
  }

  async function enforceRiskClassificationBefore(
    sessDir: string,
    state: SessionState,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (state.policySnapshot.enforceRiskClassification !== true) return;
    let files: string[];
    try {
      files = await currentChangedFilesForRisk();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const decision = evidenceUnavailableRiskDecision(state, reason);
      if (state.riskGate?.status !== 'blocked') {
        try {
          await persistRiskDecisionBlock(
            sessDir,
            state,
            decision,
            'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
            reason,
          );
        } catch (persistErr) {
          throw buildEnforcementError(
            'AUDIT_PERSISTENCE_FAILED',
            persistErr instanceof Error ? persistErr.message : String(persistErr),
          );
        }
      }
      throw buildEnforcementError('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', reason, {
        sessionId: state.binding.sessionId,
        tool: toolName,
        decisionId: decision.decisionId,
      });
    }
    const decision = isRiskClassificationAllowed({
      state,
      changedFiles: files,
      targetPaths: targetPathsForRisk(toolName, args),
      now: new Date().toISOString(),
    });
    if (decision.allowed) {
      try {
        await appendRiskDecisionAudit(
          sessDir,
          state,
          decision,
          'allowed',
          'RISK_CLASSIFICATION_ALLOWED',
        );
      } catch (err) {
        throw buildEnforcementError(
          'AUDIT_PERSISTENCE_FAILED',
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }
    const code = decision.code ?? 'RISK_CLASSIFICATION_MISMATCH';
    const reason = decision.reason ?? 'Risk classification gate blocked this mutating tool.';
    if (state.riskGate?.status !== 'blocked') {
      try {
        await persistRiskDecisionBlock(sessDir, state, decision, code, reason);
      } catch (err) {
        throw buildEnforcementError(
          'AUDIT_PERSISTENCE_FAILED',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    throw buildEnforcementError(code, reason, {
      sessionId: state.binding.sessionId,
      tool: toolName,
      claimedTaskClass: decision.claimedTaskClass ?? 'missing',
      minimumTaskClass: decision.minimumTaskClass,
      touchedSurface: decision.touchedSurfaces[0] ?? 'none',
      decisionId: decision.decisionId,
    });
  }

  async function enforceRiskClassificationAfterBash(
    sessionId: string,
    output: { output?: unknown },
  ): Promise<void> {
    const sessDir = ws.getSessionDir(sessionId);
    if (!sessDir || !existsSync(sessDir)) return;
    let state: SessionState | null;
    try {
      state = await readState(sessDir);
    } catch (err) {
      output.output = strictBlockedOutput('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!state || state.policySnapshot.enforceRiskClassification !== true) return;
    let files: string[];
    try {
      files = await currentChangedFilesForRisk();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const decision = evidenceUnavailableRiskDecision(state, reason);
      try {
        if (state.riskGate?.status !== 'blocked') {
          await persistRiskDecisionBlock(
            sessDir,
            state,
            decision,
            'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
            reason,
          );
        }
      } catch (persistErr) {
        output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
          reason: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
        return;
      }
      output.output = strictBlockedOutput('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', { reason });
      return;
    }
    const decision = isRiskClassificationAllowed({
      state,
      changedFiles: files,
      now: new Date().toISOString(),
    });
    if (decision.allowed) {
      try {
        await appendRiskDecisionAudit(
          sessDir,
          state,
          decision,
          'allowed',
          'RISK_CLASSIFICATION_ALLOWED',
        );
      } catch (err) {
        output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    const code = decision.code ?? 'RISK_CLASSIFICATION_MISMATCH';
    const reason = decision.reason ?? 'Risk classification gate blocked after bash mutation.';
    try {
      if (state.riskGate?.status !== 'blocked') {
        await persistRiskDecisionBlock(sessDir, state, decision, code, reason);
      }
      output.output = strictBlockedOutput(code, {
        reason,
        sessionId,
        claimedTaskClass: decision.claimedTaskClass ?? 'missing',
        minimumTaskClass: decision.minimumTaskClass,
        touchedSurface: decision.touchedSurfaces[0] ?? 'none',
        decisionId: decision.decisionId,
      });
    } catch (err) {
      output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Hook handlers ──────────────────────────────────────────────────────
  return {
    'tool.execute.before': async (input: unknown, output: unknown) => {
      return runWithAdapterLoggerAsync(adapterLog, async () => {
        // OpenCode SDK passes untyped hook parameters. Cast to typed views
        // defined in types.ts (canonical per OpenCode docs convention).
        // Runtime guards (?? fallbacks) kept for defensive safety.
        const hookInput = input as ToolHookBeforeInput;
        const hookOutput = output as ToolHookBeforeOutput;
        const toolName: string = hookInput?.tool ?? '';
        const sessionId: string = hookInput?.sessionID ?? 'unknown';
        currentSessionId = sessionId;
        // OpenCode docs: tool arguments live on the output parameter in before hooks
        // (mutable by design). input carries tool name and session metadata only.
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
            // Defense-in-depth: block non-reviewer subagent types (BUG-08).
            // Platform-level config restricts task permissions, but FlowGuard
            // enforces at the plugin level as a fail-closed safety net.
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

        // ── Phase-aware host tool gate (BUG-03) ─────────────────────────
        // Investigation-only phases (TICKET, PLAN, ARCHITECTURE) restrict
        // mutating host tools (bash, write, edit). Read-only tools pass.
        //
        // Two distinct paths:
        //   (A) sessDir === null  → no FlowGuard fingerprint → allow
        //       (pre-session, no governance context to enforce)
        //   (B) sessDir computed  → directory MUST exist on disk
        //       (governance context gap → fail-closed: SESSION_DIR_NOT_FOUND)
        if (isMutatingHostTool(toolName)) {
          const sessDir = ws.getSessionDir(sessionId);
          if (!sessDir) return;

          // If the session directory is computed from fingerprint but not present
          // on disk, this is a governance context gap → fail-closed. Recovery is
          // explicit: run /hydrate to initialise the session directory.
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

          await enforceRiskClassificationBefore(sessDir, state, toolName, args);
        }

        if (!isFlowGuardVerdictTool(toolName)) return;

        // BUG-21: LLMs (notably DeepSeek R1) send explicit null for optional fields.
        // Zod .optional() rejects null — strip null-valued keys so they become
        // genuinely absent (→ undefined after Zod validation). This runs on the
        // mutable hookOutput.args reference, so Zod and execute() see stripped args.
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
        // OpenCode SDK passes untyped hook parameters. Cast to typed views
        // defined in types.ts (canonical per OpenCode docs convention).
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
          // BUG-14 fix: For reviewer tasks, pre-inject the authoritative child
          // session ID into the output BEFORE trackTaskEnforcement captures it.
          // This mirrors SDK mode post-hoc injection (review-orchestrator.ts:1193-1202):
          // the reviewer cannot know its own session ID, so the runtime resolves
          // it from hook metadata or callID and injects it into the findings JSON.
          const taskArgs = getToolArgs(input);
          let resolvedChildSessionId: string | null = null;
          if (taskArgs.subagent_type === REVIEWER_SUBAGENT_TYPE) {
            const metadata = getToolMetadata(hookOutput);
            const callID = hookInput.callID ?? '';
            // Tier 1: metadata.sessionID — authoritative from task tool runtime
            resolvedChildSessionId = resolveSessionIdFromMetadata(metadata);
            // Tier 3: synthetic from callID (Tier 2 is handled by onTaskToolAfter)
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

          // Only create host-task evidence for flowguard-reviewer subagent calls.
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
          await enforceRiskClassificationAfterBash(sessionId, hookOutput);
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
            if (!sessDir) return; // No session dir — pre-session error, log-only
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
