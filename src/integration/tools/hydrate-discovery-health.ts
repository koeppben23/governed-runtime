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

export type ExistingHydrateState = Awaited<ReturnType<typeof readState>>;
export type HydrateConfig = Awaited<ReturnType<typeof readConfig>>;
export type HydratePolicyResolution = Awaited<ReturnType<typeof resolvePolicyForHydrate>>;
type HydrateArgs = { policyMode?: PolicyMode; profileId?: string; claimedTaskClass?: string };
export interface ReconcileGateContext {
  readonly sessDir: string;
  readonly workspaceDir: string;
  readonly worktree: string;
  readonly fingerprint: string;
  readonly now: string;
}

/**
 * Compute and attach the Discovery-health gate at hydrate (#399).
 *
 * This is the ONLY site that may clear a blocked gate. It reads the current
 * persisted DiscoveryResult (SSOT) for the health projection and runs a single
 * bounded drift check; both feed the pure `reconcileDiscoveryHealthGate`
 * authority. Drift IO is skipped entirely unless enforcement is 'required'.
 *
 * Gate lifecycle audit: because this is the sole clear authority, it also emits
 * the `discovery_health:gate_changed` event for both block AND clear (recovery)
 * transitions via the single audit authority, so unblocks are auditable.
 *
 * Exported for targeted lifecycle tests; not part of the public tool surface.
 */
export async function reconcileHydrateDiscoveryHealthGate(
  result: RailResult,
  ctx: ReconcileGateContext,
): Promise<RailResult> {
  if (result.kind !== 'ok') return result;

  const previousGate = result.state.discoveryHealthGate;
  const policy = result.state.policySnapshot.discoveryHealth;
  const { discoveryHealth } = await loadDiscoveryHealthContext(ctx.workspaceDir);

  let driftAssessment: DiscoveryDriftAssessment = 'not_checked';
  if (policy.enforcement === 'required') {
    const drift = await buildDiscoveryDriftStatus({
      workspaceDir: ctx.workspaceDir,
      worktree: ctx.worktree,
      fingerprint: ctx.fingerprint,
    });
    driftAssessment = drift.status;
  }

  const discoveryHealthGate = reconcileDiscoveryHealthGate({
    policy,
    health: discoveryHealth,
    driftAssessment,
    now: ctx.now,
  });

  const nextState = { ...result.state, discoveryHealthGate };
  // Audit block/clear transitions (no-op when status is unchanged).
  await auditDiscoveryHealthGateTransition(
    ctx.sessDir,
    nextState,
    previousGate,
    discoveryHealthGate,
  );

  return { ...result, state: nextState };
}
