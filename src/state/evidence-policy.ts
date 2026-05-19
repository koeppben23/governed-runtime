/**
 * @module evidence-policy
 * @description Immutable policy snapshot embedded in SessionState.
 *
 * @version v1
 */

import { z } from 'zod';
import { IdpConfigSchema } from '../identity/types.js';

/**
 * Immutable policy snapshot embedded in SessionState.
 *
 * Stores all FlowGuard-critical fields so auditors can verify which rules
 * governed a session — even after policy presets are updated.
 *
 * The hash is SHA-256 of the canonical JSON of the full GovernancePolicy.
 * Non-repudiation: hash matches → policy is authentic and unmodified.
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
    mode: z.string(),
    /** SHA-256 hash of the canonical JSON of the full GovernancePolicy. */
    hash: z.string(),
    /** When the policy was resolved and frozen. */
    resolvedAt: z.string().datetime(),
    /** Original requested policy mode at hydrate time. */
    requestedMode: z.string(),
    /** Applied policy source (P29): explicit, central, repo, or default. */
    source: z.enum(['explicit', 'central', 'repo', 'default']).optional(),
    /** Effective gate behavior after mode resolution. */
    effectiveGateBehavior: z.enum(['auto_approve', 'human_gated']),
    /** Why requested mode was degraded (if applicable). */
    degradedReason: z.string().optional(),
    /** Why source precedence selected/overrode a mode (P29). */
    resolutionReason: z.string().optional(),
    /** Central minimum mode that constrained resolution (P29). */
    centralMinimumMode: z.enum(['solo', 'team', 'regulated']).optional(),
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
    allowSelfApproval: z.boolean(),
    /**
     * P34: Minimum required actor assurance for regulated approval decisions.
     * Supersedes requireVerifiedActorsForApproval at session resolution time.
     * 'best_effort' | 'claim_validated' | 'idp_verified'
     */
    minimumActorAssuranceForApproval: z
      .enum(['best_effort', 'claim_validated', 'idp_verified'])
      .default('best_effort'),
    /**
     * P33 (deprecated): Whether regulated approvals require verified actor identity.
     * Preserved for backward compat with existing sessions. Prefer minimumActorAssuranceForApproval.
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
    /** Runtime risk-classification enforcement frozen at hydrate time. */
    enforceRiskClassification: z.boolean().optional(),
    /** Structured downgrade override permission. Defaults closed for legacy snapshots. */
    allowRiskDowngradeOverride: z.boolean().optional(),
    /** Reduced ceremony permission. Defaults closed for legacy snapshots. */
    allowReducedCeremony: z.boolean().optional(),
    audit: z.object({
      emitTransitions: z.boolean(),
      emitToolCalls: z.boolean(),
      enableChainHash: z.boolean(),
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
      snapshot.enforceRiskClassification ??
      (snapshot.mode === 'regulated' || snapshot.mode === 'team-ci'),
    allowRiskDowngradeOverride: snapshot.allowRiskDowngradeOverride ?? false,
    allowReducedCeremony: snapshot.allowReducedCeremony ?? false,
  }))
  .readonly();
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;
