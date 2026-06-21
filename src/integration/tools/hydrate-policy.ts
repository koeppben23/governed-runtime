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
import type { ExistingCentralEvidence } from './hydrate.js';
import { buildHydrateInput, formatHydrateResult, withLockContended } from './hydrate-format.js';

export type ExistingHydrateState = Awaited<ReturnType<typeof readState>>;
export type HydrateConfig = Awaited<ReturnType<typeof readConfig>>;
export type HydratePolicyResolution = Awaited<ReturnType<typeof resolvePolicyForHydrate>>;
type HydrateArgs = { policyMode?: PolicyMode; profileId?: string; claimedTaskClass?: string };
export function digestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function resolveCentralEvidenceForExisting(existing: ExistingHydrateState) {
  if (!existing) return undefined;
  return validateExistingPolicyAgainstCentral({
    existingMode: existing.policySnapshot.mode,
    centralPolicyPath: process.env.FLOWGUARD_POLICY_PATH,
    digestFn: digestText,
  });
}

export function mergeCentralEvidence(
  existing: ExistingHydrateState,
  centralEvidence: ExistingCentralEvidence | undefined,
) {
  if (!existing || !centralEvidence) return existing;
  return {
    ...existing,
    policySnapshot: {
      ...existing.policySnapshot,
      centralMinimumMode: centralEvidence.minimumMode,
      policyDigest: centralEvidence.digest,
      policyVersion: centralEvidence.version,
      policyPathHint: centralEvidence.pathHint,
    },
  };
}

export function snapshotCentralEvidence(existing: NonNullable<ExistingHydrateState>) {
  if (!existing.policySnapshot.centralMinimumMode) return undefined;
  return {
    minimumMode: existing.policySnapshot.centralMinimumMode,
    digest: existing.policySnapshot.policyDigest ?? '',
    ...(existing.policySnapshot.policyVersion
      ? { version: existing.policySnapshot.policyVersion }
      : {}),
    pathHint: existing.policySnapshot.policyPathHint ?? 'basename:unknown',
  };
}

export function resolveExistingPolicyResolution(
  existing: NonNullable<ExistingHydrateState>,
  centralEvidenceForExisting: Awaited<ReturnType<typeof validateExistingPolicyAgainstCentral>>,
): HydratePolicyResolution {
  return {
    requestedMode: existing.policySnapshot.requestedMode,
    requestedSource: (existing.policySnapshot.source ?? 'default') as
      | 'explicit'
      | 'repo'
      | 'default',
    effectiveMode: existing.policySnapshot.mode,
    effectiveSource: existing.policySnapshot.source ?? 'default',
    effectiveGateBehavior: existing.policySnapshot.effectiveGateBehavior,
    degradedReason: existing.policySnapshot.degradedReason as 'ci_context_missing' | undefined,
    policy: resolvePolicyFromState(existing),
    resolutionReason: existing.policySnapshot.resolutionReason as
      | 'repo_weaker_than_central'
      | 'default_weaker_than_central'
      | 'explicit_stronger_than_central'
      | undefined,
    centralEvidence: centralEvidenceForExisting ?? snapshotCentralEvidence(existing),
  };
}

export async function resolveNewPolicyResolution(
  config: HydrateConfig,
  args: { policyMode?: PolicyMode },
) {
  return resolvePolicyForHydrate({
    explicitMode: args.policyMode,
    repoMode: config.policy.defaultMode,
    // Fail-closed default: a session with no explicit mode and no repo config
    // is human-gated (team), so the plan/evidence gates require an explicit
    // human decision rather than auto-approving. This aligns the hydrate tool
    // with the runtime fallback in resolveRuntimePolicyMode (also `team`).
    // Auto-approve modes (solo / team-ci) must be chosen explicitly.
    defaultMode: 'team',
    ciContext: detectCiContext(),
    centralPolicyPath: process.env.FLOWGUARD_POLICY_PATH,
    digestFn: digestText,
    configMaxSelfReviewIterations: config.policy.maxSelfReviewIterations,
    configMaxImplReviewIterations: config.policy.maxImplReviewIterations,
    configRequireVerifiedActorsForApproval: config.policy.requireVerifiedActorsForApproval,
    configMinimumActorAssuranceForApproval: config.policy.minimumActorAssuranceForApproval,
    configIdentityProvider: config.policy.identityProvider,
    configIdentityProviderMode: config.policy.identityProviderMode,
    configEnforceRiskClassification: config.policy.enforceRiskClassification,
    configAllowRiskDowngradeOverride: config.policy.allowRiskDowngradeOverride,
    configAllowReducedCeremony: config.policy.allowReducedCeremony,
    configDiscoveryHealth: config.policy.discoveryHealth,
    configValidationEvidence: config.policy.validationEvidence,
  });
}

export async function resolveHydratePolicy(
  existing: ExistingHydrateState,
  config: HydrateConfig,
  args: { policyMode?: PolicyMode },
) {
  const centralEvidenceForExisting = await resolveCentralEvidenceForExisting(existing);
  const existingWithCentralEvidence = mergeCentralEvidence(existing, centralEvidenceForExisting);
  const policyResolution = existing
    ? resolveExistingPolicyResolution(existing, centralEvidenceForExisting)
    : await resolveNewPolicyResolution(config, args);
  const policy = existing
    ? resolvePolicyFromState(existingWithCentralEvidence ?? existing)
    : policyResolution.policy;
  const ctx = createPolicyContext(policy);
  return { policy, policyResolution, ctx, existingWithCentralEvidence, centralEvidenceForExisting };
}
