/** @module integration/tools/hydrate — Session bootstrap/reload tool. */

import { z } from 'zod';

import { resolveActor, ActorClaimError } from '../../adapters/actor.js';
import { readState, PersistenceError } from '../../adapters/persistence.js';
import { changedFiles, hashWorktreeFiles } from '../../adapters/git.js';
import { computeGitControlPlaneMarker } from '../git-control-plane.js';
import { readConfig } from '../../adapters/persistence-config.js';
import { initWorkspace, writeSessionPointer } from '../../adapters/workspace/index.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import { executeHydrate } from '../../rails/hydrate.js';
import { REASON_SESSION_LOCK_CONTENDED } from '../../shared/flowguard-identifiers.js';
import { PolicyModeSchema } from '../../state/policy-mode.js';
import { formatBlocked, getWorktree, withSessionWriteTransaction } from './helpers.js';
import { formatError } from './error-format.js';
import type { ToolContext, ToolDefinition, ToolResult } from './helpers.js';
import { resolveDiscoveryHydration } from './hydrate-discovery.js';
import { reconcileHydrateDiscoveryHealthGate } from './hydrate-discovery-health.js';
import { buildHydrateInput, formatHydrateResult, withLockContended } from './hydrate-format.js';
import { resolveHydratePolicy } from './hydrate-policy.js';
import type { HydrateArgs } from './hydrate-types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared types (exported for sibling modules)
// ═══════════════════════════════════════════════════════════════════════════════

export type {
  BuildHydrateInputParams,
  DiscoveryHydration,
  ExistingCentralEvidence,
  ExistingHydrateState,
  HydrateArgs,
  HydrateConfig,
  HydratePolicyContext,
  HydratePolicyResolution,
  HydrateWorkspace,
  ReadRepoFile,
  ResolveDiscoveryHydrationInput,
} from './hydrate-types.js';

/**
 * Capture the set of files already dirty in the worktree, before the agent
 * makes any task edits, each with the git blob hash of its current content.
 * Fail-soft: any git failure yields undefined so hydrate never fails on
 * baseline capture and implement falls back to recording the full worktree
 * (marking scoping unavailable).
 */
async function captureBaselineDirtyFiles(
  worktree: string,
): Promise<Array<{ path: string; hash: string | null }> | undefined> {
  try {
    const dirty = await changedFiles(worktree);
    if (dirty.length === 0) return [];
    const hashes = await hashWorktreeFiles(worktree, dirty);
    return dirty.map((path) => ({ path, hash: hashes[path] ?? null }));
  } catch {
    return undefined;
  }
}

/**
 * Freeze the git control-plane state at baseline time (#852). Fail-soft like
 * the dirty-file baseline: undefined means implementation recording skips the
 * control-plane divergence check instead of hardening.
 */
async function captureBaselineControlPlaneMarker(worktree: string): Promise<string | undefined> {
  try {
    return await computeGitControlPlaneMarker(worktree);
  } catch {
    return undefined;
  }
}

/**
 * The lock is intentionally held across discovery/git for the duration of the
 * transaction; the 10s acquisition timeout in the lock adapter is the
 * fail-closed compensation (mapped to SESSION_LOCK_CONTENDED by the caller).
 */
