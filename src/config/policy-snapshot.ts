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
  AuditPolicy,
  TimestampAssurancePolicy,
  PolicyMode,
  EffectiveGateBehavior,
  PolicyDegradedReason,
  PolicySource,
  PolicyResolutionReason,
  CentralMinimumMode,
  SelfReviewConfig,
  ReviewOutputPolicy,
  ReviewInvocationPolicy,
  HydratePolicyResolution,
} from './policy-types.js';
import type { PolicyResolution } from './policy-resolver.js';
import { DEFAULT_SELF_REVIEW_CONFIG } from './policy-types.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { PolicyConfigurationError } from './policy-errors.js';

/**
 * Normalize a legacy or weakened selfReview config to the mandatory strict default.
 *
 * FlowGuard requires subagent-enabled, no-fallback, strict-enforcement self-review.
 * Any deviation (legacy null, partial config, weakened flags) is normalized to the
 * canonical strict config with a console warning for operator visibility.
 */
function normalizeSelfReviewConfig(value: unknown): SelfReviewConfig {
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
      timestampAssurance: {
        enabled: policy.audit.timestampAssurance.enabled,
        mode: policy.audit.timestampAssurance.mode,
        strict: policy.audit.timestampAssurance.strict,
        criticalEvents: [...policy.audit.timestampAssurance.criticalEvents],
        ...(policy.audit.timestampAssurance.tsaUrl
          ? { tsaUrl: policy.audit.timestampAssurance.tsaUrl }
          : {}),
        ...(policy.audit.timestampAssurance.trustAnchors
          ? { trustAnchors: [...policy.audit.timestampAssurance.trustAnchors] }
          : {}),
        ...(policy.audit.timestampAssurance.ntpServers
          ? { ntpServers: [...policy.audit.timestampAssurance.ntpServers] }
          : {}),
        ntpDriftThresholdMs: policy.audit.timestampAssurance.ntpDriftThresholdMs,
        tsaTimeoutMs: policy.audit.timestampAssurance.tsaTimeoutMs,
      },
    },
    actorClassification: { ...policy.actorClassification },
    minimumActorAssuranceForApproval: policy.minimumActorAssuranceForApproval,
    ...(policy.identityProvider ? { identityProvider: policy.identityProvider } : {}),
    identityProviderMode: policy.identityProviderMode,
    ...(policy.selfReview ? { selfReview: policy.selfReview } : {}),
    reviewOutputPolicy: policy.reviewOutputPolicy,
    reviewInvocationPolicy: policy.reviewInvocationPolicy,
    enforceRiskClassification: policy.enforceRiskClassification,
    allowRiskDowngradeOverride: policy.allowRiskDowngradeOverride,
    allowReducedCeremony: policy.allowReducedCeremony,
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
  // null/undefined = "not configured" → safe default (team)
  if (raw === undefined || raw === null) return { value: 'team', normalized: true };
  // Any other value is an invalid mode — fail-closed, never silently degrade
  throw new PolicyConfigurationError(
    'INVALID_POLICY_MODE',
    `Invalid policy mode "${String(raw)}". Valid modes: solo, team, team-ci, regulated.`,
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

  const rawAllowSelf = s.allowSelfApproval;
  const allowSelfApproval =
    typeof rawAllowSelf === 'boolean' ? rawAllowSelf : defaults.allowSelfApproval;
  if (typeof rawAllowSelf !== 'boolean') norm = true;

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
  normalized: boolean;
} {
  let norm = false;

  const rawGate = s.effectiveGateBehavior;
  const effectiveGateBehavior = isValidGateBehavior(rawGate)
    ? rawGate
    : defaults.effectiveGateBehavior;
  if (!isValidGateBehavior(rawGate)) norm = true;

  const rawReqVerified = s.requireVerifiedActorsForApproval;
  const requireVerifiedActorsForApproval =
    typeof rawReqVerified === 'boolean' ? rawReqVerified : false;
  if (typeof rawReqVerified !== 'boolean') norm = true;

  const reviewPolicies = normalizeReviewPolicies(s, defaults);
  if (reviewPolicies.normalized) norm = true;

  const rawRiskEnforcement = s.enforceRiskClassification;
  const enforceRiskClassification =
    typeof rawRiskEnforcement === 'boolean'
      ? rawRiskEnforcement
      : defaults.enforceRiskClassification;
  if (typeof rawRiskEnforcement !== 'boolean') norm = true;

  const riskOverride = normalizeBooleanField(
    s.allowRiskDowngradeOverride,
    defaults.allowRiskDowngradeOverride,
  );
  const reducedCeremony = normalizeBooleanField(
    s.allowReducedCeremony,
    defaults.allowReducedCeremony,
  );
  norm = norm || riskOverride.normalized || reducedCeremony.normalized;

  return {
    effectiveGateBehavior,
    requireVerifiedActorsForApproval,
    reviewOutputPolicy: reviewPolicies.reviewOutputPolicy,
    reviewInvocationPolicy: reviewPolicies.reviewInvocationPolicy,
    enforceRiskClassification,
    allowRiskDowngradeOverride: riskOverride.value,
    allowReducedCeremony: reducedCeremony.value,
    normalized: norm,
  };
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
  if (!raw || typeof raw !== 'object') {
    return {
      value: {
        emitTransitions: true,
        emitToolCalls: true,
        enableChainHash: true,
        timestampAssurance: {
          enabled: false,
          mode: 'local_only',
          strict: false,
          criticalEvents: ['decision', 'lifecycle'],
          ntpServers: ['pool.ntp.org'],
          ntpDriftThresholdMs: 30000,
          tsaTimeoutMs: 10000,
        },
      },
      normalized: true,
    };
  }
  const emitTransitions = typeof raw.emitTransitions === 'boolean' ? raw.emitTransitions : true;
  const emitToolCalls = typeof raw.emitToolCalls === 'boolean' ? raw.emitToolCalls : true;
  const enableChainHash = typeof raw.enableChainHash === 'boolean' ? raw.enableChainHash : true;
  const rawTsa = raw.timestampAssurance as Record<string, unknown> | null | undefined;
  const timestampAssurance =
    rawTsa && typeof rawTsa === 'object'
      ? {
          enabled: typeof rawTsa.enabled === 'boolean' ? rawTsa.enabled : false,
          mode: isValidTsAMode(rawTsa.mode)
            ? (rawTsa.mode as 'local_only' | 'ntp_check' | 'tsa_critical')
            : 'local_only',
          strict: typeof rawTsa.strict === 'boolean' ? rawTsa.strict : false,
          criticalEvents: Array.isArray(rawTsa.criticalEvents)
            ? rawTsa.criticalEvents.filter((e): e is string => typeof e === 'string')
            : ['decision', 'lifecycle'],
          tsaUrl: typeof rawTsa.tsaUrl === 'string' ? rawTsa.tsaUrl : undefined,
          trustAnchors: Array.isArray(rawTsa.trustAnchors)
            ? rawTsa.trustAnchors.filter((a): a is string => typeof a === 'string')
            : undefined,
          ntpServers: Array.isArray(rawTsa.ntpServers)
            ? rawTsa.ntpServers.filter((s): s is string => typeof s === 'string')
            : ['pool.ntp.org'],
          ntpDriftThresholdMs:
            typeof rawTsa.ntpDriftThresholdMs === 'number' ? rawTsa.ntpDriftThresholdMs : 30000,
          tsaTimeoutMs: typeof rawTsa.tsaTimeoutMs === 'number' ? rawTsa.tsaTimeoutMs : 10000,
        }
      : {
          enabled: false,
          mode: 'local_only' as const,
          strict: false,
          criticalEvents: ['decision', 'lifecycle'],
          ntpServers: ['pool.ntp.org'],
          ntpDriftThresholdMs: 30000,
          tsaTimeoutMs: 10000,
        };
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
  return {
    requestedMode: typeof rawReqMode === 'string' ? rawReqMode : fallbackMode,
    reqModeNormalized: !isValidMode(rawReqMode),
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

/**
 * Normalize and return meta-information about what was changed.
 *
 * Composes private field normalizers into a single normalization pass.
 * Each normalizer validates its field and returns a value plus a flag.
 * The wrapper aggregates flags into the public `normalized` indicator.
 *
 * @param snapshot — Raw snapshot from session state.
 * @returns Normalized snapshot with normalization meta.
 */
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
    },
    normalized: anyNormalized,
    reason: anyNormalized ? 'incomplete_snapshot_normalized' : undefined,
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
  readonly reviewOutputPolicy: ReviewOutputPolicy;
  readonly reviewInvocationPolicy: ReviewInvocationPolicy;
  readonly enforceRiskClassification: boolean;
  readonly allowRiskDowngradeOverride: boolean;
  readonly allowReducedCeremony: boolean;
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
        reviewOutputPolicy: 'text_compat_allowed',
        reviewInvocationPolicy: 'host_task_preferred',
        enforceRiskClassification: false,
        allowRiskDowngradeOverride: false,
        allowReducedCeremony: false,
      };
    case 'regulated':
      return {
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: false,
        minimumActorAssuranceForApproval: 'claim_validated',
        effectiveGateBehavior: 'human_gated',
        reviewOutputPolicy: 'structured_required',
        reviewInvocationPolicy: 'host_task_required',
        enforceRiskClassification: true,
        allowRiskDowngradeOverride: false,
        allowReducedCeremony: false,
      };
    case 'team':
      return {
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        effectiveGateBehavior: 'human_gated',
        reviewOutputPolicy: 'text_compat_allowed',
        reviewInvocationPolicy: 'host_task_required',
        enforceRiskClassification: false,
        allowRiskDowngradeOverride: false,
        allowReducedCeremony: false,
      };
    case 'team-ci':
      return {
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        effectiveGateBehavior: 'human_gated',
        reviewOutputPolicy: 'structured_required',
        reviewInvocationPolicy: 'host_task_required',
        enforceRiskClassification: true,
        allowRiskDowngradeOverride: false,
        allowReducedCeremony: false,
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
    reviewOutputPolicy:
      snapshot.reviewOutputPolicy ??
      modeConsistentDefaults(snapshot.mode as PolicyMode).reviewOutputPolicy,
    reviewInvocationPolicy:
      snapshot.reviewInvocationPolicy ??
      modeConsistentDefaults(snapshot.mode as PolicyMode).reviewInvocationPolicy,
    minimumActorAssuranceForApproval:
      snapshot.minimumActorAssuranceForApproval ??
      (snapshot.requireVerifiedActorsForApproval
        ? 'claim_validated'
        : modeConsistentDefaults(snapshot.mode as PolicyMode).minimumActorAssuranceForApproval),
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
      modeConsistentDefaults(snapshot.mode as PolicyMode).enforceRiskClassification,
    allowRiskDowngradeOverride:
      snapshot.allowRiskDowngradeOverride ??
      modeConsistentDefaults(snapshot.mode as PolicyMode).allowRiskDowngradeOverride,
    allowReducedCeremony:
      snapshot.allowReducedCeremony ??
      modeConsistentDefaults(snapshot.mode as PolicyMode).allowReducedCeremony,
  };
}
