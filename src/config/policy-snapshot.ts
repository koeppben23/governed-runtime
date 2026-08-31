/**
 * @module config/policy-snapshot
 * @description Policy Snapshot Authority — SSOT for policy snapshot lifecycle.
 *
 * Three canonical functions:
 * 1. createPolicySnapshot() — create an immutable snapshot from a policy
 * 2. freezePolicySnapshot()  — freeze a PolicyResolution or HydratePolicyResolution
 * 3. resolvePolicyFromSnapshot() — reconstruct executable FlowGuardPolicy from snapshot
 *
 * Snapshot normalization (enriching incomplete/legacy snapshots) lives in
 * policy-snapshot-normalize.ts.
 *
 * The snapshot is the sole runtime authority for all governance-critical checks.
 * No runtime path should reconstruct policy from policyMode alone.
 *
 * Dependency: imports PolicySnapshot type from state layer. This is an existing
 * dependency that predates this module — config depends on state schema types.
 *
 * @version v1
 */

import type { PolicySnapshot } from '../state/evidence.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { POLICY_DIGEST_PATTERN, POLICY_DIGEST_VERSION } from '../shared/policy-digest.js';
import { PolicyConfigurationError } from './policy-errors.js';
import { DEFAULT_MAX_REVIEWER_OUTPUT_REPAIR_ATTEMPTS } from './policy-types.js';
import type {
  FlowGuardPolicy,
  AuditPolicy,
  TimestampAssurancePolicy,
  PolicyMode,
  EffectiveGateBehavior,
  PolicyDegradedReason,
  PolicySource,
  PolicyResolutionReason,
  CentralMinimumMode,
} from './policy-types.js';
import type { PolicyResolution } from './policy-resolver.js';
import type { HydratePolicyResolution } from './policy-types.js';
import {
  normalizeSelfReviewConfig,
  modeConsistentDefaults,
  normalizeDiscoveryHealthField,
  normalizeValidationEvidenceField,
} from './policy-snapshot-normalize.js';

// ─── Canonical Snapshot Creation ──────────────────────────────────────────────

function buildAuditSection(audit: AuditPolicy): PolicySnapshot['audit'] {
  return {
    emitTransitions: audit.emitTransitions,
    emitToolCalls: audit.emitToolCalls,
    enableChainHash: audit.enableChainHash,
    timestampAssurance: {
      enabled: audit.timestampAssurance.enabled,
      mode: audit.timestampAssurance.mode,
      strict: audit.timestampAssurance.strict,
      criticalEvents: [...audit.timestampAssurance.criticalEvents],
      ...(audit.timestampAssurance.tsaUrl ? { tsaUrl: audit.timestampAssurance.tsaUrl } : {}),
      ...(audit.timestampAssurance.trustAnchors
        ? { trustAnchors: [...audit.timestampAssurance.trustAnchors] }
        : {}),
      ...(audit.timestampAssurance.ntpServers
        ? { ntpServers: [...audit.timestampAssurance.ntpServers] }
        : {}),
      ntpDriftThresholdMs: audit.timestampAssurance.ntpDriftThresholdMs,
      tsaTimeoutMs: audit.timestampAssurance.tsaTimeoutMs,
    },
  };
}

function validatePolicyDigest(hash: string): string {
  if (POLICY_DIGEST_PATTERN.test(hash)) return hash;
  throw new PolicyConfigurationError(
    'INVALID_POLICY_DIGEST',
    'Policy digest must be a 64-character lowercase SHA-256 hex string.',
    { received: hash, pattern: POLICY_DIGEST_PATTERN.source },
  );
}

function buildResolutionFields(
  resolution: Parameters<typeof createPolicySnapshot>[3],
  policy: FlowGuardPolicy,
  fallbackGate: EffectiveGateBehavior,
) {
  if (!resolution) return { requestedMode: policy.mode };
  const r = resolution;
  return {
    requestedMode: r.requestedMode ?? policy.mode,
    effectiveGateBehavior: r.effectiveGateBehavior ?? fallbackGate,
    ...(r.source ? { source: r.source } : ({} as Record<string, unknown>)),
    ...(r.degradedReason ? { degradedReason: r.degradedReason } : ({} as Record<string, unknown>)),
    ...(r.resolutionReason
      ? { resolutionReason: r.resolutionReason }
      : ({} as Record<string, unknown>)),
    ...(r.centralMinimumMode
      ? { centralMinimumMode: r.centralMinimumMode }
      : ({} as Record<string, unknown>)),
    ...(r.policyDigest ? { policyDigest: r.policyDigest } : ({} as Record<string, unknown>)),
    ...(r.policyVersion ? { policyVersion: r.policyVersion } : ({} as Record<string, unknown>)),
    ...(r.policyPathHint ? { policyPathHint: r.policyPathHint } : ({} as Record<string, unknown>)),
  };
}

