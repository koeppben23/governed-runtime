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
import { readState } from '../adapters/persistence.js';
import { createPluginLogger } from './plugin-logging.js';
import { strictBlockedOutput, buildEnforcementError } from './plugin-helpers.js';
import { trackFlowGuardEnforcement, trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import {
  runReviewOrchestration as runOrchestrator,
  type OrchestratorDeps,
} from './plugin-orchestrator.js';
import { runAudit as runAuditModule, type AuditDeps } from './plugin-audit.js';
import { createWorkspace } from './plugin-workspace.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import type { SessionState } from '../state/schema.js';
import type { FlowGuardPolicy } from '../config/policy.js';

import {
  enforceBeforeVerdict,
  enforceBeforeSubagentCall,
  REVIEWER_SUBAGENT_TYPE,
} from './review-enforcement.js';

import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_ARCHITECTURE,
} from './tool-names.js';

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
  } catch {
    /* non-blocking */
  }

  const { log, config } = await createPluginLogger(
    client,
    ws.cachedWsDir,
    auditWorktree,
    ws.cachedFingerprint,
  );

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
  const orchestratorDeps: OrchestratorDeps = {
    resolveFingerprint: ws.resolveFingerprint,
    getSessionDir: ws.getSessionDir,
    updateReviewAssurance: ws.updateReviewAssurance,
    blockReviewOutcome: ws.blockReviewOutcome,
    getEnforcementState: ws.getEnforcementState,
    log,
    client,
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

  // ── Hook handlers ──────────────────────────────────────────────────────
  return {
    'tool.execute.before': async (input: unknown, _output: unknown) => {
      const toolName: string = (input as { tool?: string })?.tool ?? '';
      const sessionId: string = (input as { sessionID?: string })?.sessionID ?? 'unknown';
      const args = (input as { args?: Record<string, unknown> })?.args ?? {};

      if (toolName === 'task') {
        const st = typeof args.subagent_type === 'string' ? args.subagent_type : '';
        if (st === REVIEWER_SUBAGENT_TYPE) {
          const eState = ws.getEnforcementState(sessionId);
          let strictEnforcement = true;
          try {
            const sessDir = ws.getSessionDir(sessionId);
            if (sessDir) {
              const state = await readState(sessDir);
              if (state) {
                strictEnforcement = state.policySnapshot?.selfReview?.strictEnforcement === true;
              }
            }
          } catch {
            /* fail-closed */
          }
          const result = enforceBeforeSubagentCall(eState, args, strictEnforcement);
          if (!result.allowed) {
            log.warn('enforcement', 'blocked subagent call', {
              tool: toolName,
              sessionId,
              code: result.code,
            });
            throw buildEnforcementError(result.code ?? 'INTERNAL_ERROR', result.reason ?? '');
          }
        }
        return;
      }

      if (
        toolName !== TOOL_FLOWGUARD_PLAN &&
        toolName !== TOOL_FLOWGUARD_IMPLEMENT &&
        toolName !== TOOL_FLOWGUARD_ARCHITECTURE
      )
        return;

      const eState = ws.getEnforcementState(sessionId);
      let sessionState: SessionState | null = null;
      let strict = true;
      try {
        const sessDir = ws.getSessionDir(sessionId);
        if (sessDir) {
          sessionState = await readState(sessDir);
          if (sessionState) {
            strict = sessionState.policySnapshot?.selfReview?.strictEnforcement === true;
          }
        }
      } catch {
        /* fail-closed */
      }
      const result = enforceBeforeVerdict(eState, toolName, args, sessionState, strict);
      if (!result.allowed) {
        log.warn('enforcement', 'blocked verdict submission', {
          tool: toolName,
          sessionId,
          code: result.code,
        });
        throw buildEnforcementError(result.code ?? 'INTERNAL_ERROR', result.reason ?? '');
      }
    },

    'tool.execute.after': async (input: unknown, output: unknown) => {
      const toolName: string = (input as { tool?: string })?.tool ?? '';
      const sessionId: string = (input as { sessionID?: string })?.sessionID ?? 'unknown';
      const now = new Date().toISOString();

      if (
        toolName === TOOL_FLOWGUARD_PLAN ||
        toolName === TOOL_FLOWGUARD_IMPLEMENT ||
        toolName === TOOL_FLOWGUARD_ARCHITECTURE
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
        try {
          trackTaskEnforcement(ws.getEnforcementState(sessionId), input, output, now);
        } catch (err) {
          logError('enforcement tracking failed', err);
        }
      }

      await runOrchestrator(orchestratorDeps, {
        toolName,
        input,
        output: output as { output: string },
        sessionId,
        now,
      });

      if (!toolName.startsWith(FG_PREFIX)) return;

      await ws.runSerializedForSession(sessionId, async () => {
        const auditResult = await runAuditModule(auditDeps, toolName, input, output, sessionId);
        if (auditResult?.block) {
          (output as { output: string }).output = strictBlockedOutput(auditResult.code!, {
            reason: auditResult.reason ?? 'audit persistence failed',
          });
        }
      });
    },
  };
};
