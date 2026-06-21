/**
 * @module integration/tools/hydrate
 * @description FlowGuard hydrate tool — bootstrap or reload session.
 *
 * This is the entry point for every FlowGuard workflow. Creates a new session
 * if none exists, runs repository discovery, resolves the governance profile,
 * and returns the session state.
 *
 * @version v3
 */

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';

import type { ToolContext, ToolDefinition, ToolResult } from './helpers.js';
import {
  getWorktree,
  resolvePolicyFromState,
  createPolicyContext,
  formatBlocked,
  formatError,
  withSessionWriteTransaction,
} from './helpers.js';

// Rails
import { executeHydrate } from '../../rails/hydrate.js';

// Discovery health gate (#399)
import { loadDiscoveryHealthContext } from '../../discovery/discovery-health.js';
import { buildDiscoveryDriftStatus } from '../discovery-drift-status.js';
import { reconcileDiscoveryHealthGate } from '../discovery-health-gate.js';
import { auditDiscoveryHealthGateTransition } from '../discovery-health-audit.js';
import type { DiscoveryDriftAssessment } from '../../state/schema.js';
import { PolicyModeSchema, type PolicyMode } from '../../state/policy-mode.js';
import type { RailResult } from '../../rails/types.js';

// Adapters
import { readState, PersistenceError } from '../../adapters/persistence.js';
import { REASON_SESSION_LOCK_CONTENDED } from '../../shared/flowguard-identifiers.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import { listRepoSignals } from '../../adapters/git.js';
import { readConfig } from '../../adapters/persistence-config.js';
import {
  writeDiscovery,
  writeProfileResolution,
  writeDiscoverySnapshot,
  writeProfileResolutionSnapshot,
} from '../../adapters/persistence-discovery.js';

// Workspace
import { initWorkspace, writeSessionPointer } from '../../adapters/workspace/index.js';

// Actor identity (P27)
import { resolveActor, ActorClaimError } from '../../adapters/actor.js';

// Discovery
import {
  runDiscovery,
  extractDiscoverySummary,
  extractDetectedStack,
  computeDiscoveryDigest,
} from '../../discovery/orchestrator.js';
import type { DiscoveryResult, ProfileResolution, DetectedStack } from '../../discovery/types.js';
import { PROFILE_RESOLUTION_SCHEMA_VERSION } from '../../discovery/types.js';
import { planVerificationCandidates } from '../../discovery/verification-planner.js';
import { defaultProfileRegistry as profileRegistryForResolution } from '../../config/profile.js';
import type { FlowGuardProfile, RepoSignals } from '../../config/profile.js';

// Config
import {
  detectCiContext,
  resolvePolicyForHydrate,
  validateExistingPolicyAgainstCentral,
} from '../../config/policy.js';
import { throwHydrateError } from './hydrate-errors.js';
import { buildHydrateInput, formatHydrateResult, withLockContended } from './hydrate-format.js';
import { resolveHydratePolicy } from './hydrate-policy.js';
import { resolveDiscoveryHydration } from './hydrate-discovery.js';
import { reconcileHydrateDiscoveryHealthGate } from './hydrate-discovery-health.js';

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
