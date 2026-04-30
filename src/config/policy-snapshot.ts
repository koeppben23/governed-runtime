/**
 * @module config/policy-snapshot
 * @description Policy Snapshot Authority — SSOT for policy snapshot lifecycle.
 *
 * Four canonical functions:
 * 1. createPolicySnapshot() — create an immutable snapshot from a policy
 * 2. freezePolicySnapshot()  — freeze a PolicyResolution or HydratePolicyResolution
 * 3. normalizePolicySnapshot() — enrich incomplete/legacy snapshots with safe defaults
 * 4. resolvePolicyFromSnapshot() — reconstruct executable FlowGuardPolicy from snapshot
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
import type { IdpConfig, IdentityProviderMode } from '../identity/types.js';
import type {
  FlowGuardPolicy,
  PolicyMode,
  EffectiveGateBehavior,
  PolicyDegradedReason,
  PolicySource,
  PolicyResolutionReason,
  CentralMinimumMode,
  PolicyResolution,
  SelfReviewConfig,
} from './policy.js';
import type { HydratePolicyResolution } from './policy.js';
import { DEFAULT_SELF_REVIEW_CONFIG } from './policy.js';

function normalizeSelfReviewConfig(value: unknown): SelfReviewConfig {
  if (value === null || typeof value !== 'object') {
    console.warn(
      '[FlowGuard] Legacy selfReview config (null/undefined) normalized to mandatory strict. ' +
        'Ensure flowguard-reviewer plugin is active.',
    );
    return DEFAULT_SELF_REVIEW_CONFIG;
  }

  const candidate = value as Partial<SelfReviewConfig>;
  if (
    candidate.subagentEnabled === true &&
    candidate.fallbackToSelf === false &&
    candidate.strictEnforcement === true
  ) {
    return DEFAULT_SELF_REVIEW_CONFIG;
  }

  console.warn(
    '[FlowGuard] Legacy/weakened selfReview config normalized to mandatory strict. ' +
      `Original: subagentEnabled=${candidate.subagentEnabled}, ` +
      `fallbackToSelf=${candidate.fallbackToSelf}, ` +
      `strictEnforcement=${candidate.strictEnforcement}. ` +
      'Ensure flowguard-reviewer plugin is active.',
  );
  return DEFAULT_SELF_REVIEW_CONFIG;
}

// ─── Canonical Snapshot Creation ──────────────────────────────────────────────

/**
 * Create an immutable policy snapshot for embedding in SessionState.
 *
 * The snapshot freezes all FlowGuard-critical fields. The hash provides
 * non-repudiation: given the hash and the policy registry, an auditor
 * can verify which exact policy governed a session.
 *
 * @param policy - The resolved FlowGuard policy.
 * @param resolvedAt - ISO-8601 timestamp when the policy was frozen.
 * @param digestFn - SHA-256 digest function (injected for testability).
 */
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
  const canonical = JSON.stringify(policy, Object.keys(policy).sort());

  return {
    mode: policy.mode,
    hash: digestFn(canonical),
    resolvedAt,
    requestedMode: resolution?.requestedMode ?? policy.mode,
    ...(resolution?.source ? { source: resolution.source } : {}),
    effectiveGateBehavior:
      resolution?.effectiveGateBehavior ??
      (policy.requireHumanGates ? 'human_gated' : 'auto_approve'),
    ...(resolution?.degradedReason ? { degradedReason: resolution.degradedReason } : {}),
    ...(resolution?.resolutionReason ? { resolutionReason: resolution.resolutionReason } : {}),
    ...(resolution?.centralMinimumMode
      ? { centralMinimumMode: resolution.centralMinimumMode }
      : {}),
    ...(resolution?.policyDigest ? { policyDigest: resolution.policyDigest } : {}),
    ...(resolution?.policyVersion ? { policyVersion: resolution.policyVersion } : {}),
    ...(resolution?.policyPathHint ? { policyPathHint: resolution.policyPathHint } : {}),
    requireHumanGates: policy.requireHumanGates,
    maxSelfReviewIterations: policy.maxSelfReviewIterations,
    maxImplReviewIterations: policy.maxImplReviewIterations,
    allowSelfApproval: policy.allowSelfApproval,
    requireVerifiedActorsForApproval: policy.requireVerifiedActorsForApproval,
    audit: {
      emitTransitions: policy.audit.emitTransitions,
      emitToolCalls: policy.audit.emitToolCalls,
      enableChainHash: policy.audit.enableChainHash,
    },
    actorClassification: { ...policy.actorClassification },
    minimumActorAssuranceForApproval: policy.minimumActorAssuranceForApproval,
    ...(policy.identityProvider ? { identityProvider: policy.identityProvider } : {}),
    identityProviderMode: policy.identityProviderMode,
    ...(policy.selfReview ? { selfReview: policy.selfReview } : {}),
  };
}

