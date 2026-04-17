/**
 * @module review-decision
 * @description /review-decision rail — human verdict at a User Gate.
 *
 * WP5 Integration: Full decision flow with identity + role + risk + obligations
 *
 * Works at all three User Gate phases:
 * - PLAN_REVIEW:     approve → VALIDATION, changes → PLAN, reject → TICKET
 * - EVIDENCE_REVIEW: approve → COMPLETE, changes → IMPLEMENTATION, reject → TICKET
 * - ARCH_REVIEW:     approve → ARCH_COMPLETE, changes → ARCHITECTURE, reject → READY
 *
 * Four-eyes principle enforcement (regulated mode):
 * When policy.allowSelfApproval === false, the reviewer (decidedBy)
 * MUST be different from the session initiator (state.initiatedBy).
 * This satisfies MaRisk AT 7.2 (5) — separation of duties.
 *
 * WP5 Decision Flow:
 * 1. Validate identity (from context)
 * 2. Resolve role (from RBAC)
 * 3. Build risk context
 * 4. Evaluate risk rules
 * 5. Check obligations
 * 6. Allow/block decision
 * 7. Emit receipt v2
 *
 * State clearing patterns (FlowGuard-critical):
 *
 * | Gate            | Verdict            | Keep                    | Clear                                    |
 * |-----------------|--------------------|-------------------------|------------------------------------------|
 * | PLAN_REVIEW     | approve            | ticket, plan, selfReview| reviewDecision                           |
 * | PLAN_REVIEW     | changes_requested  | ticket, plan            | selfReview, reviewDecision               |
 * | PLAN_REVIEW     | reject             | ticket                  | plan, selfReview, validation, impl, ...  |
 * | EVIDENCE_REVIEW | approve            | everything              | (nothing — complete)                     |
 * | EVIDENCE_REVIEW | changes_requested  | ticket, plan, validation| impl, implReview, reviewDecision         |
 * | EVIDENCE_REVIEW | reject             | ticket                  | plan, selfReview, validation, impl, ...  |
 * | ARCH_REVIEW     | approve            | architecture, selfReview| (nothing — complete)                     |
 * | ARCH_REVIEW     | changes_requested  | architecture            | selfReview                               |
 * | ARCH_REVIEW     | reject             | (nothing)               | architecture, selfReview                 |
 *
 * @version v1
 */

import type { SessionState, Event } from '../state/schema';
import type {
  ReviewDecision,
  ReviewVerdict,
  ValidationResult,
  IdentityAssertion,
  ActorRole,
  AssuranceLevel,
  RiskPolicyObligations,
} from '../state/evidence';
import { Command, isCommandAllowed } from '../machine/commands';
import { evaluate, evaluateWithEvent } from '../machine/evaluate';
import type { RailResult, RailContext, TransitionRecord } from './types';
import { applyTransition } from './types';
import { blocked } from '../config/reasons';
import type { PolicyDecisionV2 } from '../state/evidence';
import type { FlowGuardConfig } from '../config/flowguard-config';
import { evaluateRiskPolicy, buildPolicyDecisionV2, type RiskEvaluationInput } from '../integration/risk';
import { evaluateApprovalConstraints, resolveActorRoles } from '../integration/rbac';

const ASSURANCE_RANK: Record<AssuranceLevel, number> = {
  none: 0,
  basic: 1,
  strong: 2,
};

// ─── Input ───────────────────────────────────────────────────────────────────

export interface ReviewDecisionInput {
  readonly verdict: ReviewVerdict;
  readonly rationale: string;
  readonly decidedBy: string;
  readonly identityAssertion?: IdentityAssertion;
  readonly actionType?: string;
  readonly dataClassification?: string;
  readonly targetEnvironment?: string;
  readonly systemOfRecord?: string;
  readonly changeWindow?: string;
  readonly exceptionPolicy?: string;
}

export interface ReviewDecisionContext {
  readonly config: FlowGuardConfig;
}

// ─── Verdict → Event mapping ──────────────────────────────────────────────────

const VERDICT_TO_EVENT: Record<ReviewVerdict, Event> = {
  approve: 'APPROVE',
  changes_requested: 'CHANGES_REQUESTED',
  reject: 'REJECT',
};

