/** @module integration/tools/hydrate-policy — Policy resolution for hydrate. */

import type { PolicyMode } from '../../state/policy-mode.js';
import { resolvePolicyFromState, createPolicyContext } from './helpers.js';
import {
  detectCiContext,
  resolvePolicyForHydrate,
  validateExistingPolicyAgainstCentral,
} from '../../config/policy.js';
import type { HydratePolicyOptions } from '../../config/policy.js';
import type {
  HydrateConfig,
  ExistingHydrateState,
  ExistingCentralEvidence,
  HydratePolicyResolution,
} from './hydrate-types.js';
import type {
  DiscoveryHealthPolicy,
  ReviewBudget,
  ValidationEvidencePolicy,
} from '../../config/policy-types.js';
import { hashText } from '../../shared/hashing.js';

/** Full SHA-256 hex digest of a UTF-8 string. Delegates to the shared authority. */
export function digestText(text: string): string {
  return hashText(text);
}

export function compactReviewBudget(
  budget: NonNullable<HydrateConfig['policy']['reviewBudget']>,
): Partial<ReviewBudget> {
  return {
    ...(budget.plan !== undefined ? { plan: budget.plan } : {}),
    ...(budget.architecture !== undefined ? { architecture: budget.architecture } : {}),
    ...(budget.implementation !== undefined ? { implementation: budget.implementation } : {}),
  };
}

export function compactDiscoveryHealth(
  health: NonNullable<HydrateConfig['policy']['discoveryHealth']>,
): Partial<DiscoveryHealthPolicy> {
  return {
    ...(health.enforcement !== undefined ? { enforcement: health.enforcement } : {}),
    ...(health.onDegraded !== undefined ? { onDegraded: health.onDegraded } : {}),
    ...(health.onDrift !== undefined ? { onDrift: health.onDrift } : {}),
  };
}

export function compactValidationEvidence(
  policy: NonNullable<HydrateConfig['policy']['validationEvidence']>,
): Partial<ValidationEvidencePolicy> {
  return {
    ...(policy.enforcement !== undefined ? { enforcement: policy.enforcement } : {}),
    ...(policy.allowNoCommands !== undefined ? { allowNoCommands: policy.allowNoCommands } : {}),
  };
}

export async function resolveCentralEvidenceForExisting(existing: ExistingHydrateState) {
  if (!existing) return undefined;
  return validateExistingPolicyAgainstCentral({
    existingMode: existing.policySnapshot.mode,
    ...(process.env.FLOWGUARD_POLICY_PATH !== undefined
      ? { centralPolicyPath: process.env.FLOWGUARD_POLICY_PATH }
      : {}),
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
  const degradedReason = existing.policySnapshot.degradedReason as 'ci_context_missing' | undefined;
  const resolutionReason = existing.policySnapshot.resolutionReason as
    | 'repo_weaker_than_central'
    | 'default_weaker_than_central'
    | 'explicit_stronger_than_central'
    | undefined;
  const centralEvidence = centralEvidenceForExisting ?? snapshotCentralEvidence(existing);
  return {
    requestedMode: existing.policySnapshot.requestedMode,
    requestedSource: (existing.policySnapshot.source ?? 'default') as
      'explicit' | 'repo' | 'default',
    effectiveMode: existing.policySnapshot.mode,
    effectiveSource: existing.policySnapshot.source ?? 'default',
    effectiveGateBehavior: existing.policySnapshot.effectiveGateBehavior,
    ...(degradedReason !== undefined ? { degradedReason } : {}),
    policy: resolvePolicyFromState(existing),
    ...(resolutionReason !== undefined ? { resolutionReason } : {}),
    ...(centralEvidence !== undefined ? { centralEvidence } : {}),
  };
}

function hydrateReviewBudgetArgs(policy: HydrateConfig['policy']): Partial<HydratePolicyOptions> {
  return {
    ...(policy.reviewBudget !== undefined
      ? { configReviewBudget: compactReviewBudget(policy.reviewBudget) }
      : {}),
    ...(policy.maxIncoherentReviewerCaptureRetries !== undefined
      ? { configMaxIncoherentReviewerCaptureRetries: policy.maxIncoherentReviewerCaptureRetries }
      : {}),
    ...(policy.maxReviewerAttempts !== undefined
      ? { configMaxReviewerOutputRepairAttempts: policy.maxReviewerAttempts }
      : {}),
  };
}

function hydrateGovernanceArgs(policy: HydrateConfig['policy']): Partial<HydratePolicyOptions> {
  return {
    ...(policy.minimumActorAssuranceForApproval !== undefined
      ? { configMinimumActorAssuranceForApproval: policy.minimumActorAssuranceForApproval }
      : {}),
    ...(policy.identityProvider !== undefined
      ? { configIdentityProvider: policy.identityProvider }
      : {}),
    ...(policy.identityProviderMode !== undefined
      ? { configIdentityProviderMode: policy.identityProviderMode }
      : {}),
    ...(policy.enforceRiskClassification !== undefined
      ? { configEnforceRiskClassification: policy.enforceRiskClassification }
      : {}),
    ...(policy.allowRiskDowngradeOverride !== undefined
      ? { configAllowRiskDowngradeOverride: policy.allowRiskDowngradeOverride }
      : {}),
    ...(policy.allowReducedCeremony !== undefined
      ? { configAllowReducedCeremony: policy.allowReducedCeremony }
      : {}),
    ...(policy.discoveryHealth !== undefined
      ? { configDiscoveryHealth: compactDiscoveryHealth(policy.discoveryHealth) }
      : {}),
    ...(policy.validationEvidence !== undefined
      ? { configValidationEvidence: compactValidationEvidence(policy.validationEvidence) }
      : {}),
  };
}

export async function resolveNewPolicyResolution(
  config: HydrateConfig,
  args: { policyMode?: PolicyMode },
) {
  return resolvePolicyForHydrate({
    ...(args.policyMode !== undefined ? { explicitMode: args.policyMode } : {}),
    ...(config.policy.defaultMode !== undefined ? { repoMode: config.policy.defaultMode } : {}),
    // Fail-closed default: a session with no explicit mode and no repo config
    // is human-gated (team), so the plan/evidence gates require an explicit
    // human decision rather than auto-approving. This aligns the hydrate tool
    // with the runtime fallback in resolveRuntimePolicyMode (also `team`).
    // Auto-approve modes (solo / team-ci) must be chosen explicitly.
    defaultMode: 'team',
    ciContext: detectCiContext(),
    ...(process.env.FLOWGUARD_POLICY_PATH !== undefined
      ? { centralPolicyPath: process.env.FLOWGUARD_POLICY_PATH }
      : {}),
    digestFn: digestText,
    ...hydrateReviewBudgetArgs(config.policy),
    ...hydrateGovernanceArgs(config.policy),
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
  return {
    policy,
    policyResolution,
    ctx,
    existingWithCentralEvidence,
    ...(centralEvidenceForExisting !== undefined ? { centralEvidenceForExisting } : {}),
  };
}