// ─── Policy Freeze — Resolution → Snapshot ────────────────────────────────────

/**
 * Freeze a resolved policy into an immutable PolicySnapshot.
 *
 * Accepts both PolicyResolution (from resolvePolicyWithContext) and
 * HydratePolicyResolution (from resolvePolicyForHydrate). All metadata
 * fields (source, resolutionReason, centralEvidence) are preserved
 * in the snapshot for complete audit provenance.
 *
 * Governance-critical fields (actorClassification, minimumActorAssurance,
 * identityProvider, identityProviderMode, selfReview) are frozen from
 * the resolved FlowGuardPolicy.
 *
 * @param resolution — PolicyResolution or HydratePolicyResolution.
 * @param resolvedAt — ISO-8601 timestamp.
 * @param digestFn — SHA-256 digest function.
 */
export function freezePolicySnapshot(
  resolution: PolicyResolution | HydratePolicyResolution,
  resolvedAt: string,
  digestFn: (text: string) => string,
): PolicySnapshot {
  const res = resolution as HydratePolicyResolution;
  return createPolicySnapshot(resolution.policy, resolvedAt, digestFn, {
    requestedMode: resolution.requestedMode,
    effectiveGateBehavior: resolution.effectiveGateBehavior,
    degradedReason: resolution.degradedReason,
    source: 'effectiveSource' in res ? res.effectiveSource : undefined,
    resolutionReason: 'resolutionReason' in res ? res.resolutionReason : undefined,
    centralMinimumMode: 'centralEvidence' in res ? res.centralEvidence?.minimumMode : undefined,
    policyDigest: 'centralEvidence' in res ? res.centralEvidence?.digest : undefined,
    policyVersion: 'centralEvidence' in res ? res.centralEvidence?.version : undefined,
    policyPathHint: 'centralEvidence' in res ? res.centralEvidence?.pathHint : undefined,
  });
}

// ─── Snapshot Normalization — Legacy/Incomplete → Complete ────────────────────

/** Result of snapshot normalization with meta-information. */
export interface NormalizedSnapshotResult {
  /** The normalized (complete) PolicySnapshot. */
  readonly snapshot: PolicySnapshot;
  /** Whether any fields were normalized (filled from defaults). */
  readonly normalized: boolean;
  /** Reason for normalization if snapshot was incomplete. */
  readonly reason?: 'incomplete_snapshot_normalized';
}

/** Validate that a policy mode value is one of the known modes. */
function isValidMode(mode: unknown): mode is PolicyMode {
  return typeof mode === 'string' && ['solo', 'team', 'team-ci', 'regulated'].includes(mode);
}

/** Validate effective gate behavior value. */
function isValidGateBehavior(v: unknown): v is EffectiveGateBehavior {
  return v === 'auto_approve' || v === 'human_gated';
}

/** Validate identity provider mode value. */
function isValidIdpMode(v: unknown): v is IdentityProviderMode {
  return v === 'optional' || v === 'required';
}

/** Validate actor assurance tier. */
function isValidAssurance(v: unknown): v is 'best_effort' | 'claim_validated' | 'idp_verified' {
  return typeof v === 'string' && ['best_effort', 'claim_validated', 'idp_verified'].includes(v);
}

/**
 * Normalize a potentially incomplete or legacy policy snapshot.
 *
 * Returns the normalized snapshot WITHOUT meta-information.
 * Use normalizePolicySnapshotWithMeta() when you need to know
 * whether normalization occurred.
 *
 * @param snapshot — Raw snapshot from session state (may be partial/null).
 * @returns Complete, normalized PolicySnapshot with consistent safe defaults.
 */
export function normalizePolicySnapshot(
  snapshot: Record<string, unknown> | null | undefined,
): PolicySnapshot {
  return normalizePolicySnapshotWithMeta(snapshot).snapshot;
}

/**
 * Normalize and return meta-information about what was changed.
 *
 * Enriches incomplete/legacy snapshots with safe defaults.
 * Marks whether normalization occurred so runtime can distinguish
 * authoritative snapshots from legacy-fallback reconstructions.
 *
 * @param snapshot — Raw snapshot from session state.
 * @returns Normalized snapshot with normalization meta.
 */