// ─── State Clearing ───────────────────────────────────────────────────────────

/**
 * State fields cleared on reject (from any gate).
 * Everything downstream of TICKET is wiped — plan must be rebuilt from scratch.
 */
const REJECT_CLEAR = {
  plan: null,
  selfReview: null,
  validation: [] as ValidationResult[],
  implementation: null,
  implReview: null,
};

/**
 * State fields cleared on reject at ARCH_REVIEW.
 * Architecture flow is wiped — user returns to READY to choose a new flow.
 */
const ARCH_REJECT_CLEAR = {
  architecture: null,
  selfReview: null,
};

/**
 * Apply state clearing pattern based on gate + verdict.
 *
 * Clearing rules (FlowGuard-critical):
 * - approve: keep everything (state flows forward)
 * - changes_requested at PLAN_REVIEW: clear selfReview (fresh review loop)
 * - changes_requested at EVIDENCE_REVIEW: clear impl + implReview (re-implement)
 * - changes_requested at ARCH_REVIEW: clear selfReview (fresh review loop)
 * - reject at PLAN_REVIEW/EVIDENCE_REVIEW: clear everything downstream of TICKET
 * - reject at ARCH_REVIEW: clear architecture + selfReview (back to READY)
 */
function applyStateClearingPattern(state: SessionState, verdict: ReviewVerdict): SessionState {
  if (verdict === 'approve') {
    // At ARCH_REVIEW, set architecture status to "accepted" on approval
    if (state.phase === 'ARCH_REVIEW' && state.architecture) {
      return { ...state, architecture: { ...state.architecture, status: 'accepted' } };
    }
    return state;
  }

  if (verdict === 'reject') {
    if (state.phase === 'ARCH_REVIEW') {
      return { ...state, ...ARCH_REJECT_CLEAR };
    }
    return { ...state, ...REJECT_CLEAR };
  }

  // changes_requested
  if (state.phase === 'PLAN_REVIEW') {
    return { ...state, selfReview: null };
  }
  if (state.phase === 'EVIDENCE_REVIEW') {
    return { ...state, implementation: null, implReview: null };
  }
  if (state.phase === 'ARCH_REVIEW') {
    return { ...state, selfReview: null };
  }

  return state;
}

// ─── Obligations Checking ─────────────────────────────────────────────────

function checkObligationsSatisfied(
  obligations: RiskPolicyObligations,
  state: SessionState,
  roles: ActorRole[],
  inputRationale: string,
): { satisfied: boolean; failedObligations: string[] } {
  const failed: string[] = [];

  // Check against input.rationale, not state.reviewDecision (not yet written)
  if (obligations.justificationRequired) {
    if (!inputRationale || inputRationale.trim().length < 10) {
      failed.push('justificationRequired');
    }
  }

  if (obligations.ticketRequired) {
    if (!state.ticket) {
      failed.push('ticketRequired');
    }
  }

  if (obligations.requiredApproverRole && obligations.requiredApproverRole.length > 0) {
    const hasRequired = obligations.requiredApproverRole.some((r) => roles.includes(r));
    if (!hasRequired) {
      failed.push('requiredApproverRole');
    }
  }

  return {
    satisfied: failed.length === 0,
    failedObligations: failed,
  };
}

function isAssuranceSufficient(
  actual: AssuranceLevel,
  min: 'basic' | 'strong',
): boolean {
  return ASSURANCE_RANK[actual] >= ASSURANCE_RANK[min];
}

// ─── Default Config for Backward Compatibility ─────────────────────────────────────

function getDefaultDecisionConfig(): FlowGuardConfig {
  // Default: catch-all allow rule for backward compatibility
  // 1.2.0 callers should provide their own config for proper governance
  // Allow all action types by using an empty match (matches everything)
  return {
    schemaVersion: 'v1',
    risk: {
      rules: [
        {
          id: 'default-allow',
          priority: 9999,
          match: {},  // Empty match = matches everything
          effect: 'allow',
        },
      ],
      noMatchDecision: 'deny',
    },
    rbac: { roleBindings: [], approvalConstraints: { dualControlRequiredModes: ['regulated'], requiredApproverRolesByMode: {} } },
    identity: { allowLocalFallbackModes: ['solo', 'team'], allowedIssuers: [] },
  } as unknown as FlowGuardConfig;
}

