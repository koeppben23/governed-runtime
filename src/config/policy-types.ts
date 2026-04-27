/**
 * @module config/policy-types
 * @description Core policy types, interfaces, and error classes.
 *
 * Extracted from policy.ts (P2f split).
 *
 * @version v1
 */

import type { IdpConfig, IdentityProviderMode } from '../identity/types.js';

// ─── Audit Policy ─────────────────────────────────────────────────────────────

/** Controls which audit events are emitted and how. */
export interface AuditPolicy {
  /** Emit per-transition audit events (one per state change). */
  readonly emitTransitions: boolean;
  /** Emit per-tool-call audit events. */
  readonly emitToolCalls: boolean;
  /** Enable SHA-256 hash chain for tamper detection. */
  readonly enableChainHash: boolean;
}

/**
 * Independent self-review configuration.
 * Controls whether a subagent performs independent review.
 */
export interface SelfReviewConfig {
  /** Enable subagent-based independent review for plan/implement phases. */
  readonly subagentEnabled: boolean;
  /** Fallback to self-review (agent reviews own work) on subagent timeout/failure. */
  readonly fallbackToSelf: boolean;
  /** Strict assurance mode: fail closed unless mandate-bound subagent evidence exists. */
  readonly strictEnforcement: boolean;
}

/** Self-review configuration for FlowGuardPolicy interface. */
export const DEFAULT_SELF_REVIEW_CONFIG: SelfReviewConfig = {
  subagentEnabled: false,
  fallbackToSelf: false,
  strictEnforcement: false,
};

// ─── FlowGuard Policy ─────────────────────────────────────────────────────────

/**
 * Full FlowGuard policy configuration.
 *
 * Determines:
 * - Whether human gates require explicit human decisions
 * - Max iterations for self-review and impl-review loops
 * - Whether the session initiator can approve their own work (four-eyes)
 * - Which audit events are emitted and how
 * - How actors are classified in the audit trail
 */
export interface FlowGuardPolicy {
  /** Policy mode identifier. */
  readonly mode: PolicyMode;

  /**
   * Whether User Gate phases require explicit human decisions.
   * false → auto-approve at gates (solo mode).
   * true → machine waits for /review-decision (team/regulated).
   */
  readonly requireHumanGates: boolean;

  /** Max self-review iterations in PLAN phase before force-convergence. */
  readonly maxSelfReviewIterations: number;

  /** Max impl-review iterations in IMPL_REVIEW phase before force-convergence. */
  readonly maxImplReviewIterations: number;

  /**
   * Whether the session initiator can approve at User Gates.
   * false → four-eyes principle enforced (regulated).
   *         Session initiator !== review decision maker.
   * true  → self-approval allowed (solo/team).
   */
  readonly allowSelfApproval: boolean;

  /** Independent self-review configuration. */
  readonly selfReview: SelfReviewConfig;

  /** Audit event emission controls. */
  readonly audit: AuditPolicy;

  /**
   * Actor classification per tool name.
   * Maps FlowGuard tool names to actor labels for the audit trail.
   * Tools not listed default to "system".
   */
  readonly actorClassification: Readonly<Record<string, string>>;

  /**
   * P34: Minimum required actor assurance for regulated approval decisions.
   *
   * - 'best_effort'     → any actor may approve (default, backward-compat with P33 v0)
   * - 'claim_validated' → only actors with validated local claims may approve
   * - 'idp_verified'    → only IdP-verified actors may approve (future P35 enterprise target)
   *
   * Applies at User Gates in regulated mode. Actors below the threshold are blocked
   * with reason ACTOR_ASSURANCE_INSUFFICIENT.
   *
   * Migration from P33 v0:
   *   requireVerifiedActorsForApproval: true  → minimumActorAssuranceForApproval: 'claim_validated'
   *   requireVerifiedActorsForApproval: false → minimumActorAssuranceForApproval: 'best_effort'
   *
   * P34 design doc: docs/actor-assurance-architecture.md
   */
  readonly minimumActorAssuranceForApproval: 'best_effort' | 'claim_validated' | 'idp_verified';

  /**
   * P33 (deprecated): Whether regulated approvals require verified actor identity.
   * Ignored if minimumActorAssuranceForApproval is set.
   * Translated to minimumActorAssuranceForApproval at resolution time:
   *   true  → 'claim_validated'
   *   false → 'best_effort'
   */
  readonly requireVerifiedActorsForApproval: boolean;

  /**
   * P35a/P35b1/P35b2: IdP configuration for static keys or JWKS authority.
   * Defines issuer, audience, claim mapping, and key source details.
   * When set, allows idp_verified actors via FLOWGUARD_ACTOR_TOKEN_PATH.
   */
  readonly identityProvider?: IdpConfig;

  /**
   * P35a: Controls IdP verification behavior when identityProvider is set.
   * - 'optional': Token verification is attempted but failure doesn't block hydration
   * - 'required': IdP verification must succeed at hydration time
   *
   * Note: Approval gates respect minimumActorAssuranceForApproval regardless of this mode.
   * This mode only controls whether IdP failure blocks session creation.
   */
  readonly identityProviderMode: IdentityProviderMode;
}

/** Supported policy modes. */
export type PolicyMode = 'solo' | 'team' | 'team-ci' | 'regulated';

/** Effective gate behavior after policy resolution. */
export type EffectiveGateBehavior = 'auto_approve' | 'human_gated';

/** Why policy mode was degraded. */
export type PolicyDegradedReason = 'ci_context_missing';

/** Policy source used for hydrate-time authority resolution. */
export type PolicySource = 'explicit' | 'central' | 'repo' | 'default';

/** Central policy minimum modes (team-ci is intentionally excluded). */
export type CentralMinimumMode = 'solo' | 'team' | 'regulated';

/** Why a policy source was selected or overridden. */
export type PolicyResolutionReason =
  | 'repo_weaker_than_central'
  | 'default_weaker_than_central'
  | 'explicit_stronger_than_central';

/** Central policy bundle schema (P29 local distribution model). */
export interface CentralPolicyBundle {
  readonly schemaVersion: 'v1';
  readonly minimumMode: CentralMinimumMode;
  readonly policyId?: string;
  readonly version?: string;
}

/** Provenance/evidence for a resolved central policy bundle. */
export interface CentralPolicyEvidence {
  readonly minimumMode: CentralMinimumMode;
  readonly digest: string;
  readonly version?: string;
  readonly pathHint: string;
}

/** Hydrate policy authority resolution result (P29). */
export interface HydratePolicyResolution {
  readonly requestedMode: PolicyMode;
  readonly requestedSource: Exclude<PolicySource, 'central'>;
  readonly effectiveMode: PolicyMode;
  readonly effectiveSource: PolicySource;
  readonly effectiveGateBehavior: EffectiveGateBehavior;
  readonly degradedReason?: PolicyDegradedReason;
  readonly policy: FlowGuardPolicy;
  readonly resolutionReason?: PolicyResolutionReason;
  readonly centralEvidence?: CentralPolicyEvidence;
}
