/** @module integration/tools/hydrate-policy — Policy resolution for hydrate. */

import type { PolicyMode } from '../../state/policy-mode.js';
import { resolvePolicyFromState, createPolicyContext } from './helpers.js';
import {
  detectCiContext,
  resolvePolicyForHydrate,
  validateExistingPolicyAgainstCentral,
} from '../../config/policy.js';
import type {
  HydrateConfig,
  ExistingHydrateState,
  ExistingCentralEvidence,
  HydratePolicyResolution,
} from './hydrate-types.js';
import { hashText } from '../../shared/hashing.js';

/** Full SHA-256 hex digest of a UTF-8 string. Delegates to the shared authority. */
export function digestText(text: string): string {
  return hashText(text);
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
      'explicit' | 'repo' | 'default',
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