// ─── Main Rail ─────────────────────────────────────────────────────────────────────

export function executeReviewDecision(
  state: SessionState,
  input: ReviewDecisionInput,
  ctx: RailContext,
  reviewCtx?: ReviewDecisionContext,
): RailResult {
  // Default config for backward compatibility (tests, legacy callers)
  const cfg = reviewCtx?.config ?? getDefaultDecisionConfig();

  // Runtime validation of policy mode - fail-closed on unknown mode
  const validModes = ['solo', 'team', 'team-ci', 'regulated'] as const;
  const rawMode = state.policySnapshot.mode;
  if (!validModes.includes(rawMode as typeof validModes[number])) {
    return blocked('INVALID_POLICY_MODE', { mode: rawMode });
  }
  const requestedMode = rawMode as typeof validModes[number];

  const validGateBehaviors = ['auto_approve', 'human_gated'] as const;
  const rawGateBehavior = state.policySnapshot.effectiveGateBehavior;
  if (!validGateBehaviors.includes(rawGateBehavior as typeof validGateBehaviors[number])) {
    return blocked('INVALID_POLICY_MODE', { mode: `gate:${rawGateBehavior}` });
  }
  const effectiveGateBehavior = rawGateBehavior as typeof validGateBehaviors[number];

  // 1. Admissibility
  if (!isCommandAllowed(state.phase, Command.REVIEW_DECISION)) {
    return blocked('COMMAND_NOT_ALLOWED', {
      command: '/review-decision',
      phase: state.phase,
    });
  }

  // 2. Validate verdict
  const event = VERDICT_TO_EVENT[input.verdict];
  if (!event) {
    return blocked('INVALID_VERDICT', { verdict: String(input.verdict) });
  }

  // 3. Identity validation (WP2) - FAIL-CLOSED for regulated/high-risk
  const identity = input.identityAssertion;
  const isRegulated = requestedMode === 'regulated';

  // In regulated mode, identity assertion is REQUIRED
  if (isRegulated && !identity) {
    return blocked('IDENTITY_UNVERIFIED', {
      message: 'Identity assertion required for regulated mode decision',
    });
  }

  if (identity) {
    if (identity.assuranceLevel === 'none') {
      return blocked('IDENTITY_UNVERIFIED', {
        message: 'Identity assertion has no assurance level',
      });
    }

    // In regulated mode, issuer MUST be explicitly allowed (empty list = no trust = block)
    const allowedIssuers = cfg.identity?.allowedIssuers ?? [];
    if (isRegulated) {
      if (!identity.issuer || !allowedIssuers.includes(identity.issuer)) {
        return blocked('UNTRUSTED_IDENTITY_ISSUER', {
          message: `Issuer "${identity.issuer}" not in allowed list (empty or not found)`,
        });
      }
    }

    const allowLocalFallback = cfg.identity?.allowLocalFallbackModes ?? ['solo', 'team'];
    const localNotAllowed = !allowLocalFallback.includes(requestedMode) && identity.identitySource === 'local';
    if (localNotAllowed && identity.identitySource === 'local') {
      return blocked('IDENTITY_SOURCE_NOT_ALLOWED', {
        source: identity.identitySource,
        mode: requestedMode,
        message: 'Local identity not allowed in this mode',
      });
    }
  }

  // 4. Role resolution (WP3)
  let actorRoles: ActorRole[] = ['operator'];
  if (identity) {
    const rolesResult = resolveActorRoles(identity, cfg);
    actorRoles = rolesResult.roles;
  }

  // 5. Build risk context
  const riskInput: RiskEvaluationInput = {
    actionType: input.actionType ?? 'review',
    dataClassification: input.dataClassification,
    targetEnvironment: input.targetEnvironment,
    systemOfRecord: input.systemOfRecord,
    changeWindow: input.changeWindow,
    exceptionPolicy: input.exceptionPolicy,
  };

  // 6. Evaluate risk rules (WP4)
  const policyDecision = buildPolicyDecisionV2(
    riskInput,
    cfg,
    requestedMode,
    requestedMode,
    effectiveGateBehavior,
  );

  // Block on risk policy deny (including no-match = deny per 1.2.0 contract)
  if (policyDecision.outcome === 'deny') {
    return blocked(policyDecision.blockedReasonCode ?? 'RISK_POLICY_NO_MATCH', {
      action: riskInput.actionType,
      ruleId: policyDecision.matchedRuleId ?? 'none',
      reason: policyDecision.blockedReasonCode ?? 'Risk policy denied or no matching rule',
    });
  }

  // Check obligations from risk policy - FAIL-CLOSED
  const obligations = policyDecision.obligations;
  if (obligations && typeof obligations === 'object') {
    const oblocks = obligations as RiskPolicyObligations;
    if (oblocks.minAssuranceLevel) {
      // minAssuranceLevel required but no identity = block (fail-closed for high-risk)
      if (!identity) {
        return blocked('IDENTITY_UNVERIFIED', {
          message: 'Identity assertion required to satisfy minAssuranceLevel obligation',
        });
      }
      if (!isAssuranceSufficient(identity.assuranceLevel, oblocks.minAssuranceLevel)) {
        return blocked('ASSURANCE_LEVEL_TOO_LOW', {
          actual: identity.assuranceLevel,
          required: oblocks.minAssuranceLevel,
        });
      }
    }

    if (oblocks.ticketRequired && !state.ticket) {
      return blocked('CHANGE_TICKET_REQUIRED', {
        obligations: 'ticketRequired',
      });
    }

    // 4-eyes in regulated mode
    if (ctx.policy?.allowSelfApproval === false) {
      if (input.decidedBy === state.initiatedBy) {
        return blocked('SELF_APPROVAL_FORBIDDEN', {
          initiator: state.initiatedBy,
        });
      }
    }

    // Check obligations satisfaction (only if policy rule has obligations)
    if (Object.keys(oblocks).length > 0) {
      const inputRationale = input.rationale;
      const oblResult = checkObligationsSatisfied(oblocks, state, actorRoles, inputRationale);
      if (!oblResult.satisfied) {
        return blocked('OBLIGATIONS_NOT_SATISFIED', {
          obligations: oblResult.failedObligations.join(', '),
          status: 'not_satisfied',
        });
      }
    }

    // Check approval constraints ALWAYS - independent governance, not tied to obligations
    const constraintResult = evaluateApprovalConstraints({
      mode: requestedMode,
      initiatedBy: state.initiatedBy,
      decidedBy: input.decidedBy,
      actorRoles,
      config: cfg,
    });
    if (constraintResult) {
      return blocked(constraintResult.code, constraintResult.vars);
    }
  }

  // 7. Resolve target phase via topology
  const target = evaluateWithEvent(state.phase, event);
  if (target === undefined) {
    return blocked('INVALID_TRANSITION', {
      event: String(event),
      phase: state.phase,
    });
  }

  // 8. Create evidence
  const decision: ReviewDecision = {
    verdict: input.verdict,
    rationale: input.rationale,
    decidedAt: ctx.now(),
    decidedBy: input.decidedBy,
  };

  // 9. Apply state clearing pattern based on gate + verdict
  const clearedState = applyStateClearingPattern(
    { ...state, reviewDecision: decision },
    input.verdict,
  );

  // 10. Apply transition
  const at = ctx.now();
  const finalState = applyTransition(clearedState, state.phase, target, event, at);

  // Record the single transition for audit
  const transition: TransitionRecord = {
    from: state.phase,
    to: target,
    event,
    at,
  };

  // 11. Re-evaluate at new phase to get the eval result for the caller (policy-aware)
  const evalResult = evaluate(finalState, ctx.policy);

  // Build decision metadata for audit/receipt v2
  const outcome: 'approved' | 'blocked' = policyDecision.outcome === 'allow' ? 'approved' : 'blocked';
  const decisionMetadata = {
    matchedRuleId: policyDecision.matchedRuleId,
    obligationsResult: policyDecision.obligations as Record<string, unknown>,
    reasonCode: policyDecision.blockedReasonCode,
    outcome,
    identitySource: identity?.identitySource,
    assuranceLevel: identity?.assuranceLevel,
  } as const;

  return { kind: 'ok', state: finalState, evalResult, transitions: [transition], decisionMetadata };
}

