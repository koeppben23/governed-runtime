/**
 * @module config/policy-snapshot-normalize
 * @description Policy snapshot normalization — enriches incomplete/legacy
 *              snapshots with mode-consistent safe defaults.
 *
 * Extracted from policy-snapshot.ts to keep the module under the 400 LOC
 * threshold. Build (createPolicySnapshot, freezePolicySnapshot) and resolve
 * (resolvePolicyFromSnapshot) remain in policy-snapshot.ts.
 *
 * @version v1
 */

import type { PolicySnapshot } from '../state/evidence.js';
import { POLICY_MODES, isPolicyMode } from '../state/policy-mode.js';
import type { IdpConfig, IdentityProviderMode } from '../identity/types.js';
import type {
  PolicyMode,
  EffectiveGateBehavior,
  PolicySource,
  CentralMinimumMode,
  SelfReviewConfig,
  ReviewOutputPolicy,
  ReviewInvocationPolicy,
  DiscoveryHealthPolicy,
  ValidationEvidencePolicy,
} from './policy-types.js';
import {
  DEFAULT_SELF_REVIEW_CONFIG,
  defaultDiscoveryHealthForMode,
  defaultValidationEvidenceForMode,
} from './policy-types.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { PolicyConfigurationError } from './policy-errors.js';

/**
 * Normalize a legacy or weakened selfReview config to the mandatory strict default.
 *
 * FlowGuard requires subagent-enabled, no-fallback, strict-enforcement self-review.
 * Any deviation (legacy null, partial config, weakened flags) is normalized to the
 * canonical strict config with a console warning for operator visibility.
 *
 * @internal Used by resolvePolicyFromSnapshot in policy-snapshot.ts.
 */
