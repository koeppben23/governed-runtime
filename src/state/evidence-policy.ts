/**
 * @module evidence-policy
 * @description Immutable policy snapshot embedded in SessionState.
 *
 * @version v1
 */

import { z } from 'zod';
import { IdpConfigSchema } from './policy-idp-config.js';
import { PolicyModeSchema, CentralMinimumModeSchema, type PolicyMode } from './policy-mode.js';

/**
 * Modes that enable risk-classification, Discovery-health, and validation-evidence
 * enforcement by default when a (legacy) snapshot omits the explicit field.
 *
 * Centralized, typed predicate so the enforcement default is decided in one place
 * instead of scattered string comparisons. `mode` is a typed {@link PolicyMode},
 * so a near-miss literal would be a compile-time error rather than a silent miss.
 */
function defaultsToEnforcement(mode: PolicyMode): boolean {
  return mode === 'regulated' || mode === 'team-ci';
}

/**
 * Immutable policy snapshot embedded in SessionState.
 *
 * Stores all FlowGuard-critical fields so auditors can verify which rules
 * governed a session — even after policy presets are updated.
 *
 * The hash is SHA-256 of the canonical JSON of the full GovernancePolicy.
 * It supports integrity comparison against a trusted reference; it does not
 * independently prove authenticity or non-repudiation.
 *
 * Lives in state layer (not config) because it is part of SessionState —
 * the innermost layer must not depend on outer layers.
 */
