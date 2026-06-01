/**
 * @module config/policy-types
 * @description Core policy types and interfaces.
 *
 * Extracted from policy.ts.
 *
 * @version v1
 */

import type { IdpConfig, IdentityProviderMode } from '../identity/types.js';

// ─── Timestamp Assurance Policy ──────────────────────────────────────────────

/** Timestamp assurance evidence configuration for audit events. */
export interface TimestampAssurancePolicy {
  /** Enable timestamp assurance evidence (default: false). */
  readonly enabled: boolean;
  /** Assurance mode: local_only, ntp_check, or tsa_critical. */
  readonly mode: 'local_only' | 'ntp_check' | 'tsa_critical';
  /** Strict mode — TSA failure on critical events → session ERROR.
   *  Slice 1 (#269): always false. Inert. Will activate only in follow-up
   *  ticket when real TSA verifier (pkijs) is available. */
  readonly strict: boolean;
  /** Event kinds that require TSA evidence (e.g., decision, lifecycle). */
  readonly criticalEvents: ReadonlyArray<string>;
  /** TSA endpoint URL (required in tsa_critical mode). */
  readonly tsaUrl?: string;
  /** PEM-encodierte TSA trust anchor certificates (for Slice 2 verification). */
  readonly trustAnchors?: ReadonlyArray<string>;
  /** NTP server hostnames (default: pool.ntp.org). */
  readonly ntpServers?: ReadonlyArray<string>;
  /** Max clock drift before warning (ms, default: 30000). */
  readonly ntpDriftThresholdMs: number;
  /** TSA request timeout (ms, default: 10000). */
  readonly tsaTimeoutMs: number;
}

// ─── Audit Policy ─────────────────────────────────────────────────────────────

/** Controls which audit events are emitted and how. */
export interface AuditPolicy {
  /** Emit per-transition audit events (one per state change). */
  readonly emitTransitions: boolean;
  /** Emit per-tool-call audit events. */
  readonly emitToolCalls: boolean;
  /** Enable SHA-256 hash chain for tamper detection. */
  readonly enableChainHash: boolean;
  /** Timestamp assurance evidence configuration. */
  readonly timestampAssurance: TimestampAssurancePolicy;
}

/**
 * Mandatory independent review configuration.
 * Plan and implementation reviews must be performed by the flowguard-reviewer
 * subagent with mandate-bound evidence. Self-review fallback is not permitted.
 *
 * NOTE: These fields are retained for compatibility with existing snapshots.
 * In the current governance model, only the mandatory strict configuration
 * (subagentEnabled=true, fallbackToSelf=false, strictEnforcement=true) is valid.
 * Weaker values are normalized to the mandatory default at snapshot load time.
 * @see policy-snapshot.ts normalizeSelfReviewConfig
 */
export interface SelfReviewConfig {
  /** Legacy/compatibility field. Mandatory independent review is always enabled. */
  readonly subagentEnabled: boolean;
  /** Legacy/compatibility field. Self-review fallback is always prohibited. */
  readonly fallbackToSelf: boolean;
  /** Legacy/compatibility field. Strict enforcement is always required. */
  readonly strictEnforcement: boolean;
}

/** Controls which reviewer output modes may satisfy governance evidence. */
export type ReviewOutputPolicy = 'structured_required' | 'text_compat_allowed';

/** Controls how the reviewer is invoked — host-visible Task tool vs SDK vs fallback. */
export type ReviewInvocationPolicy = 'host_task_required' | 'host_task_preferred' | 'sdk_allowed';

/** Mandatory independent review configuration for FlowGuardPolicy. */
export const DEFAULT_SELF_REVIEW_CONFIG: SelfReviewConfig = {
  subagentEnabled: true,
  fallbackToSelf: false,
  strictEnforcement: true,
};

// ─── Discovery Health Policy ──────────────────────────────────────────────────

/** Master switch for policy-gated Discovery health enforcement. */
export type DiscoveryHealthEnforcement = 'off' | 'advisory' | 'required';

/**
 * Deterministic action for available-but-degraded or stale Discovery.
 * Degraded = failed/partial collectors, budget exhaustion, read failures, or stale ageWarning.
 */
export type DiscoveryHealthDegradedAction = 'allow' | 'warn' | 'block';

/** Deterministic action for non-clean Discovery drift verdicts. */
export type DiscoveryHealthDriftAction = 'allow' | 'warn' | 'block';

/**
 * Policy-gated Discovery health enforcement (#399).
 *
 * Two-axis governance:
 * - enforcement: master switch. 'off' = legacy advisory-only behavior (no new
 *   workflow blocks). 'advisory' = surface warnings/NOT_VERIFIED but never block.
 *   'required' = unavailable (missing/corrupt/schema_invalid/read_failed) ALWAYS
 *   blocks; degraded/drift follow onDegraded/onDrift.
 * - onDegraded: action when Discovery is available but degraded or stale.
 * - onDrift: action when the cached drift verdict is not 'clean' (drifted,
 *   missing_discovery, unavailable, timeout, not_checked — all fail-closed-eligible).
 *
 * Policy NEVER fabricates Discovery evidence; it only governs whether a workflow
 * may proceed with degraded/unavailable evidence. DiscoveryResult remains SSOT.
 */
