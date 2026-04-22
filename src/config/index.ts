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
} from './profile';

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
  loadCentralPolicyEvidence,
  validateExistingPolicyAgainstCentral,
  policyModes,
  createPolicySnapshot,
} from './policy';

// ── Reasons ──────────────────────────────────────────────────────────────────
export {
  type BlockedCategory,
  type BlockedReason,
  type FormattedBlock,
  BlockedReasonRegistry,
  defaultReasonRegistry,
  blocked,
} from './reasons';

// ── Config ───────────────────────────────────────────────────────────────────
export {
  FlowGuardConfigSchema,
  type FlowGuardConfig,
  type LogLevel,
  DEFAULT_CONFIG,
} from './flowguard-config';
