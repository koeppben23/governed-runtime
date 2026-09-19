/**
 * @module config/policy-presets
 * @description Canonical FlowGuard policy presets and preset lookup.
 */

import type { FlowGuardPolicy, PolicyMode, TimestampAssurancePolicy } from './policy-types.js';
import {
  DEFAULT_MAX_REVIEWER_ATTEMPTS,
  CHALLENGE_POLICY_V1,
  defaultDiscoveryHealthForMode,
  defaultValidationEvidenceForMode,
} from './policy-types.js';
import { POLICY_MODES, isPolicyMode } from '../state/policy-mode.js';
import { PolicyConfigurationError } from './policy-errors.js';

const DEFAULT_TIMESTAMP_ASSURANCE: TimestampAssurancePolicy = {
  enabled: false,
  mode: 'local_only',
  strict: false,
  criticalEvents: ['decision', 'lifecycle'],
  ntpServers: ['pool.ntp.org'],
  ntpDriftThresholdMs: 30000,
  tsaTimeoutMs: 10000,
};

/** SOLO mode -- single developer, minimal ceremony. */
export const SOLO_POLICY: FlowGuardPolicy = {
  mode: 'solo',
  requireHumanGates: false,
  reviewBudget: { plan: 3, architecture: 3, implementation: 3 },
  maxIncoherentReviewerCaptureRetries: 1,
  maxReviewerAttempts: DEFAULT_MAX_REVIEWER_ATTEMPTS,
  allowSelfApproval: true,
  reviewProfile: 'core',
  challengePolicy: CHALLENGE_POLICY_V1,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: false,
    timestampAssurance: DEFAULT_TIMESTAMP_ASSURANCE,
  },
  actorClassification: {
    flowguard_decision: 'system',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  identityProviderMode: 'optional',
  enforceRiskClassification: false,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
  discoveryHealth: defaultDiscoveryHealthForMode('solo'),
  validationEvidence: defaultValidationEvidenceForMode('solo'),
};

/** TEAM mode -- collaborative workflow. */
export const TEAM_POLICY: FlowGuardPolicy = {
  mode: 'team',
  requireHumanGates: true,
  reviewBudget: { plan: 3, architecture: 3, implementation: 3 },
  maxIncoherentReviewerCaptureRetries: 1,
  maxReviewerAttempts: DEFAULT_MAX_REVIEWER_ATTEMPTS,
  allowSelfApproval: true,
  reviewProfile: 'core',
  challengePolicy: CHALLENGE_POLICY_V1,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
    timestampAssurance: DEFAULT_TIMESTAMP_ASSURANCE,
  },
  actorClassification: {
    flowguard_decision: 'human',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  identityProviderMode: 'optional',
  enforceRiskClassification: false,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
  discoveryHealth: defaultDiscoveryHealthForMode('team'),
  validationEvidence: defaultValidationEvidenceForMode('team'),
};

/** TEAM-CI mode -- CI pipeline workflow. */
export const TEAM_CI_POLICY: FlowGuardPolicy = {
  mode: 'team-ci',
  requireHumanGates: false,
  reviewBudget: { plan: 3, architecture: 3, implementation: 3 },
  maxIncoherentReviewerCaptureRetries: 1,
  maxReviewerAttempts: DEFAULT_MAX_REVIEWER_ATTEMPTS,
  allowSelfApproval: true,
  reviewProfile: 'core',
  challengePolicy: CHALLENGE_POLICY_V1,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
    timestampAssurance: DEFAULT_TIMESTAMP_ASSURANCE,
  },
  actorClassification: {
    flowguard_decision: 'system',
  },
  minimumActorAssuranceForApproval: 'best_effort',
  identityProviderMode: 'optional',
  enforceRiskClassification: true,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
  discoveryHealth: defaultDiscoveryHealthForMode('team-ci'),
  validationEvidence: defaultValidationEvidenceForMode('team-ci'),
};

/** REGULATED mode -- full FlowGuard with four-eyes and complete audit trail. */
export const REGULATED_POLICY: FlowGuardPolicy = {
  mode: 'regulated',
  requireHumanGates: true,
  reviewBudget: { plan: 3, architecture: 3, implementation: 3 },
  maxIncoherentReviewerCaptureRetries: 1,
  maxReviewerAttempts: DEFAULT_MAX_REVIEWER_ATTEMPTS,
  allowSelfApproval: false,
  reviewProfile: 'core',
  challengePolicy: CHALLENGE_POLICY_V1,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
    timestampAssurance: DEFAULT_TIMESTAMP_ASSURANCE,
  },
  actorClassification: {
    flowguard_decision: 'human',
    flowguard_abort_session: 'human',
  },
  minimumActorAssuranceForApproval: 'claim_validated',
  identityProviderMode: 'optional',
  enforceRiskClassification: true,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
  discoveryHealth: defaultDiscoveryHealthForMode('regulated'),
  validationEvidence: defaultValidationEvidenceForMode('regulated'),
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
  if (isPolicyMode(mode)) {
    return mode;
  }
  throw new PolicyConfigurationError(
    'INVALID_POLICY_MODE',
    `Unsupported policy mode: '${mode}'. Valid modes: ${POLICY_MODES.join(', ')}`,
    { received: mode, allowed: POLICY_MODES },
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
