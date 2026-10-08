/** @module integration/tools/hydrate/hydrate — Session bootstrap/reload tool. */

import { z } from 'zod';

import { resolveActor, ActorClaimError } from '../../../adapters/actor.js';
import { PersistenceError } from '../../../adapters/persistence.js';
import { changedFiles, hashWorktreeFiles } from '../../../adapters/git.js';
import { computeGitControlPlaneMarker } from '../../git-control-plane.js';
import { readConfig } from '../../../adapters/persistence-config.js';
import { resolveSessionAuthority } from '../../../adapters/session-authority.js';
import { initWorkspace, writeSessionPointer } from '../../../adapters/workspace/index.js';
import { getAdapterLogger, getLogTraceFields } from '../../../logging/adapter-logger.js';
import { executeHydrate, resolveTerminalHydrate } from '../../../rails/hydrate.js';
import { TERMINAL } from '../../../machine/topology.js';
import { REASON_SESSION_LOCK_CONTENDED } from '../../../shared/flowguard-identifiers.js';
import { PolicyModeSchema } from '../../../state/policy-mode.js';
import { isTaskClass, TaskClass } from '../../../state/task-class.js';
import { formatBlocked } from '../../blocked-result.js';
import { IntegrationInvariantError } from '../../errors.js';
import { formatRailResult } from '../helpers-rail-presentation.js';
import {
  getWorktree,
  requireWorkspacePaths,
  resolvePolicyFromState,
  withSessionWriteTransaction,
} from '../helpers.js';
import type { LocatedWorkspacePaths } from '../helpers.js';
import { formatError } from '../error-format.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../helpers.js';
import type { RailResult } from '../../../rails/types.js';
import type { SessionState } from '../../../state/schema.js';
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
 * Fail-soft: any git failure yields undefined; hydrate persists that capture
 * as unavailable while retaining an independently captured control-plane marker.
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
 * the dirty-file baseline: undefined is persisted as unavailable and blocks
 * implementation recording fail-closed.
 */
async function captureBaselineControlPlaneMarker(worktree: string): Promise<string | undefined> {
  try {
    return await computeGitControlPlaneMarker(worktree);
  } catch {
    return undefined;
  }
}

/**
 * Read-only terminal reload response: no persistence, explicitly marked so the
 * operator can distinguish a reload from a state-mutating hydrate.
 */
function formatTerminalReload(result: Extract<RailResult, { kind: 'ok' }>): ToolResult {
  const rendered = formatRailResult(result);
  const text = typeof rendered === 'string' ? rendered : rendered.output;
  const base = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify({ ...base, terminalReload: true });
}

/**
 * D6 (#1034): terminal hydrate is read-only. A claim that would durably change
 * claimedTaskClass is denied; an equal or lower claim is a no-op.
 */
function handleTerminalHydrate(existing: SessionState, args: HydrateArgs): ToolResult {
  const claim = isTaskClass(args.claimedTaskClass) ? args.claimedTaskClass : undefined;
  const terminalResult = resolveTerminalHydrate(existing, claim, resolvePolicyFromState(existing));
  if (terminalResult === null) {
    return formatBlocked('TERMINAL_STATE_MUTATION_DENIED', {
      message: 'Terminal hydrate reload could not be resolved.',
    });
  }
  return terminalResult.kind === 'ok'
    ? formatTerminalReload(terminalResult)
    : formatRailResult(terminalResult);
}

/**
 * TOCTOU re-validation under the session write lock: re-resolve the canonical
 * authority and require the locked location to still be the canonical one. An
 * absent session is a legitimate create path here; a state that appeared while
 * the lock was being acquired is returned fresh by the authority.
 *
 * Deliberately does NOT initialize the workspace: the terminal read-only
 * shortcut must run before any potentially mutating workspace initialization.
 */
