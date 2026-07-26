/**
 * @module config/policy
 * @description Stable policy public facade.
 *
 * Implementation lives in focused policy-* modules. Keep this file as the
 * compatibility entry point for existing imports from `config/policy.js`.
 */

export type {
  AuditPolicy,
  TimestampAssurancePolicy,
  SelfReviewConfig,
  FlowGuardPolicy,
  PolicyMode,
  EffectiveGateBehavior,
  PolicyDegradedReason,
  PolicySource,
  CentralMinimumMode,
  CentralPolicyBundle,
  CentralPolicyEvidence,
  HydratePolicyResolution,
  PolicyResolutionReason,
  ReviewOutputPolicy,
  ReviewInvocationPolicy,
  DiscoveryHealthPolicy,
  DiscoveryHealthEnforcement,
  DiscoveryHealthDegradedAction,
  DiscoveryHealthDriftAction,
  ValidationEvidencePolicy,
  ValidationEvidenceEnforcement,
  ChallengePolicy,
  ChallengeKind,
} from './policy-types.js';
export {
  DEFAULT_SELF_REVIEW_CONFIG,
  CHALLENGE_POLICY_V1,
  CHALLENGE_POLICY_VERSION,
  challengeKindForObligation,
  defaultDiscoveryHealthForMode,
  defaultValidationEvidenceForMode,
} from './policy-types.js';

export { PolicyConfigurationError } from './policy-errors.js';
export type { PolicyConfigurationErrorCode } from './policy-errors.js';

export {
  SOLO_POLICY,
  TEAM_POLICY,
  TEAM_CI_POLICY,
  REGULATED_POLICY,
  getPolicyPreset,
  policyModes,
} from './policy-presets.js';

export { detectCiContext } from './policy-ci.js';

export {
  loadCentralPolicyEvidence,
  validateExistingPolicyAgainstCentral,
} from './policy-central.js';

export {
  resolvePolicyForHydrate,
  resolvePolicyWithContext,
  resolveRuntimePolicyMode,
} from './policy-resolver.js';
export type { HydratePolicyOptions, PolicyResolution } from './policy-resolver.js';

export {
  createPolicySnapshot,
  freezePolicySnapshot,
  resolvePolicyFromSnapshot,
} from './policy-snapshot.js';
export { normalizePolicySnapshot } from './policy-snapshot-normalize.js';