async function runHydrate(args: HydrateArgs, context: ToolContext): Promise<ToolResult> {
  const worktree = getWorktree(context);
  const workspace = await initWorkspace(worktree, context.sessionID);
  const config = await readConfig(worktree);

  return withSessionWriteTransaction(workspace.sessionDir, async ({ waited }) => {
    const existing = await readState(workspace.sessionDir);
    // Pre-implementation baseline (#baseline): for a NEW session, snapshot the
    // files already dirty in the worktree BEFORE any editing, so flowguard_implement
    // can scope evidence to the task's own changes. Fail-soft: if git is
    // unreadable, leave it undefined and implement records the full worktree.
    const baselineDirtyFiles =
      existing === null ? await captureBaselineDirtyFiles(worktree) : undefined;
    const baselineControlPlaneMarker =
      existing === null ? await captureBaselineControlPlaneMarker(worktree) : undefined;
    const policyContext = await resolveHydratePolicy(existing, config, args);
    getAdapterLogger().info('policy', 'policy_resolved', {
      sessionId: context.sessionID,
      mode: policyContext.policy.mode,
      effectiveMode: policyContext.policyResolution.effectiveMode,
      source: policyContext.policyResolution.effectiveSource,
      ...getLogTraceFields(),
    });
    const discovery = await resolveDiscoveryHydration({
      existing,
      worktree,
      workspace,
      config,
      args,
      resolvedAt: policyContext.ctx.now(),
    });
    const actorInfo = await resolveActor(worktree);
    const rawResult = executeHydrate(
      policyContext.existingWithCentralEvidence,
      buildHydrateInput({
        context,
        worktree,
        workspace,
        policyContext,
        config,
        discovery,
        actorInfo,
        args,
        baselineDirtyFiles,
        baselineControlPlaneMarker,
      }),
      policyContext.ctx,
    );
    // Sole Discovery-health clear authority (#399): reconcile the persisted gate
    // from fresh persisted Discovery + a bounded drift assessment at hydrate time.
    const reconciled = await reconcileHydrateDiscoveryHealthGate(rawResult, {
      sessDir: workspace.sessionDir,
      workspaceDir: workspace.workspaceDir,
      worktree,
      fingerprint: workspace.fingerprint,
      now: policyContext.ctx.now(),
    });
    const { result, semanticIntents } = reconciled;
    writeSessionPointer(workspace.fingerprint, context.sessionID, workspace.sessionDir).catch(
      () => {},
    );
    const formatted = await formatHydrateResult(workspace.sessionDir, existing, result, discovery, {
      policyResolution: policyContext.policyResolution,
      semanticIntents,
    });
    if (result.kind === 'ok') {
      getAdapterLogger().info('machine', 'session_hydrated', {
        sessionId: context.sessionID,
        phase: result.state.phase,
        mode: result.state.policySnapshot.mode,
        ...getLogTraceFields(),
      });
    }
    return withLockContended(formatted, waited);
  });
}

async function executeHydrateTool(args: HydrateArgs, context: ToolContext): Promise<ToolResult> {
  try {
    return await runHydrate(args, context);
  } catch (err) {
    if (err instanceof ActorClaimError) return formatBlocked(err.code);
    // Fail-closed (#429): session write lock contention surfaces as an explicit
    // BLOCKED with a registered reason — never the UNREGISTERED_REASON fallback
    // that a raw LOCK_TIMEOUT code would otherwise hit via formatError.
    if (err instanceof PersistenceError && err.code === 'LOCK_TIMEOUT') {
      return formatBlocked(REASON_SESSION_LOCK_CONTENDED, { message: err.message });
    }
    return formatError(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_hydrate — Bootstrap Session
// ═══════════════════════════════════════════════════════════════════════════════

export const hydrate: ToolDefinition = {
  description:
    'Bootstrap or reload the FlowGuard session. Creates a new session if none exists, ' +
    'or returns the existing session unchanged except explicit claimedTaskClass risk recovery. ' +
    'Optionally configure policy mode (solo/team/regulated) and profile. ' +
    'This MUST be the first FlowGuard tool call in any workflow.',
  args: {
    policyMode: PolicyModeSchema.optional().describe(
      'FlowGuard policy mode. When omitted, reads from repo config ' +
        "(policy.defaultMode), then falls back to 'team' (human-gated). " +
        "Priority: explicit arg > config > 'team'. " +
        'Choose solo or team-ci explicitly for auto-approve behavior.',
    ),
    profileId: z
      .string()
      .default('baseline')
      .describe("Governance profile ID. Defaults to 'baseline'."),
    claimedTaskClass: z
      .enum(['TRIVIAL', 'STANDARD', 'HIGH-RISK'])
      .optional()
      .describe(
        'Agent/operator risk-classification claim. Runtime still computes the minimum class. ' +
          'On an existing session this may only update claimedTaskClass; a blocked riskGate ' +
          'is NOT cleared (recovering from a blocked risk gate requires a fresh governed session).',
      ),
  },
  async execute(args, context) {
    return executeHydrateTool(args, context);
  },
};