export interface DiscoveryHealthPolicy {
  readonly enforcement: DiscoveryHealthEnforcement;
  readonly onDegraded: DiscoveryHealthDegradedAction;
  readonly onDrift: DiscoveryHealthDriftAction;
}

/**
 * Mode-keyed default Discovery health policy.
 *
 * regulated/team-ci fail closed (required); solo/team stay advisory-off so
 * existing default behavior introduces no new workflow blocks. This is the
 * single source of truth for the default, reused by presets, snapshot
 * normalization, and persisted-snapshot backward-compat resolution.
 */
export function defaultDiscoveryHealthForMode(mode: PolicyMode): DiscoveryHealthPolicy {
  if (mode === 'regulated' || mode === 'team-ci') {
    return { enforcement: 'required', onDegraded: 'warn', onDrift: 'block' };
  }
  return { enforcement: 'off', onDegraded: 'allow', onDrift: 'allow' };
}

// ─── Validation Evidence Policy ───────────────────────────────────────────────

/**
 * Master switch for policy-gated validation-evidence enforcement (#400).
 *
 * - 'off'      : legacy behavior. Empty activeChecks vacuously passes VALIDATION.
 * - 'advisory' : never blocks, but surfaces a NOT_VERIFIED warning when VALIDATION
 *                would pass with no verification evidence.
 * - 'required' : VALIDATION must NOT pass vacuously. Empty activeChecks blocks
 *                fail-closed unless an explicit policy-backed exception is set.
 */
export type ValidationEvidenceEnforcement = 'off' | 'advisory' | 'required';

/**
 * Policy-gated validation-evidence enforcement (#400).
 *
 * Prevents HIGH-RISK/regulated sessions from passing VALIDATION vacuously when no
 * Discovery-derived verification commands are available. Under 'required',
 * progression past VALIDATION demands at least one applicable active check OR an
 * explicit policy-backed exception (`allowNoCommands`).
 *
 * This policy NEVER fabricates verification evidence and NEVER permits arbitrary
 * fallback commands; command resolution stays candidate-only (verificationCandidates
 * remains the source of truth). It only governs whether a workflow may proceed
 * without runtime verification evidence.
 */
export interface ValidationEvidencePolicy {
  readonly enforcement: ValidationEvidenceEnforcement;
  /**
   * Explicit policy-backed exception: when true, a session with genuinely no
   * repo-native verification commands may still pass VALIDATION under 'required'.
   * This is the ONLY sanctioned opt-out; it is recorded in the policy snapshot.
   */
  readonly allowNoCommands: boolean;
}

/**
 * Mode-keyed default validation-evidence policy.
 *
 * regulated/team-ci fail closed ('required'); solo/team stay 'off' so existing
 * low-risk default behavior introduces no new workflow blocks. Single source of
 * truth for the default, reused by presets, snapshot normalization, and
 * persisted-snapshot backward-compat resolution.
 */
export function defaultValidationEvidenceForMode(mode: PolicyMode): ValidationEvidencePolicy {
  if (mode === 'regulated' || mode === 'team-ci') {
    return { enforcement: 'required', allowNoCommands: false };
  }
  return { enforcement: 'off', allowNoCommands: false };
}

// ─── FlowGuard Policy ─────────────────────────────────────────────────────────

/**
 * Full FlowGuard policy configuration.
 *
 * Determines:
 * - Whether human gates require explicit human decisions
 * - Max iterations for independent plan and implementation review loops
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

  /** Max independent review iterations in PLAN phase before force-convergence. */
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

  /** Independent review configuration. */
  readonly selfReview: SelfReviewConfig;

  /** Whether lower-assurance text-compatible review output may satisfy evidence. */
  readonly reviewOutputPolicy: ReviewOutputPolicy;

  /** How reviewer invocation must occur: host-visible Task tool, SDK, or policy-gated. */
  readonly reviewInvocationPolicy: ReviewInvocationPolicy;

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

  /** Enforce machine-checked task risk classification at runtime. */
  readonly enforceRiskClassification: boolean;

  /**
   * Allow runtime downgrade overrides below the computed minimum risk class.
   * Initial Issue #271 slice keeps all presets false; text justification alone
   * must not bypass the gate.
   */
  readonly allowRiskDowngradeOverride: boolean;

  /**
   * Permit reduced delivery ceremony only after runtime evidence proves a task is
   * low risk. This never lets claimedTaskClass decide flow depth by itself.
   */
  readonly allowReducedCeremony: boolean;

  /**
   * Policy-gated fail-closed Discovery health enforcement (#399).
   * Governs whether missing/corrupt/invalid/drifted/degraded Discovery blocks
   * mutating host tools. Never fabricates evidence; DiscoveryResult stays SSOT.
   */
  readonly discoveryHealth: DiscoveryHealthPolicy;

  /**
   * Policy-gated fail-closed validation-evidence enforcement (#400).
   * Governs whether VALIDATION may pass with no Discovery-derived verification
   * commands. Never fabricates evidence; verificationCandidates stays SSOT.
   */
  readonly validationEvidence: ValidationEvidencePolicy;
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
