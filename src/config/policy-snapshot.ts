/**
 * @module config/policy-snapshot
 * @description Policy Snapshot Authority — SSOT for policy snapshot lifecycle.
 *
 * Three canonical functions:
 * 1. createPolicySnapshot() — create an immutable snapshot from a policy
 * 2. freezePolicySnapshot()  — freeze a PolicyResolution or HydratePolicyResolution
 * 3. resolvePolicyFromSnapshot() — reconstruct executable FlowGuardPolicy from snapshot
 *
 * Snapshot validation and reconstruction live in the canonical policy snapshot
 * contract; incomplete snapshots are rejected at its trust boundary.
 *
 * The snapshot is the sole runtime authority for all governance-critical checks.
 * No runtime path should reconstruct policy from policyMode alone.
 *
 * Dependency: PolicySnapshot is the canonical persisted state contract consumed
 * by this policy lifecycle authority.
 *
 * @version v1
 */

import type { PolicySnapshot } from '../state/evidence.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { POLICY_DIGEST_PATTERN, POLICY_DIGEST_VERSION } from '../state/evidence-identifiers.js';
import { PolicyConfigurationError } from './policy-errors.js';
import type {
  FlowGuardPolicy,
  AuditPolicy,
  PolicyMode,
  EffectiveGateBehavior,
  PolicyDegradedReason,
  PolicySource,
  PolicyResolutionReason,
  CentralMinimumMode,
} from './policy-types.js';
import type { PolicyResolution } from './policy-resolver.js';
import type { HydratePolicyResolution } from './policy-types.js';

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

/**
 * Frozen resolution provenance — never executable policy. `requestedMode` and
 * `effectiveGateBehavior` are intentionally NOT part of this projection: they
 * are owned exactly once by the snapshot literal below.
 */
type PolicyResolutionProvenance = Pick<
  PolicySnapshot,
  | 'source'
  | 'degradedReason'
  | 'resolutionReason'
  | 'centralMinimumMode'
  | 'policyDigest'
  | 'policyVersion'
  | 'policyPathHint'
>;

function buildResolutionProvenance(
  resolution: Parameters<typeof createPolicySnapshot>[3],
): PolicyResolutionProvenance {
  const {
    source,
    degradedReason,
    resolutionReason,
    centralMinimumMode,
    policyDigest,
    policyVersion,
    policyPathHint,
  } = resolution ?? {};
  return {
    ...(source ? { source } : {}),
    ...(degradedReason ? { degradedReason } : {}),
    ...(resolutionReason ? { resolutionReason } : {}),
    ...(centralMinimumMode ? { centralMinimumMode } : {}),
    ...(policyDigest ? { policyDigest } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    ...(policyPathHint ? { policyPathHint } : {}),
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
    ...buildResolutionProvenance(resolution),
    requestedMode: resolution?.requestedMode ?? policy.mode,
    effectiveGateBehavior: resolution?.effectiveGateBehavior ?? fallbackGate,
    requireHumanGates: policy.requireHumanGates,
    reviewBudget: { ...policy.reviewBudget },
    maxIncoherentReviewerCaptureRetries: policy.maxIncoherentReviewerCaptureRetries,
    maxReviewerAttempts: policy.maxReviewerAttempts,
    allowSelfApproval: policy.allowSelfApproval,
    audit: buildAuditSection(policy.audit),
    actorClassification: { ...policy.actorClassification },
    minimumActorAssuranceForApproval: policy.minimumActorAssuranceForApproval,
    ...(policy.identityProvider ? { identityProvider: policy.identityProvider } : {}),
    identityProviderMode: policy.identityProviderMode,
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
  const centralEvidence = 'centralEvidence' in resolution ? resolution.centralEvidence : undefined;
  return createPolicySnapshot(resolution.policy, resolvedAt, digestFn, {
    requestedMode: resolution.requestedMode,
    effectiveGateBehavior: resolution.effectiveGateBehavior,
    ...(resolution.degradedReason !== undefined
      ? { degradedReason: resolution.degradedReason }
      : {}),
    ...('effectiveSource' in resolution ? { source: resolution.effectiveSource } : {}),
    ...('resolutionReason' in resolution && resolution.resolutionReason !== undefined
      ? { resolutionReason: resolution.resolutionReason }
      : {}),
    ...(centralEvidence !== undefined ? { centralMinimumMode: centralEvidence.minimumMode } : {}),
    ...(centralEvidence !== undefined ? { policyDigest: centralEvidence.digest } : {}),
    ...(centralEvidence?.version !== undefined ? { policyVersion: centralEvidence.version } : {}),
    ...(centralEvidence !== undefined ? { policyPathHint: centralEvidence.pathHint } : {}),
  });
}

// ─── Snapshot → Runtime Policy ────────────────────────────────────────────────

export function resolvePolicyFromSnapshot(snapshot: PolicySnapshot): FlowGuardPolicy {
  return {
    mode: snapshot.mode,
    requireHumanGates: snapshot.requireHumanGates,
    reviewBudget: { ...snapshot.reviewBudget },
    maxIncoherentReviewerCaptureRetries: snapshot.maxIncoherentReviewerCaptureRetries,
    maxReviewerAttempts: snapshot.maxReviewerAttempts,
    allowSelfApproval: snapshot.allowSelfApproval,
    reviewProfile: snapshot.reviewProfile,
    challengePolicy: snapshot.challengePolicy,
    minimumActorAssuranceForApproval: snapshot.minimumActorAssuranceForApproval,
    audit: {
      emitTransitions: snapshot.audit.emitTransitions,
      emitToolCalls: snapshot.audit.emitToolCalls,
      enableChainHash: snapshot.audit.enableChainHash,
      timestampAssurance: {
        enabled: snapshot.audit.timestampAssurance.enabled,
        mode: snapshot.audit.timestampAssurance.mode,
        strict: snapshot.audit.timestampAssurance.strict,
        criticalEvents: [...snapshot.audit.timestampAssurance.criticalEvents],
        ...(snapshot.audit.timestampAssurance.tsaUrl !== undefined
          ? { tsaUrl: snapshot.audit.timestampAssurance.tsaUrl }
          : {}),
        ...(snapshot.audit.timestampAssurance.trustAnchors !== undefined
          ? { trustAnchors: [...snapshot.audit.timestampAssurance.trustAnchors] }
          : {}),
        ...(snapshot.audit.timestampAssurance.ntpServers !== undefined
          ? { ntpServers: [...snapshot.audit.timestampAssurance.ntpServers] }
          : {}),
        ntpDriftThresholdMs: snapshot.audit.timestampAssurance.ntpDriftThresholdMs,
        tsaTimeoutMs: snapshot.audit.timestampAssurance.tsaTimeoutMs,
      },
    } satisfies AuditPolicy,
    actorClassification: { ...snapshot.actorClassification },
    ...(snapshot.identityProvider !== undefined
      ? { identityProvider: snapshot.identityProvider }
      : {}),
    identityProviderMode: snapshot.identityProviderMode,
    enforceRiskClassification: snapshot.enforceRiskClassification,
    allowRiskDowngradeOverride: snapshot.allowRiskDowngradeOverride,
    allowReducedCeremony: snapshot.allowReducedCeremony,
    discoveryHealth: { ...snapshot.discoveryHealth },
    validationEvidence: { ...snapshot.validationEvidence },
  };
}
