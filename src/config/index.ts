/**
 * @module config
 * @description Barrel export for FlowGuard configuration modules.
 *
 * Four extension points:
 * 1. Profile — tech-stack-aware validation configuration
 * 2. Policy  — operating mode (solo / team / regulated)
 * 3. Reasons — structured error catalog with recovery guidance
 * 4. Config  — per-worktree FlowGuard configuration schema and defaults
 *
 * @version v1
 */

// ── Profile ──────────────────────────────────────────────────────────────────
export {
  type RepoSignals,
  type CheckExecutor,
  type FlowGuardProfile,
  ProfileRegistry,
  baselineProfile,
  javaProfile,
  angularProfile,
  typescriptProfile,
  defaultProfileRegistry,
} from './profile.js';

// ── Policy ───────────────────────────────────────────────────────────────────
export {
  type AuditPolicy,
  type FlowGuardPolicy,
  type PolicySource,
  type CentralMinimumMode,
  type PolicyResolutionReason,
  type HydratePolicyResolution,
  type CentralPolicyEvidence,
  PolicyConfigurationError,
  SOLO_POLICY,
  TEAM_POLICY,
  REGULATED_POLICY,
  getPolicyPreset,
  resolvePolicy,
  resolvePolicyForHydrate,
  resolveRuntimePolicyMode,
  loadCentralPolicyEvidence,
  validateExistingPolicyAgainstCentral,
  policyModes,
} from './policy.js';

export {
  createPolicySnapshot,
  freezePolicySnapshot,
  normalizePolicySnapshot,
  normalizePolicySnapshotWithMeta,
  resolvePolicyFromSnapshot,
  policyFromSnapshot,
} from './policy-snapshot.js';

// ── Reasons ──────────────────────────────────────────────────────────────────
export {
  type BlockedCategory,
  type BlockedReason,
  type FormattedBlock,
  BlockedReasonRegistry,
  defaultReasonRegistry,
  blocked,
} from './reasons.js';

// ── Config ───────────────────────────────────────────────────────────────────
export {
  FlowGuardConfigSchema,
  type FlowGuardConfig,
  type LogLevel,
  DEFAULT_CONFIG,
} from './flowguard-config.js';