export function normalizePolicySnapshotWithMeta(
  snapshot: Record<string, unknown> | null | undefined,
): NormalizedSnapshotResult {
  const s = snapshot ?? {};
  let normalized = false;

  // Resolve mode first — other defaults depend on it
  const rawMode = s.mode;
  const mode: PolicyMode = isValidMode(rawMode) ? rawMode : 'team';
  if (!isValidMode(rawMode)) normalized = true;

  // Derive mode-consistent defaults
  const modeDefaults = modeConsistentDefaults(mode);

  // Build normalized snapshot field by field with validation
  const rawHash = s.hash;
  const hash: string =
    typeof rawHash === 'string' && rawHash.length > 0 ? rawHash : 'UNKNOWN_LEGACY';
  if (hash === 'UNKNOWN_LEGACY') normalized = true;

  const rawRequestedMode = s.requestedMode;
  const requestedMode: string = typeof rawRequestedMode === 'string' ? rawRequestedMode : mode;
  if (!isValidMode(rawRequestedMode)) normalized = true;

  const rawGateBehavior = s.effectiveGateBehavior;
  const effectiveGateBehavior: EffectiveGateBehavior = isValidGateBehavior(rawGateBehavior)
    ? rawGateBehavior
    : modeDefaults.effectiveGateBehavior;
  if (!isValidGateBehavior(rawGateBehavior)) normalized = true;

  const rawRequireHuman = s.requireHumanGates;
  const requireHumanGates: boolean =
    typeof rawRequireHuman === 'boolean' ? rawRequireHuman : modeDefaults.requireHumanGates;
  if (typeof rawRequireHuman !== 'boolean') normalized = true;

  const rawMaxSelf = s.maxSelfReviewIterations;
  const maxSelfReviewIterations: number =
    typeof rawMaxSelf === 'number' ? rawMaxSelf : modeDefaults.maxSelfReviewIterations;
  if (typeof rawMaxSelf !== 'number') normalized = true;

  const rawMaxImpl = s.maxImplReviewIterations;
  const maxImplReviewIterations: number =
    typeof rawMaxImpl === 'number' ? rawMaxImpl : modeDefaults.maxImplReviewIterations;
  if (typeof rawMaxImpl !== 'number') normalized = true;

  const rawAllowSelf = s.allowSelfApproval;
  const allowSelfApproval: boolean =
    typeof rawAllowSelf === 'boolean' ? rawAllowSelf : modeDefaults.allowSelfApproval;
  if (typeof rawAllowSelf !== 'boolean') normalized = true;

  const rawReqVerified = s.requireVerifiedActorsForApproval;
  const requireVerifiedActorsForApproval: boolean =
    typeof rawReqVerified === 'boolean' ? rawReqVerified : false;
  if (typeof rawReqVerified !== 'boolean') normalized = true;

  const rawAssurance = s.minimumActorAssuranceForApproval;
  let minimumActorAssuranceForApproval: 'best_effort' | 'claim_validated' | 'idp_verified';
  if (isValidAssurance(rawAssurance)) {
    minimumActorAssuranceForApproval = rawAssurance;
  } else if (typeof rawReqVerified === 'boolean' && rawReqVerified) {
    minimumActorAssuranceForApproval = 'claim_validated';
  } else {
    minimumActorAssuranceForApproval = modeDefaults.minimumActorAssuranceForApproval;
  }
  if (!isValidAssurance(rawAssurance)) normalized = true;

  const rawIdpMode = s.identityProviderMode;
  const identityProviderMode: IdentityProviderMode = isValidIdpMode(rawIdpMode)
    ? rawIdpMode
    : 'optional';
  if (!isValidIdpMode(rawIdpMode)) normalized = true;

  const rawActorClass = s.actorClassification;
  const actorClassification: Record<string, string> =
    rawActorClass !== null && typeof rawActorClass === 'object'
      ? (rawActorClass as Record<string, string>)
      : {};
  if (typeof rawActorClass !== 'object' || rawActorClass === null) normalized = true;

  const rawAudit = s.audit as Record<string, unknown> | null | undefined;
  const audit: { emitTransitions: boolean; emitToolCalls: boolean; enableChainHash: boolean } = {
    emitTransitions:
      typeof rawAudit?.emitTransitions === 'boolean' ? rawAudit.emitTransitions : true,
    emitToolCalls: typeof rawAudit?.emitToolCalls === 'boolean' ? rawAudit.emitToolCalls : true,
    enableChainHash:
      typeof rawAudit?.enableChainHash === 'boolean' ? rawAudit.enableChainHash : true,
  };
  if (!rawAudit || typeof rawAudit !== 'object') normalized = true;

  const rawSelfReview = s.selfReview as Partial<SelfReviewConfig> | null | undefined;
  if (
    !rawSelfReview ||
    rawSelfReview.subagentEnabled !== true ||
    rawSelfReview.fallbackToSelf !== false ||
    rawSelfReview.strictEnforcement !== true
  ) {
    normalized = true;
  }

  return {
    snapshot: {
      mode,
      hash,
      resolvedAt:
        typeof s.resolvedAt === 'string'
          ? s.resolvedAt
          : new Date('2026-01-01T00:00:00.000Z').toISOString(),
      requestedMode,
      source: typeof s.source === 'string' ? (s.source as PolicySource) : undefined,
      effectiveGateBehavior,
      degradedReason:
        typeof s.degradedReason === 'string'
          ? (s.degradedReason as PolicyDegradedReason)
          : undefined,
      resolutionReason:
        typeof s.resolutionReason === 'string'
          ? (s.resolutionReason as PolicyResolutionReason)
          : undefined,
      centralMinimumMode:
        typeof s.centralMinimumMode === 'string'
          ? (s.centralMinimumMode as CentralMinimumMode)
          : undefined,
      policyDigest: typeof s.policyDigest === 'string' ? s.policyDigest : undefined,
      policyVersion: typeof s.policyVersion === 'string' ? s.policyVersion : undefined,
      policyPathHint: typeof s.policyPathHint === 'string' ? s.policyPathHint : undefined,
      requireHumanGates,
      maxSelfReviewIterations,
      maxImplReviewIterations,
      allowSelfApproval,
      requireVerifiedActorsForApproval,
      audit,
      actorClassification,
      minimumActorAssuranceForApproval,
      identityProvider:
        s.identityProvider !== null && typeof s.identityProvider === 'object'
          ? (s.identityProvider as IdpConfig)
          : undefined,
      identityProviderMode,
      selfReview: normalizeSelfReviewConfig(rawSelfReview),
    },
    normalized,
    reason: normalized ? 'incomplete_snapshot_normalized' : undefined,
  };
}

