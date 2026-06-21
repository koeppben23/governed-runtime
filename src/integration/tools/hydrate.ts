/** @module integration/tools/hydrate — Session bootstrap/reload tool. */

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from './helpers.js';
import type { ToolResult } from './helpers.js';
import { getWorktree, formatBlocked, formatError, withSessionWriteTransaction } from './helpers.js';
import { executeHydrate } from '../../rails/hydrate.js';
import { PolicyModeSchema } from '../../state/policy-mode.js';
import type { PolicyMode } from '../../state/policy-mode.js';
import { readState, PersistenceError } from '../../adapters/persistence.js';
import { readConfig } from '../../adapters/persistence-config.js';
import { initWorkspace, writeSessionPointer } from '../../adapters/workspace/index.js';
import { resolveActor, ActorClaimError } from '../../adapters/actor.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import { REASON_SESSION_LOCK_CONTENDED } from '../../shared/flowguard-identifiers.js';
import { resolveHydratePolicy } from './hydrate-policy.js';
import { resolveDiscoveryHydration } from './hydrate-discovery.js';
import { buildHydrateInput, formatHydrateResult, withLockContended } from './hydrate-format.js';
import { reconcileHydrateDiscoveryHealthGate } from './hydrate-discovery-health.js';
import { resolvePolicyForHydrate } from '../../config/policy.js';
import { validateExistingPolicyAgainstCentral } from '../../config/policy.js';
import { extractDiscoverySummary } from '../../discovery/orchestrator.js';
import { planVerificationCandidates } from '../../discovery/verification-planner.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import type { DetectedStack } from '../../discovery/types.js';
import type { ProfileResolution } from '../../discovery/types.js';
import type { RepoSignals } from '../../config/profile.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared types (exported for sibling modules)
// ═══════════════════════════════════════════════════════════════════════════════

export type ExistingHydrateState = Awaited<ReturnType<typeof readState>>;
export type HydrateConfig = Awaited<ReturnType<typeof readConfig>>;
export type HydratePolicyResolution = Awaited<ReturnType<typeof resolvePolicyForHydrate>>;
export type HydrateArgs = {
  policyMode?: PolicyMode;
  profileId?: string;
  claimedTaskClass?: string;
};
export type HydrateWorkspace = Awaited<ReturnType<typeof initWorkspace>>;
export type HydratePolicyContext = Awaited<ReturnType<typeof resolveHydratePolicy>>;
export type ReadRepoFile = (relativePath: string) => Promise<string | undefined>;
export type ExistingCentralEvidence = NonNullable<
  Awaited<ReturnType<typeof validateExistingPolicyAgainstCentral>>
>;

export interface DiscoveryHydration {
  readonly repoSignals?: RepoSignals;
  readonly discoveryResult?: DiscoveryResult;
  readonly discoveryDigest?: string;
  readonly discoverySummary?: ReturnType<typeof extractDiscoverySummary>;
  readonly detectedStack?: DetectedStack | null;
  readonly verificationCandidates?: Awaited<ReturnType<typeof planVerificationCandidates>>;
  readonly profileResolution?: ProfileResolution;
}

export interface ResolveDiscoveryHydrationInput {
  readonly existing: ExistingHydrateState;
  readonly worktree: string;
  readonly workspace: HydrateWorkspace;
  readonly config: HydrateConfig;
  readonly args: HydrateArgs;
  readonly resolvedAt: string;
}

export interface BuildHydrateInputParams {
  readonly context: ToolContext;
  readonly worktree: string;
  readonly workspace: HydrateWorkspace;
  readonly policyContext: HydratePolicyContext;
  readonly config: HydrateConfig;
  readonly discovery: DiscoveryHydration;
  readonly actorInfo: Awaited<ReturnType<typeof resolveActor>>;
  readonly args: HydrateArgs;
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
      }),
      policyContext.ctx,
    );
    // Sole Discovery-health clear authority (#399): reconcile the persisted gate
    // from fresh persisted Discovery + a bounded drift assessment at hydrate time.
    const result = await reconcileHydrateDiscoveryHealthGate(rawResult, {
      sessDir: workspace.sessionDir,
      workspaceDir: workspace.workspaceDir,
      worktree,
      fingerprint: workspace.fingerprint,
      now: policyContext.ctx.now(),
    });
    writeSessionPointer(workspace.fingerprint, context.sessionID, workspace.sessionDir).catch(
      () => {},
    );
    const formatted = await formatHydrateResult(
      workspace.sessionDir,
      existing,
      result,
      discovery,
      policyContext.policyResolution,
    );
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
          'On an existing session this may only update claimedTaskClass and clear a blocked riskGate.',
      ),
  },
  async execute(args, context) {
    return executeHydrateTool(args, context);
  },
};
