/**
 * @module config/policy-presets
 * @description Canonical FlowGuard policy presets and preset lookup.
 */

import type { FlowGuardPolicy, PolicyMode } from './policy-types.js';
import { DEFAULT_SELF_REVIEW_CONFIG } from './policy-types.js';
import { PolicyConfigurationError } from './policy-errors.js';

/** SOLO mode -- single developer, minimal ceremony. */
export const SOLO_POLICY: FlowGuardPolicy = {
  mode: 'solo',
  requireHumanGates: false,
  maxSelfReviewIterations: 2,
  maxImplReviewIterations: 1,
  allowSelfApproval: true,
  selfReview: DEFAULT_SELF_REVIEW_CONFIG,
  reviewOutputPolicy: 'text_compat_allowed',
  reviewInvocationPolicy: 'host_task_preferred',
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: false,
  },
  actorClassification: {
    flowguard_decision: 'system',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
  enforceRiskClassification: false,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
};

/** TEAM mode -- collaborative workflow. */
export const TEAM_POLICY: FlowGuardPolicy = {
  mode: 'team',
  requireHumanGates: true,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true,
  selfReview: DEFAULT_SELF_REVIEW_CONFIG,
  reviewOutputPolicy: 'text_compat_allowed',
  reviewInvocationPolicy: 'host_task_required',
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
  },
  actorClassification: {
    flowguard_decision: 'human',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
  enforceRiskClassification: false,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
};

/** TEAM-CI mode -- CI pipeline workflow. */
export const TEAM_CI_POLICY: FlowGuardPolicy = {
  mode: 'team-ci',
  requireHumanGates: false,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true,
  selfReview: DEFAULT_SELF_REVIEW_CONFIG,
  reviewOutputPolicy: 'structured_required',
  reviewInvocationPolicy: 'host_task_required',
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
  },
  actorClassification: {
    flowguard_decision: 'system',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
  enforceRiskClassification: true,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
};

/** REGULATED mode -- full FlowGuard with four-eyes and complete audit trail. */
export const REGULATED_POLICY: FlowGuardPolicy = {
  mode: 'regulated',
  requireHumanGates: true,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: false,
  selfReview: DEFAULT_SELF_REVIEW_CONFIG,
  reviewOutputPolicy: 'structured_required',
  reviewInvocationPolicy: 'host_task_required',
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
  },
  actorClassification: {
    flowguard_decision: 'human',
    flowguard_abort_session: 'human',
  },
  minimumActorAssuranceForApproval: 'claim_validated',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
  enforceRiskClassification: true,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
};

/** All known policy presets, indexed by mode. */
const POLICIES: Readonly<Record<PolicyMode, FlowGuardPolicy>> = {
  solo: SOLO_POLICY,
  team: TEAM_POLICY,
  'team-ci': TEAM_CI_POLICY,
  regulated: REGULATED_POLICY,
};

/** Validate and normalize a policy mode string. */
export function normalizePolicyMode(mode: string): PolicyMode {
  if (mode === 'solo' || mode === 'team' || mode === 'team-ci' || mode === 'regulated') {
    return mode;
  }
  throw new PolicyConfigurationError(
    'INVALID_POLICY_MODE',
    `Unsupported policy mode: '${mode}'. Valid modes: solo, team, team-ci, regulated`,
  );
}

/** Resolve a FlowGuard policy preset by mode name. */
export function getPolicyPreset(mode: string): FlowGuardPolicy {
  return POLICIES[normalizePolicyMode(mode)];
}

/** All known policy mode names. */
export function policyModes(): string[] {
  return Object.keys(POLICIES);
}