export function normalizeSelfReviewConfig(value: unknown): SelfReviewConfig {
  if (value === null || typeof value !== 'object') {
    getAdapterLogger().warn(
      'policy',
      'Legacy selfReview config (null/undefined) normalized to mandatory strict',
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

  getAdapterLogger().warn(
    'policy',
    'Legacy/weakened selfReview config normalized to mandatory strict',
    {
      originalSubagentEnabled: candidate.subagentEnabled,
      originalFallbackToSelf: candidate.fallbackToSelf,
      originalStrictEnforcement: candidate.strictEnforcement,
    },
  );
  return DEFAULT_SELF_REVIEW_CONFIG;
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

/** Validate that a policy mode value is one of the known modes (SSOT). */
function isValidMode(mode: unknown): mode is PolicyMode {
  return isPolicyMode(mode);
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

function isValidReviewOutputPolicy(v: unknown): v is ReviewOutputPolicy {
  return v === 'structured_required' || v === 'text_compat_allowed';
}

function isValidReviewInvocationPolicy(v: unknown): v is ReviewInvocationPolicy {
  return v === 'host_task_required' || v === 'host_task_preferred' || v === 'sdk_allowed';
}

function normalizeBooleanField(
  raw: unknown,
  fallback: boolean,
): { value: boolean; normalized: boolean } {
  return typeof raw === 'boolean'
    ? { value: raw, normalized: false }
    : { value: fallback, normalized: true };
}

function normalizeReviewPolicies(
  s: Record<string, unknown>,
  defaults: ReturnType<typeof modeConsistentDefaults>,
): {
  reviewOutputPolicy: ReviewOutputPolicy;
  reviewInvocationPolicy: ReviewInvocationPolicy;
  normalized: boolean;
} {
  const rawReviewOut = s.reviewOutputPolicy;
  const rawReviewInv = s.reviewInvocationPolicy;
  const validReviewOut = isValidReviewOutputPolicy(rawReviewOut);
  const validReviewInv = isValidReviewInvocationPolicy(rawReviewInv);
  return {
    reviewOutputPolicy: validReviewOut ? rawReviewOut : defaults.reviewOutputPolicy,
    reviewInvocationPolicy: validReviewInv ? rawReviewInv : defaults.reviewInvocationPolicy,
    normalized: !validReviewOut || !validReviewInv,
  };
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

// ─── Private Field Normalizers ────────────────────────────────────────────────

interface NormalizedField<T> {
  value: T;
  normalized: boolean;
}

function normalizeMode(s: Record<string, unknown>): NormalizedField<PolicyMode> {
  const raw = s.mode;
  if (isValidMode(raw)) return { value: raw, normalized: false };
  if (raw === undefined || raw === null) return { value: 'team', normalized: true };
  throw new PolicyConfigurationError(
    'INVALID_POLICY_MODE',
    `Invalid policy mode "${String(raw)}". Valid modes: ${POLICY_MODES.join(', ')}.`,
    { received: String(raw), allowed: POLICY_MODES },
  );
}

function normalizeHash(s: Record<string, unknown>): NormalizedField<string> {
  const raw = s.hash;
  if (typeof raw === 'string' && raw.length > 0) return { value: raw, normalized: false };
  return { value: 'UNKNOWN_LEGACY', normalized: true };
}

function normalizeCoreFields(
  s: Record<string, unknown>,
  defaults: ReturnType<typeof modeConsistentDefaults>,
): {
  requireHumanGates: boolean;
  maxSelfReviewIterations: number;
  maxImplReviewIterations: number;
  allowSelfApproval: boolean;
  normalized: boolean;
} {
  let norm = false;

  const rawHuman = s.requireHumanGates;
  const requireHumanGates = typeof rawHuman === 'boolean' ? rawHuman : defaults.requireHumanGates;
  if (typeof rawHuman !== 'boolean') norm = true;

  const rawMaxSelf = s.maxSelfReviewIterations;
  const maxSelfReviewIterations =
    typeof rawMaxSelf === 'number' ? rawMaxSelf : defaults.maxSelfReviewIterations;
  if (typeof rawMaxSelf !== 'number') norm = true;

  const rawMaxImpl = s.maxImplReviewIterations;
  const maxImplReviewIterations =
    typeof rawMaxImpl === 'number' ? rawMaxImpl : defaults.maxImplReviewIterations;
  if (typeof rawMaxImpl !== 'number') norm = true;

  const rawApprove = s.allowSelfApproval;
  const allowSelfApproval =
    typeof rawApprove === 'boolean' ? rawApprove : defaults.allowSelfApproval;
  if (typeof rawApprove !== 'boolean') norm = true;

  return {
    requireHumanGates,
    maxSelfReviewIterations,
    maxImplReviewIterations,
    allowSelfApproval,
    normalized: norm,
  };
}

function normalizePolicyFields(
  s: Record<string, unknown>,
  defaults: ReturnType<typeof modeConsistentDefaults>,
): {
  effectiveGateBehavior: EffectiveGateBehavior;
  requireVerifiedActorsForApproval: boolean;
  reviewOutputPolicy: ReviewOutputPolicy;
  reviewInvocationPolicy: ReviewInvocationPolicy;
  enforceRiskClassification: boolean;
  allowRiskDowngradeOverride: boolean;
  allowReducedCeremony: boolean;
  discoveryHealth: DiscoveryHealthPolicy;
  validationEvidence: ValidationEvidencePolicy;
  normalized: boolean;
} {
  let norm = false;

  const rawGate = s.effectiveGateBehavior;
  const effectiveGateBehavior = isValidGateBehavior(rawGate)
    ? rawGate
    : defaults.effectiveGateBehavior;
  if (!isValidGateBehavior(rawGate)) norm = true;

  const verifiedActors = normalizeBooleanField(s.requireVerifiedActorsForApproval, false);
  if (verifiedActors.normalized) norm = true;

  const rawEnforce = s.enforceRiskClassification;
  const enforceRiskClassification =
    typeof rawEnforce === 'boolean' ? rawEnforce : defaults.enforceRiskClassification;
  if (typeof rawEnforce !== 'boolean') norm = true;

  const riskOverride = normalizeBooleanField(
    s.allowRiskDowngradeOverride,
    defaults.allowRiskDowngradeOverride,
  );
  if (riskOverride.normalized) norm = true;

  const reducedCeremony = normalizeBooleanField(
    s.allowReducedCeremony,
    defaults.allowReducedCeremony,
  );
  if (reducedCeremony.normalized) norm = true;

  const reviewPolicies = normalizeReviewPolicies(s, defaults);
  if (reviewPolicies.normalized) norm = true;

  const discoveryHealthResult = normalizeDiscoveryHealthField(
    s.discoveryHealth,
    defaults.discoveryHealth,
  );
  if (discoveryHealthResult.normalized) norm = true;

  const validationEvidenceResult = normalizeValidationEvidenceField(
    s.validationEvidence,
    defaults.validationEvidence,
  );
  if (validationEvidenceResult.normalized) norm = true;

  return {
    effectiveGateBehavior,
    requireVerifiedActorsForApproval: verifiedActors.value,
    reviewOutputPolicy: reviewPolicies.reviewOutputPolicy,
    reviewInvocationPolicy: reviewPolicies.reviewInvocationPolicy,
    enforceRiskClassification,
    allowRiskDowngradeOverride: riskOverride.value,
    allowReducedCeremony: reducedCeremony.value,
    discoveryHealth: discoveryHealthResult.value,
    validationEvidence: validationEvidenceResult.value,
    normalized: norm,
  };
}

/**
 * Fail-closed normalization of a persisted discoveryHealth object (#399).
 *
 * Backward compatibility: snapshots written before #399 have no discoveryHealth
 * field. Rather than silently defaulting to `off`, missing or malformed values
 * fall back to the mode-consistent preset default, which preserves the
 * fail-closed posture for regulated/team-ci modes.
 *
 * @internal Used by resolvePolicyFromSnapshot in policy-snapshot.ts.
 */
export function normalizeDiscoveryHealthField(
  raw: unknown,
  fallback: DiscoveryHealthPolicy,
): NormalizedField<DiscoveryHealthPolicy> {
  if (raw === null || typeof raw !== 'object') {
    return { value: { ...fallback }, normalized: true };
  }
  const obj = raw as Record<string, unknown>;
  let normalized = false;

  const enforcement =
    obj.enforcement === 'off' || obj.enforcement === 'advisory' || obj.enforcement === 'required'
      ? obj.enforcement
      : ((normalized = true), fallback.enforcement);
  const onDegraded =
    obj.onDegraded === 'warn' || obj.onDegraded === 'block' || obj.onDegraded === 'advisory'
      ? obj.onDegraded
      : ((normalized = true), fallback.onDegraded);
  const onDrift =
    obj.onDrift === 'warn' || obj.onDrift === 'block' || obj.onDrift === 'advisory'
      ? obj.onDrift
      : ((normalized = true), fallback.onDrift);

  return { value: { enforcement, onDegraded, onDrift } as DiscoveryHealthPolicy, normalized };
}

/**
 * Fail-closed normalization of a persisted validationEvidence object (#400).
 *
 * Backward compatibility: snapshots written before #400 have no validationEvidence
 * field. Missing or malformed values fall back to the mode-consistent preset default.
 *
 * @internal Used by resolvePolicyFromSnapshot in policy-snapshot.ts.
 */
export function normalizeValidationEvidenceField(
  raw: unknown,
  fallback: ValidationEvidencePolicy,
): NormalizedField<ValidationEvidencePolicy> {
  if (raw === null || typeof raw !== 'object') {
    return { value: { ...fallback }, normalized: true };
  }
  const obj = raw as Record<string, unknown>;
  let normalized = false;

  const enforcement =
    obj.enforcement === 'off' || obj.enforcement === 'advisory' || obj.enforcement === 'required'
      ? obj.enforcement
      : ((normalized = true), fallback.enforcement);
  const allowNoCommands =
    typeof obj.allowNoCommands === 'boolean'
      ? obj.allowNoCommands
      : ((normalized = true), fallback.allowNoCommands);

  return { value: { enforcement, allowNoCommands }, normalized };
}

function normalizeActorAssurance(
  s: Record<string, unknown>,
  modeDefaults: ReturnType<typeof modeConsistentDefaults>,
  requireVerifiedActors: boolean,
): NormalizedField<'best_effort' | 'claim_validated' | 'idp_verified'> {
  const raw = s.minimumActorAssuranceForApproval;
  if (isValidAssurance(raw)) return { value: raw, normalized: false };
  if (requireVerifiedActors) return { value: 'claim_validated', normalized: true };
  return { value: modeDefaults.minimumActorAssuranceForApproval, normalized: true };
}

function normalizeIdpMode(s: Record<string, unknown>): NormalizedField<IdentityProviderMode> {
  const raw = s.identityProviderMode;
  if (isValidIdpMode(raw)) return { value: raw, normalized: false };
  return { value: 'optional', normalized: true };
}

function normalizeActorClassification(
  s: Record<string, unknown>,
): NormalizedField<Record<string, string>> {
  const raw = s.actorClassification;
  if (raw !== null && typeof raw === 'object') {
    return { value: raw as Record<string, string>, normalized: false };
  }
  return { value: {}, normalized: true };
}

const DEFAULT_AUDIT_VALUE = {
  emitTransitions: true,
  emitToolCalls: true,
  enableChainHash: true,
  timestampAssurance: {
    enabled: false,
    mode: 'local_only' as const,
    strict: false,
    criticalEvents: ['decision', 'lifecycle'],
    ntpServers: ['pool.ntp.org'],
    ntpDriftThresholdMs: 30000,
    tsaTimeoutMs: 10000,
  },
};

function buildTsaFromRaw(raw: Record<string, unknown>): {
  enabled: boolean;
  mode: 'local_only' | 'ntp_check' | 'tsa_critical';
  strict: boolean;
  criticalEvents: string[];
  tsaUrl?: string;
  trustAnchors?: string[];
  ntpServers?: string[];
  ntpDriftThresholdMs: number;
  tsaTimeoutMs: number;
} {
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : false;
  const mode = isValidTsAMode(raw.mode)
    ? (raw.mode as 'local_only' | 'ntp_check' | 'tsa_critical')
    : 'local_only';
  const strict = typeof raw.strict === 'boolean' ? raw.strict : false;
  const criticalEvents = Array.isArray(raw.criticalEvents)
    ? raw.criticalEvents.filter((e): e is string => typeof e === 'string')
    : ['decision', 'lifecycle'];
  const tsaUrl = typeof raw.tsaUrl === 'string' ? raw.tsaUrl : undefined;
  const trustAnchors = Array.isArray(raw.trustAnchors)
    ? raw.trustAnchors.filter((a): a is string => typeof a === 'string')
    : undefined;
  const ntpServers = Array.isArray(raw.ntpServers)
    ? raw.ntpServers.filter((n): n is string => typeof n === 'string')
    : ['pool.ntp.org'];
  const ntpDriftThresholdMs =
    typeof raw.ntpDriftThresholdMs === 'number' ? raw.ntpDriftThresholdMs : 30000;
  const tsaTimeoutMs = typeof raw.tsaTimeoutMs === 'number' ? raw.tsaTimeoutMs : 10000;
  return {
    enabled,
    mode,
    strict,
    criticalEvents,
    tsaUrl,
    trustAnchors,
    ntpServers,
    ntpDriftThresholdMs,
    tsaTimeoutMs,
  };
}

function normalizeAudit(s: Record<string, unknown>): NormalizedField<{
  emitTransitions: boolean;
  emitToolCalls: boolean;
  enableChainHash: boolean;
  timestampAssurance: {
    enabled: boolean;
    mode: 'local_only' | 'ntp_check' | 'tsa_critical';
    strict: boolean;
    criticalEvents: string[];
    tsaUrl?: string;
    trustAnchors?: string[];
    ntpServers?: string[];
    ntpDriftThresholdMs: number;
    tsaTimeoutMs: number;
  };
}> {
  const raw = s.audit as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') return { value: DEFAULT_AUDIT_VALUE, normalized: true };
  const emitTransitions = typeof raw.emitTransitions === 'boolean' ? raw.emitTransitions : true;
  const emitToolCalls = typeof raw.emitToolCalls === 'boolean' ? raw.emitToolCalls : true;
  const enableChainHash = typeof raw.enableChainHash === 'boolean' ? raw.enableChainHash : true;
  const rawTsa = raw.timestampAssurance as Record<string, unknown> | null | undefined;
  const timestampAssurance =
    rawTsa && typeof rawTsa === 'object'
      ? buildTsaFromRaw(rawTsa)
      : { ...DEFAULT_AUDIT_VALUE.timestampAssurance };
  return {
    value: { emitTransitions, emitToolCalls, enableChainHash, timestampAssurance },
    normalized: false,
  };
}

function isValidTsAMode(mode: unknown): boolean {
  return mode === 'local_only' || mode === 'ntp_check' || mode === 'tsa_critical';
}

function normalizeSelfReviewCheck(s: Record<string, unknown>): boolean {
  const raw = s.selfReview as Partial<SelfReviewConfig> | null | undefined;
  return (
    !raw ||
    raw.subagentEnabled !== true ||
    raw.fallbackToSelf !== false ||
    raw.strictEnforcement !== true
  );
}

function extractProvenanceFields(s: Record<string, unknown>, fallbackMode: PolicyMode) {
  const rawReqMode = s.requestedMode;
  const requestedModeValid = isValidMode(rawReqMode);
  return {
    requestedMode: requestedModeValid ? rawReqMode : fallbackMode,
    reqModeNormalized: !requestedModeValid,
    resolvedAt:
      typeof s.resolvedAt === 'string'
        ? s.resolvedAt
        : new Date('2026-01-01T00:00:00.000Z').toISOString(),
    source: typeof s.source === 'string' ? (s.source as PolicySource) : undefined,
    degradedReason: typeof s.degradedReason === 'string' ? s.degradedReason : undefined,
    resolutionReason: typeof s.resolutionReason === 'string' ? s.resolutionReason : undefined,
    centralMinimumMode:
      typeof s.centralMinimumMode === 'string'
        ? (s.centralMinimumMode as CentralMinimumMode)
        : undefined,
    policyDigest: typeof s.policyDigest === 'string' ? s.policyDigest : undefined,
    policyVersion: typeof s.policyVersion === 'string' ? s.policyVersion : undefined,
    policyPathHint: typeof s.policyPathHint === 'string' ? s.policyPathHint : undefined,
    identityProvider:
      s.identityProvider !== null && typeof s.identityProvider === 'object'
        ? (s.identityProvider as IdpConfig)
        : undefined,
  };
}

// ─── Public Wrapper ──────────────────────────────────────────────────────────

export function normalizePolicySnapshotWithMeta(
  snapshot: Record<string, unknown> | null | undefined,
): NormalizedSnapshotResult {
  const s = snapshot ?? {};

  const { value: mode, normalized: modeNorm } = normalizeMode(s);
  const defaults = modeConsistentDefaults(mode);

  const { value: hash, normalized: hashNorm } = normalizeHash(s);
  const core = normalizeCoreFields(s, defaults);
  const policy = normalizePolicyFields(s, defaults);
  const { value: minimumActorAssuranceForApproval, normalized: assuranceNorm } =
    normalizeActorAssurance(s, defaults, policy.requireVerifiedActorsForApproval);
  const { value: identityProviderMode, normalized: idpNorm } = normalizeIdpMode(s);
  const { value: actorClassification, normalized: actorNorm } = normalizeActorClassification(s);
  const { value: audit, normalized: auditNorm } = normalizeAudit(s);
  const selfReviewNorm = normalizeSelfReviewCheck(s);
  const proven = extractProvenanceFields(s, mode);

  const anyNormalized =
    modeNorm ||
    hashNorm ||
    core.normalized ||
    policy.normalized ||
    assuranceNorm ||
    idpNorm ||
    actorNorm ||
    auditNorm ||
    selfReviewNorm ||
    proven.reqModeNormalized;

  const rawSelfReview = s.selfReview as Partial<SelfReviewConfig> | null | undefined;

  return {
    snapshot: {
      mode,
      hash,
      resolvedAt: proven.resolvedAt,
      requestedMode: proven.requestedMode,
      source: proven.source,
      effectiveGateBehavior: policy.effectiveGateBehavior,
      degradedReason: proven.degradedReason,
      resolutionReason: proven.resolutionReason,
      centralMinimumMode: proven.centralMinimumMode,
      policyDigest: proven.policyDigest,
      policyVersion: proven.policyVersion,
      policyPathHint: proven.policyPathHint,
      requireHumanGates: core.requireHumanGates,
      maxSelfReviewIterations: core.maxSelfReviewIterations,
      maxImplReviewIterations: core.maxImplReviewIterations,
      allowSelfApproval: core.allowSelfApproval,
      requireVerifiedActorsForApproval: policy.requireVerifiedActorsForApproval,
      audit,
      actorClassification,
      minimumActorAssuranceForApproval,
      identityProvider: proven.identityProvider,
      identityProviderMode,
      selfReview: normalizeSelfReviewConfig(rawSelfReview),
      reviewOutputPolicy: policy.reviewOutputPolicy,
      reviewInvocationPolicy: policy.reviewInvocationPolicy,
      enforceRiskClassification: policy.enforceRiskClassification,
      allowRiskDowngradeOverride: policy.allowRiskDowngradeOverride,
      allowReducedCeremony: policy.allowReducedCeremony,
      discoveryHealth: policy.discoveryHealth,
      validationEvidence: policy.validationEvidence,
    },
    normalized: anyNormalized,
    reason: anyNormalized ? 'incomplete_snapshot_normalized' : undefined,
  };
}

/** Mode-consistent safe defaults derived from policy presets. */
const SOLO_DEFAULTS = {
  requireHumanGates: false as const,
  maxSelfReviewIterations: 2,
  maxImplReviewIterations: 1,
  allowSelfApproval: true as const,
  minimumActorAssuranceForApproval: 'best_effort' as const,
  effectiveGateBehavior: 'auto_approve' as const,
  reviewOutputPolicy: 'text_compat_allowed' as const,
  reviewInvocationPolicy: 'host_task_preferred' as const,
  enforceRiskClassification: false as const,
  allowRiskDowngradeOverride: false as const,
  allowReducedCeremony: false as const,
};

const REGULATED_DEFAULTS = {
  requireHumanGates: true as const,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: false as const,
  minimumActorAssuranceForApproval: 'claim_validated' as const,
  effectiveGateBehavior: 'human_gated' as const,
  reviewOutputPolicy: 'structured_required' as const,
  reviewInvocationPolicy: 'host_task_required' as const,
  enforceRiskClassification: true as const,
  allowRiskDowngradeOverride: false as const,
  allowReducedCeremony: false as const,
};

const TEAM_DEFAULTS = {
  requireHumanGates: true as const,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true as const,
  minimumActorAssuranceForApproval: 'best_effort' as const,
  effectiveGateBehavior: 'human_gated' as const,
  reviewOutputPolicy: 'text_compat_allowed' as const,
  reviewInvocationPolicy: 'host_task_required' as const,
  enforceRiskClassification: false as const,
  allowRiskDowngradeOverride: false as const,
  allowReducedCeremony: false as const,
};

const TEAM_CI_DEFAULTS = {
  requireHumanGates: true as const,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true as const,
  minimumActorAssuranceForApproval: 'best_effort' as const,
  effectiveGateBehavior: 'human_gated' as const,
  reviewOutputPolicy: 'structured_required' as const,
  reviewInvocationPolicy: 'host_task_required' as const,
  enforceRiskClassification: true as const,
  allowRiskDowngradeOverride: false as const,
  allowReducedCeremony: false as const,
};

/**
 * @internal Used by resolvePolicyFromSnapshot in policy-snapshot.ts.
 */
export function modeConsistentDefaults(mode: PolicyMode): {
  readonly requireHumanGates: boolean;
  readonly maxSelfReviewIterations: number;
  readonly maxImplReviewIterations: number;
  readonly allowSelfApproval: boolean;
  readonly minimumActorAssuranceForApproval: 'best_effort' | 'claim_validated' | 'idp_verified';
  readonly effectiveGateBehavior: EffectiveGateBehavior;
  readonly reviewOutputPolicy: ReviewOutputPolicy;
  readonly reviewInvocationPolicy: ReviewInvocationPolicy;
  readonly enforceRiskClassification: boolean;
  readonly allowRiskDowngradeOverride: boolean;
  readonly allowReducedCeremony: boolean;
  readonly discoveryHealth: DiscoveryHealthPolicy;
  readonly validationEvidence: ValidationEvidencePolicy;
} {
  const base =
    mode === 'solo'
      ? SOLO_DEFAULTS
      : mode === 'regulated'
        ? REGULATED_DEFAULTS
        : mode === 'team'
          ? TEAM_DEFAULTS
          : TEAM_CI_DEFAULTS;
  return {
    ...base,
    discoveryHealth: defaultDiscoveryHealthForMode(mode),
    validationEvidence: defaultValidationEvidenceForMode(mode),
  };
}