/** Mode-consistent safe defaults derived from policy presets. */
function modeConsistentDefaults(mode: PolicyMode): {
  readonly requireHumanGates: boolean;
  readonly maxSelfReviewIterations: number;
  readonly maxImplReviewIterations: number;
  readonly allowSelfApproval: boolean;
  readonly minimumActorAssuranceForApproval: 'best_effort' | 'claim_validated' | 'idp_verified';
  readonly effectiveGateBehavior: EffectiveGateBehavior;
} {
  switch (mode) {
    case 'solo':
      return {
        requireHumanGates: false,
        maxSelfReviewIterations: 2,
        maxImplReviewIterations: 1,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        effectiveGateBehavior: 'auto_approve',
      };
    case 'regulated':
      return {
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: false,
        minimumActorAssuranceForApproval: 'best_effort',
        effectiveGateBehavior: 'human_gated',
      };
    case 'team':
    case 'team-ci':
      return {
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        effectiveGateBehavior: 'human_gated',
      };
  }
}

// ─── Snapshot → Runtime Policy ────────────────────────────────────────────────

/**
 * Reconstruct an executable policy from a frozen policy snapshot.
 *
 * Snapshot fields are the sole authority. No preset fallback.
 * All governance-critical fields including actorClassification
 * are read exclusively from the snapshot.
 *
 * This is the canonical runtime policy authority function.
 * All runtime checks MUST use policy from this function, not
 * reconstruct from policyMode alone.
 */
export function resolvePolicyFromSnapshot(snapshot: PolicySnapshot): FlowGuardPolicy {
  return {
    mode: snapshot.mode as PolicyMode,
    requireHumanGates: snapshot.requireHumanGates,
    maxSelfReviewIterations: snapshot.maxSelfReviewIterations,
    maxImplReviewIterations: snapshot.maxImplReviewIterations,
    allowSelfApproval: snapshot.allowSelfApproval,
    selfReview: normalizeSelfReviewConfig(snapshot.selfReview),
    minimumActorAssuranceForApproval:
      (snapshot.minimumActorAssuranceForApproval as
        | 'best_effort'
        | 'claim_validated'
        | 'idp_verified'
        | undefined) ??
      (snapshot.requireVerifiedActorsForApproval ? 'claim_validated' : 'best_effort'),
    requireVerifiedActorsForApproval: snapshot.requireVerifiedActorsForApproval ?? false,
    audit: {
      emitTransitions: snapshot.audit.emitTransitions,
      emitToolCalls: snapshot.audit.emitToolCalls,
      enableChainHash: snapshot.audit.enableChainHash,
    },
    actorClassification: { ...snapshot.actorClassification },
    identityProvider: snapshot.identityProvider,
    identityProviderMode: snapshot.identityProviderMode ?? 'optional',
  };
}