export function createPolicySnapshot(
  policy: FlowGuardPolicy,
  resolvedAt: string,
  digestFn: (text: string) => string,
  resolution?: {
    requestedMode: PolicyMode;
    effectiveGateBehavior: EffectiveGateBehavior;
    degradedReason?: PolicyDegradedReason;
    source?: PolicySource;
    resolutionReason?: PolicyResolutionReason;
    centralMinimumMode?: CentralMinimumMode;
    policyDigest?: string;
    policyVersion?: string;
    policyPathHint?: string;
  },
): PolicySnapshot {
  const canonical = canonicalJsonStringify(policy);
  const hash = validatePolicyDigest(digestFn(canonical));
  const fallbackGate = policy.requireHumanGates
    ? ('human_gated' as const)
    : ('auto_approve' as const);

  return {
    mode: policy.mode,
    hash,
    hashVersion: POLICY_DIGEST_VERSION,
    resolvedAt,
    ...(buildResolutionFields(resolution, policy, fallbackGate) as Record<string, unknown>),
    requestedMode: resolution?.requestedMode ?? policy.mode,
    effectiveGateBehavior: resolution?.effectiveGateBehavior ?? fallbackGate,
    requireHumanGates: policy.requireHumanGates,
    maxSelfReviewIterations: policy.maxSelfReviewIterations,
    maxImplReviewIterations: policy.maxImplReviewIterations,
    maxIncoherentReviewerCaptureRetries: policy.maxIncoherentReviewerCaptureRetries,
    maxReviewerOutputRepairAttempts: policy.maxReviewerOutputRepairAttempts,
    allowSelfApproval: policy.allowSelfApproval,
    requireVerifiedActorsForApproval: policy.requireVerifiedActorsForApproval,
    audit: buildAuditSection(policy.audit),
    actorClassification: { ...policy.actorClassification },
    minimumActorAssuranceForApproval: policy.minimumActorAssuranceForApproval,
    ...(policy.identityProvider ? { identityProvider: policy.identityProvider } : {}),
    identityProviderMode: policy.identityProviderMode,
    selfReview: policy.selfReview,
    reviewOutputPolicy: policy.reviewOutputPolicy,
    reviewInvocationPolicy: policy.reviewInvocationPolicy,
    reviewProfile: policy.reviewProfile,
    challengePolicy: {
      version: policy.challengePolicy.version,
      counts: { ...policy.challengePolicy.counts },
    },
    enforceRiskClassification: policy.enforceRiskClassification,
    allowRiskDowngradeOverride: policy.allowRiskDowngradeOverride,
    allowReducedCeremony: policy.allowReducedCeremony,
    discoveryHealth: {
      enforcement: policy.discoveryHealth.enforcement,
      onDegraded: policy.discoveryHealth.onDegraded,
      onDrift: policy.discoveryHealth.onDrift,
    },
    validationEvidence: {
      enforcement: policy.validationEvidence.enforcement,
      allowNoCommands: policy.validationEvidence.allowNoCommands,
    },
  };
}

// ─── Policy Freeze — Resolution → Snapshot ────────────────────────────────────

export function freezePolicySnapshot(
  resolution: PolicyResolution | HydratePolicyResolution,
  resolvedAt: string,
  digestFn: (text: string) => string,
): PolicySnapshot {
  return createPolicySnapshot(resolution.policy, resolvedAt, digestFn, {
    requestedMode: resolution.requestedMode,
    effectiveGateBehavior: resolution.effectiveGateBehavior,
    degradedReason: resolution.degradedReason,
    source: 'effectiveSource' in resolution ? resolution.effectiveSource : undefined,
    resolutionReason: 'resolutionReason' in resolution ? resolution.resolutionReason : undefined,
    centralMinimumMode:
      'centralEvidence' in resolution ? resolution.centralEvidence?.minimumMode : undefined,
    policyDigest: 'centralEvidence' in resolution ? resolution.centralEvidence?.digest : undefined,
    policyVersion:
      'centralEvidence' in resolution ? resolution.centralEvidence?.version : undefined,
    policyPathHint:
      'centralEvidence' in resolution ? resolution.centralEvidence?.pathHint : undefined,
  });
}

