/**
 * @module evidence-policy
 * @description Immutable policy snapshot embedded in SessionState.
 *
 * @version v1
 */

import { z } from 'zod';
import { POLICY_DIGEST_PATTERN, POLICY_DIGEST_VERSION } from './evidence-identifiers.js';
import { IdpConfigSchema } from './policy-idp-config.js';
import { PolicyModeSchema, CentralMinimumModeSchema } from './policy-mode.js';

/**
 * Immutable policy snapshot embedded in SessionState.
 *
 * Stores all FlowGuard-critical fields so auditors can verify which rules
 * governed a session — even after policy presets are updated.
 *
 * Hard Assurance Epoch contract: every authority-bearing field the controlled
 * hydrate writer persists is REQUIRED here. There is no read-time defaulting,
 * no legacy-snapshot synthesis, and no backward-compatibility transform —
 * an incomplete current-epoch snapshot fails parsing. Only fields whose
 * absence is itself legitimate current semantics (a not-configured optional
 * integration, or provenance that only exists for central-policy sources)
 * remain optional.
 *
 * The hash is SHA-256 of recursively canonicalized policy content, identified
 * by `hashVersion: policy-digest.v2`. It supports integrity comparison against
 * a trusted reference; it does not independently prove authenticity or
 * non-repudiation.
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
    /** Lowercase SHA-256 hash of policy content; see hashVersion for its serialization contract. */
    hash: z.string().regex(POLICY_DIGEST_PATTERN),
    /** Required serialization contract for the policy digest. */
    hashVersion: z.literal(POLICY_DIGEST_VERSION),
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

    // ─── Governance-critical fields (frozen copy) ───────────────
    requireHumanGates: z.boolean(),
    maxSelfReviewIterations: z.number().int().positive(),
    maxImplReviewIterations: z.number().int().positive(),
    /** Frozen retry budget for F12-incoherent reviewer captures. */
    maxIncoherentReviewerCaptureRetries: z.number().int().nonnegative(),
    /** Frozen obligation-level reviewer output-repair budget. */
    maxReviewerOutputRepairAttempts: z.number().int().min(0).max(5),
    allowSelfApproval: z.boolean(),
    /**
     * P34: Minimum required actor assurance for regulated approval decisions.
     *
     * Resolution precedence (see verifyAssuranceThreshold in
     * src/rails/review-decision.ts):
     *   1. requireVerifiedActorsForApproval (P33) — if `true`, the
     *      approver must be at assurance `claim_validated` or higher and this
     *      field is the gate; minimumActorAssuranceForApproval is then ignored.
     *   2. minimumActorAssuranceForApproval (P34) — used only when
     *      requireVerifiedActorsForApproval is `false`.
     *
     * Operators relaxing requireVerifiedActorsForApproval=true by setting
     * minimumActorAssuranceForApproval to a lower tier MUST also flip
     * requireVerifiedActorsForApproval to `false`, otherwise the stricter
     * gate keeps winning.
     */
    minimumActorAssuranceForApproval: z.enum(['best_effort', 'claim_validated', 'idp_verified']),
    /**
     * P33 (still authoritative when set true): Whether regulated
     * approvals require verified actor identity (claim_validated or higher).
     * Checked BEFORE minimumActorAssuranceForApproval; when `true`, takes
     * precedence and minimumActorAssuranceForApproval is not consulted.
     */
    requireVerifiedActorsForApproval: z.boolean(),
    /**
     * P35a/P35b1/P35b2: IdP configuration for static keys or JWKS authority.
     * Frozen at hydrate time. Optional: absence means no IdP is configured.
     */
    identityProvider: IdpConfigSchema.optional(),
    /**
     * P35a: IdP verification mode ('optional' or 'required').
     * Controls whether IdP verification failure blocks session creation.
     */
    identityProviderMode: z.enum(['optional', 'required']),
    /**
     * Self-review configuration for independent review.
     * Frozen at hydrate time. REQUIRED, and — Hard Assurance Epoch — the ONLY
     * current-contract-valid shape is the mandatory strict subagent review;
     * anything else fails parsing instead of being re-normalized at runtime.
     */
    selfReview: z.object({
      subagentEnabled: z.literal(true),
      fallbackToSelf: z.literal(false),
      strictEnforcement: z.literal(true),
    }),
    /** Frozen review output policy for structured vs text-compatible evidence. */
    reviewOutputPolicy: z.enum(['structured_required', 'text_compat_allowed']),
    /** Frozen review invocation policy — how the reviewer must be invoked. */
    reviewInvocationPolicy: z.enum(['host_task_required', 'host_task_preferred', 'sdk_allowed']),
    /** Frozen mandatory review coverage profile. */
    reviewProfile: z.enum(['core', 'full']),
    /**
     * Versioned review-challenge policy. REQUIRED in the Hard Assurance Epoch:
     * a snapshot without it would silently disable mandatory challenge
     * coverage when obligations are minted — absence must fail parsing.
     */
    challengePolicy: z.object({
      version: z.literal('challenge-policy.v1'),
      counts: z.object({
        TRIVIAL: z.literal(0),
        STANDARD: z.literal(1),
        'HIGH-RISK': z.literal(2),
      }),
    }),
    /** Runtime risk-classification enforcement frozen at hydrate time. */
    enforceRiskClassification: z.boolean(),
    /** Structured downgrade override permission. */
    allowRiskDowngradeOverride: z.boolean(),
    /** Reduced ceremony permission. */
    allowReducedCeremony: z.boolean(),
    /** Policy-gated Discovery health enforcement frozen at hydrate time (#399). */
    discoveryHealth: z.object({
      enforcement: z.enum(['off', 'advisory', 'required']),
      onDegraded: z.enum(['allow', 'warn', 'block']),
      onDrift: z.enum(['allow', 'warn', 'block']),
    }),
    /** Policy-gated validation-evidence enforcement frozen at hydrate time (#400). */
    validationEvidence: z.object({
      enforcement: z.enum(['off', 'advisory', 'required']),
      allowNoCommands: z.boolean(),
    }),
    audit: z.object({
      emitTransitions: z.boolean(),
      emitToolCalls: z.boolean(),
      enableChainHash: z.boolean(),
      timestampAssurance: z.object({
        enabled: z.boolean(),
        mode: z.enum(['local_only', 'ntp_check', 'tsa_critical']),
        strict: z.boolean(),
        criticalEvents: z.array(z.string()),
        tsaUrl: z.string().optional(),
        trustAnchors: z.array(z.string()).optional(),
        ntpServers: z.array(z.string()).optional(),
        ntpDriftThresholdMs: z.number(),
        tsaTimeoutMs: z.number(),
      }),
    }),
    /**
     * Actor classification map — frozen copy from policy preset.
     * Maps tool names to actor labels for the audit trail.
     * Tools not listed default to "system" at runtime.
     */
    actorClassification: z.record(z.string(), z.string()),
  })
  .readonly();
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;