async function revalidateAuthorityUnderLock(
  context: ToolContext,
  paths: LocatedWorkspacePaths,
): Promise<{ existing: SessionState | null }> {
  const fresh = await resolveSessionAuthority({
    root: getWorktree(context),
    sessionId: context.sessionID,
    claimedFingerprint: context.workspaceFingerprint,
  });
  if (fresh.status === 'unavailable') {
    throw new IntegrationInvariantError(fresh.code, fresh.reason);
  }
  if (
    fresh.sessDir !== paths.sessDir ||
    fresh.fingerprint !== paths.fingerprint ||
    fresh.worktreeRoot !== paths.worktree
  ) {
    throw new IntegrationInvariantError(
      'SESSION_BINDING_MISMATCH',
      `Session authority changed while acquiring the write lock (locked "${paths.sessDir}" in "${paths.worktree}", now "${fresh.sessDir}" in "${fresh.worktreeRoot}").`,
    );
  }
  return { existing: fresh.status === 'resolved' ? fresh.state : null };
}

/**
 * Initialize the workspace under the lock and require it to agree with the
 * canonical authority (same fingerprint and session directory).
 */
async function initializeWorkspaceUnderLock(
  context: ToolContext,
  paths: LocatedWorkspacePaths,
): Promise<Awaited<ReturnType<typeof initWorkspace>>> {
  const workspace = await initWorkspace(paths.worktree, context.sessionID);
  if (workspace.fingerprint !== paths.fingerprint || workspace.sessionDir !== paths.sessDir) {
    throw new IntegrationInvariantError(
      'SESSION_BINDING_MISMATCH',
      `Workspace initialization diverged from the canonical authority (expected "${paths.sessDir}", got "${workspace.sessionDir}").`,
    );
  }
  return workspace;
}

/**
 * The lock is intentionally held across discovery/git for the duration of the
 * transaction; the 10s acquisition timeout in the lock adapter is the
 * fail-closed compensation (mapped to SESSION_LOCK_CONTENDED by the caller).
 */
async function runHydrate(args: HydrateArgs, context: ToolContext): Promise<ToolResult> {
  // The pre-lock authority resolution is only the candidate location; the write
  // lock is taken on its canonical session directory (create-or-update path).
  // An unavailable authority (non-git root, unreadable/foreign binding, claimed
  // fingerprint drift) fails closed before any workspace mutation.
  const paths = await requireWorkspacePaths(context);
  const { worktree } = paths;

  return withSessionWriteTransaction(paths.sessDir, async ({ waited }) => {
    const { existing } = await revalidateAuthorityUnderLock(context, paths);

    // D6 (#1034): a terminal session is reloaded strictly read-only BEFORE any
    // workspace initialization or config read. No state write, no
    // discovery/artifact/outbox mutation, no audit event — and a claim that
    // would durably change claimedTaskClass is denied.
    if (existing !== null && TERMINAL.has(existing.phase)) {
      return withLockContended(handleTerminalHydrate(existing, args), waited);
    }

    const workspace = await initializeWorkspaceUnderLock(context, paths);
    const config = await readConfig(worktree);
    // Pre-implementation baseline (#baseline): for a NEW session, snapshot the
    // files already dirty in the worktree BEFORE any editing, so flowguard_implement
    // can scope evidence to the task's own changes. Fail-soft: if git is
    // unreadable, leave it undefined and implement records the full worktree.
    const [baselineDirtyFiles, baselineControlPlaneMarker] =
      existing === null
        ? await Promise.all([
            captureBaselineDirtyFiles(worktree),
            captureBaselineControlPlaneMarker(worktree),
          ])
        : [undefined, undefined];
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
        ...(baselineDirtyFiles !== undefined ? { baselineDirtyFiles } : {}),
        ...(baselineControlPlaneMarker !== undefined ? { baselineControlPlaneMarker } : {}),
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
    'or returns the existing session unchanged except explicit claimedTaskClass escalation. ' +
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
    claimedTaskClass: TaskClass.optional().describe(
      'Optional raise-only escalation class. The effective risk class is ' +
        'max(runtime-computed minimum, ticket-declared floor, this escalation); it can never ' +
        'lower a ticket declaration or the computed minimum and is never required. ' +
        'On an existing session this may only update claimedTaskClass; a blocked riskGate ' +
        'is NOT cleared (recovering from a blocked risk gate requires a fresh governed session).',
    ),
  },
  async execute(args, context) {
    return executeHydrateTool(args, context);
  },
};