// ─── Snapshot → Runtime Policy ────────────────────────────────────────────────

/**
 * Resolve the three frozen review policies from a snapshot, applying
 * mode-consistent fail-closed defaults for legacy snapshots. Extracted to keep
 * resolvePolicyFromSnapshot within its cyclomatic-complexity budget.
 */
function resolveReviewPolicies(snapshot: PolicySnapshot): {
  reviewOutputPolicy: FlowGuardPolicy['reviewOutputPolicy'];
  reviewInvocationPolicy: FlowGuardPolicy['reviewInvocationPolicy'];
  reviewProfile: FlowGuardPolicy['reviewProfile'];
} {
  const defaults = modeConsistentDefaults(snapshot.mode);
  return {
    reviewOutputPolicy: snapshot.reviewOutputPolicy ?? defaults.reviewOutputPolicy,
    reviewInvocationPolicy: snapshot.reviewInvocationPolicy ?? defaults.reviewInvocationPolicy,
    reviewProfile: snapshot.reviewProfile ?? defaults.reviewProfile,
  };
}

export function resolvePolicyFromSnapshot(snapshot: PolicySnapshot): FlowGuardPolicy {
  const reviewPolicies = resolveReviewPolicies(snapshot);
  return {
    mode: snapshot.mode,
    requireHumanGates: snapshot.requireHumanGates,
    maxSelfReviewIterations: snapshot.maxSelfReviewIterations,
    maxImplReviewIterations: snapshot.maxImplReviewIterations,
    maxIncoherentReviewerCaptureRetries: snapshot.maxIncoherentReviewerCaptureRetries ?? 1,
    maxReviewerOutputRepairAttempts:
      snapshot.maxReviewerOutputRepairAttempts ?? DEFAULT_MAX_REVIEWER_OUTPUT_REPAIR_ATTEMPTS,
    allowSelfApproval: snapshot.allowSelfApproval,
    selfReview: normalizeSelfReviewConfig(snapshot.selfReview),
    reviewOutputPolicy: reviewPolicies.reviewOutputPolicy,
    reviewInvocationPolicy: reviewPolicies.reviewInvocationPolicy,
    reviewProfile: reviewPolicies.reviewProfile,
    challengePolicy: snapshot.challengePolicy,
    minimumActorAssuranceForApproval:
      snapshot.minimumActorAssuranceForApproval ??
      (snapshot.requireVerifiedActorsForApproval
        ? 'claim_validated'
        : modeConsistentDefaults(snapshot.mode).minimumActorAssuranceForApproval),
    requireVerifiedActorsForApproval: snapshot.requireVerifiedActorsForApproval ?? false,
    audit: {
      emitTransitions: snapshot.audit.emitTransitions,
      emitToolCalls: snapshot.audit.emitToolCalls,
      enableChainHash: snapshot.audit.enableChainHash,
      timestampAssurance: ((snapshot.audit as Record<string, unknown>)
        .timestampAssurance as TimestampAssurancePolicy) ?? {
        enabled: false,
        mode: 'local_only' as const,
        strict: false,
        criticalEvents: ['decision', 'lifecycle'],
        ntpServers: ['pool.ntp.org'],
        ntpDriftThresholdMs: 30000,
        tsaTimeoutMs: 10000,
      },
    } satisfies AuditPolicy,
    actorClassification: { ...snapshot.actorClassification },
    identityProvider: snapshot.identityProvider,
    identityProviderMode: snapshot.identityProviderMode ?? 'optional',
    enforceRiskClassification:
      snapshot.enforceRiskClassification ??
      modeConsistentDefaults(snapshot.mode).enforceRiskClassification,
    allowRiskDowngradeOverride:
      snapshot.allowRiskDowngradeOverride ??
      modeConsistentDefaults(snapshot.mode).allowRiskDowngradeOverride,
    allowReducedCeremony:
      snapshot.allowReducedCeremony ?? modeConsistentDefaults(snapshot.mode).allowReducedCeremony,
    discoveryHealth: normalizeDiscoveryHealthField(
      (snapshot as Record<string, unknown>).discoveryHealth,
      modeConsistentDefaults(snapshot.mode).discoveryHealth,
    ).value,
    validationEvidence: normalizeValidationEvidenceField(
      (snapshot as Record<string, unknown>).validationEvidence,
      modeConsistentDefaults(snapshot.mode).validationEvidence,
    ).value,
  };
}
