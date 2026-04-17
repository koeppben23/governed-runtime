/**
 * @module integration/risk
 * @description Risk policy matrix evaluation engine.
 */

import type { PolicyMode, PolicyDecisionV2, RiskPolicyRule, RiskPolicyMatch, RiskPolicyObligations } from '../state/evidence';
import type { FlowGuardConfig } from '../config/flowguard-config';

export interface RiskEvaluationInput {
  actionType: string;
  dataClassification?: string;
  targetEnvironment?: string;
  systemOfRecord?: string;
  changeWindow?: string;
  exceptionPolicy?: string;
}

function matchesCriteria(
  input: RiskEvaluationInput,
  match: RiskPolicyMatch,
): boolean {
  if (match.actionType && match.actionType.length > 0) {
    if (!match.actionType.includes(input.actionType)) {
      return false;
    }
  }

  if (match.dataClassification && match.dataClassification.length > 0) {
    if (!input.dataClassification) {
      return false;
    }
    const ok = match.dataClassification as unknown as string[];
    if (!ok.includes(input.dataClassification)) {
      return false;
    }
  }

  if (match.targetEnvironment && match.targetEnvironment.length > 0) {
    if (!input.targetEnvironment) {
      return false;
    }
    const ok = match.targetEnvironment as unknown as string[];
    if (!ok.includes(input.targetEnvironment)) {
      return false;
    }
  }

  if (match.systemOfRecord && match.systemOfRecord.length > 0) {
    if (!input.systemOfRecord || !match.systemOfRecord.includes(input.systemOfRecord)) {
      return false;
    }
  }

  if (match.changeWindow && match.changeWindow.length > 0) {
    if (!input.changeWindow || !match.changeWindow.includes(input.changeWindow)) {
      return false;
    }
  }

  if (match.exceptionPolicy && match.exceptionPolicy.length > 0) {
    if (!input.exceptionPolicy || !match.exceptionPolicy.includes(input.exceptionPolicy)) {
      return false;
    }
  }

  return true;
}

export interface RiskPolicyResult {
  outcome: 'allow' | 'allow_with_approval' | 'deny';
  matchedRuleId: string | null;
  obligations: RiskPolicyObligations;
  blockedReasonCode?: string;
}

export function evaluateRiskPolicy(
  input: RiskEvaluationInput,
  config: FlowGuardConfig,
  _requestedMode: PolicyMode,
  _effectiveMode: PolicyMode,
): RiskPolicyResult {
  const rules = config.risk?.rules ?? [];

  const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    if (matchesCriteria(input, rule.match)) {
      return {
        outcome: rule.effect,
        matchedRuleId: rule.id,
        obligations: rule.obligations ?? {},
        blockedReasonCode: rule.effect === 'deny' ? 'RISK_POLICY_DENIED' : undefined,
      };
    }
  }

  // 1.2.0 contract: noMatch decision always deny (no silent fallback to allow)
  return {
    outcome: 'deny',
    matchedRuleId: null,
    obligations: {},
    blockedReasonCode: 'RISK_POLICY_NO_MATCH',
  };
}

export function buildPolicyDecisionV2(
  input: RiskEvaluationInput,
  config: FlowGuardConfig,
  requestedMode: PolicyMode,
  effectiveMode: PolicyMode,
  effectiveGateBehavior: 'auto_approve' | 'human_gated',
): PolicyDecisionV2 {
  const riskResult = evaluateRiskPolicy(input, config, requestedMode, effectiveMode);

  let gateBehavior = effectiveGateBehavior;

  if (riskResult.outcome === 'allow_with_approval') {
    gateBehavior = 'human_gated';
  }

  return {
    requestedMode,
    effectiveMode,
    effectiveGateBehavior: gateBehavior,
    matchedRuleId: riskResult.matchedRuleId,
    obligations: riskResult.obligations,
    outcome: riskResult.outcome,
    blockedReasonCode: riskResult.blockedReasonCode,
  };
}