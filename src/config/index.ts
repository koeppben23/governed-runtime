/**
 * @module config
 * @description Barrel export for FlowGuard configuration modules.
 *
 * Three extension points:
 * 1. Profile — tech-stack-aware validation configuration
 * 2. Policy  — operating mode (solo / team / regulated)
 * 3. Reasons — structured error catalog with recovery guidance
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
} from "./profile";

// ── Policy ───────────────────────────────────────────────────────────────────
export {
  type AuditPolicy,
  type FlowGuardPolicy,
  SOLO_POLICY,
  TEAM_POLICY,
  REGULATED_POLICY,
  resolvePolicy,
  policyModes,
  createPolicySnapshot,
} from "./policy";

// ── Reasons ──────────────────────────────────────────────────────────────────
export {
  type BlockedCategory,
  type BlockedReason,
  type FormattedBlock,
  BlockedReasonRegistry,
  defaultReasonRegistry,
  blocked,
} from "./reasons";