export const PolicySnapshotSchema = z
  .object({
    /**
     * The effective policy mode at session creation time.
     * This is the result of resolvePolicyWithContext(requestedMode) —
     * may differ from requestedMode when team-ci degrades without CI.
     * Use requestedMode to see what was originally requested.
     */
    mode: PolicyModeSchema,
    /** SHA-256 hash of the canonical JSON of the full GovernancePolicy. */
    hash: z.string(),
    /** When the policy was resolved and frozen. */
    resolvedAt: z.string().datetime(),
    /** Original requested policy mode at hydrate time. */
    requestedMode: PolicyModeSchema,
    /** Applied policy source (P29): explicit, central, repo, or default. */
    source: z.enum(['explicit', 'central', 'repo', 'default']).optional(),
    /** Effective gate behavior after mode resolution. */
    effectiveGateBehavior: z.enum(['auto_approve', 'human_gated']),
    /** Why requested mode was degraded (if applicable). */
    degradedReason: z.string().optional(),
    /** Why source precedence selected/overrode a mode (P29). */
    resolutionReason: z.string().optional(),
    /** Central minimum mode that constrained resolution (P29). */
    centralMinimumMode: CentralMinimumModeSchema.optional(),
    /** Digest of the central policy bundle used at hydrate time (P29). */
    policyDigest: z.string().optional(),
    /** Version string from central policy bundle (P29). */
    policyVersion: z.string().optional(),
    /** Redacted policy path hint from central policy bundle (P29). */
    policyPathHint: z.string().optional(),

    // ── Governance-critical fields (frozen copy) ───────────────
    requireHumanGates: z.boolean(),
    maxSelfReviewIterations: z.number().int().positive(),
    maxImplReviewIterations: z.number().int().positive(),
    /** Frozen retry budget for F12-incoherent reviewer captures. */
    maxIncoherentReviewerCaptureRetries: z.number().int().nonnegative().optional(),
    /**
     * Frozen obligation-level reviewer output-repair budget. Optional in the
     * snapshot schema (pre-existing normalization fills legacy snapshots) —
     * REQUIRED once frozen onto a ReviewObligation, where the reissue gate
     * reads it.
     */
    maxReviewerOutputRepairAttempts: z.number().int().min(0).max(5).optional(),
    allowSelfApproval: z.boolean(),
    /**
     * P34: Minimum required actor assurance for regulated approval decisions.
     * Newer field added alongside requireVerifiedActorsForApproval.
     *
     * Resolution precedence (see verifyAssuranceThreshold in
     * src/rails/review-decision.ts):
     *   1. requireVerifiedActorsForApproval (P33, legacy) — if `true`, the
     *      approver must be at assurance `claim_validated` or higher and this
     *      field is the gate; minimumActorAssuranceForApproval is then ignored.
     *   2. minimumActorAssuranceForApproval (P34, current) — used only when
     *      requireVerifiedActorsForApproval is `false`/unset.
     *
     * Operators relaxing requireVerifiedActorsForApproval=true by setting
     * minimumActorAssuranceForApproval to a lower tier MUST also flip
     * requireVerifiedActorsForApproval to `false`, otherwise the stricter
     * legacy gate keeps winning.
     */
    minimumActorAssuranceForApproval: z
      .enum(['best_effort', 'claim_validated', 'idp_verified'])
      .default('best_effort'),
    /**
     * P33 (legacy, still authoritative when set true): Whether regulated
     * approvals require verified actor identity (claim_validated or higher).
     * Checked BEFORE minimumActorAssuranceForApproval; when `true`, takes
     * precedence and minimumActorAssuranceForApproval is not consulted.
     */
    requireVerifiedActorsForApproval: z.boolean().default(false),
    /**
     * P35a/P35b1/P35b2: IdP configuration for static keys or JWKS authority.
     * Frozen at hydrate time. When set, allows idp_verified actors via FLOWGUARD_ACTOR_TOKEN_PATH.
     */
    identityProvider: IdpConfigSchema.optional(),
    /**
     * P35a: IdP verification mode ('optional' or 'required').
     * Controls whether IdP verification failure blocks session creation.
     */
    identityProviderMode: z.enum(['optional', 'required']).default('optional'),
    /**
     * Self-review configuration for independent review.
     * Frozen at hydrate time. Controls subagent-based review behavior.
     */
    selfReview: z
      .object({
        subagentEnabled: z.boolean(),
        fallbackToSelf: z.boolean(),
        strictEnforcement: z.boolean().default(false),
      })
      .optional(),
    /** Frozen review output policy for structured vs text-compatible evidence. */
    reviewOutputPolicy: z.enum(['structured_required', 'text_compat_allowed']).optional(),
    /** Frozen review invocation policy — how the reviewer must be invoked. */
    reviewInvocationPolicy: z
      .enum(['host_task_required', 'host_task_preferred', 'sdk_allowed'])
      .optional(),
    /**
     * Frozen mandatory review coverage profile. 'core' is the non-optional
     * baseline; 'full' is reserved for Wave 2 (#730). Optional for backward
     * compatibility; resolvePolicyFromSnapshot applies a fail-closed,
     * mode-consistent default ('core') for legacy snapshots.
     */
    reviewProfile: z.enum(['core', 'full']).optional(),
    /**
     * Versioned review-challenge policy. Optional intentionally: snapshots
     * written before #747 must not acquire new challenge enforcement.
     */
    challengePolicy: z
      .object({
        version: z.literal('challenge-policy.v1'),
        counts: z.object({
          TRIVIAL: z.literal(0),
          STANDARD: z.literal(1),
          'HIGH-RISK': z.literal(2),
        }),
      })
      .optional(),
    /** Runtime risk-classification enforcement frozen at hydrate time. */
    enforceRiskClassification: z.boolean().optional(),
    /** Structured downgrade override permission. Defaults closed for legacy snapshots. */
    allowRiskDowngradeOverride: z.boolean().optional(),
    /** Reduced ceremony permission. Defaults closed for legacy snapshots. */
    allowReducedCeremony: z.boolean().optional(),
    /**
     * Policy-gated Discovery health enforcement frozen at hydrate time (#399).
     * Optional for backward compatibility; the transform below applies a
     * fail-closed, mode-consistent default for legacy snapshots.
     */
    discoveryHealth: z
      .object({
        enforcement: z.enum(['off', 'advisory', 'required']),
        onDegraded: z.enum(['allow', 'warn', 'block']),
        onDrift: z.enum(['allow', 'warn', 'block']),
      })
      .optional(),
    /**
     * Policy-gated validation-evidence enforcement frozen at hydrate time (#400).
     * Optional for backward compatibility; the transform below applies a
     * fail-closed, mode-consistent default for legacy snapshots.
     */
    validationEvidence: z
      .object({
        enforcement: z.enum(['off', 'advisory', 'required']),
        allowNoCommands: z.boolean(),
      })
      .optional(),
    audit: z.object({
      emitTransitions: z.boolean(),
      emitToolCalls: z.boolean(),
      enableChainHash: z.boolean(),
      timestampAssurance: z
        .object({
          enabled: z.boolean().default(false),
          mode: z.enum(['local_only', 'ntp_check', 'tsa_critical']).default('local_only'),
          strict: z.boolean().default(false),
          criticalEvents: z.array(z.string()).default(['decision', 'lifecycle']),
          tsaUrl: z.string().optional(),
          trustAnchors: z.array(z.string()).optional(),
          ntpServers: z.array(z.string()).optional(),
          ntpDriftThresholdMs: z.number().default(30000),
          tsaTimeoutMs: z.number().default(10000),
        })
        .optional()
        .default({
          enabled: false,
          mode: 'local_only' as const,
          strict: false,
          criticalEvents: ['decision', 'lifecycle'],
          ntpServers: ['pool.ntp.org'],
          ntpDriftThresholdMs: 30000,
          tsaTimeoutMs: 10000,
        }),
    }),
    /**
     * Actor classification map — frozen copy from policy preset.
     * Maps tool names to actor labels for the audit trail.
     * Tools not listed default to "system" at runtime.
     */
    actorClassification: z.record(z.string(), z.string()),
  })
  .transform((snapshot) => ({
    ...snapshot,
    enforceRiskClassification:
      snapshot.enforceRiskClassification ?? defaultsToEnforcement(snapshot.mode),
    allowRiskDowngradeOverride: snapshot.allowRiskDowngradeOverride ?? false,
    allowReducedCeremony: snapshot.allowReducedCeremony ?? false,
    discoveryHealth:
      snapshot.discoveryHealth ??
      (defaultsToEnforcement(snapshot.mode)
        ? {
            enforcement: 'required' as const,
            onDegraded: 'warn' as const,
            onDrift: 'block' as const,
          }
        : { enforcement: 'off' as const, onDegraded: 'allow' as const, onDrift: 'allow' as const }),
    validationEvidence:
      snapshot.validationEvidence ??
      (defaultsToEnforcement(snapshot.mode)
        ? { enforcement: 'required' as const, allowNoCommands: false }
        : { enforcement: 'off' as const, allowNoCommands: false }),
    maxIncoherentReviewerCaptureRetries: snapshot.maxIncoherentReviewerCaptureRetries ?? 1,
    maxReviewerOutputRepairAttempts: snapshot.maxReviewerOutputRepairAttempts ?? 1,
  }))
  .readonly();
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;
