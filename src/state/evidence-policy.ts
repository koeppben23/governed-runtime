/**
 * @module evidence-policy
 * @description Immutable policy snapshot embedded in SessionState.
 *
 * @version v1
 */

import { z } from 'zod';
import { POLICY_DIGEST_PATTERN, POLICY_DIGEST_VERSION } from './evidence-identifiers.js';
import { ActorAssuranceSchema } from '../shared/actor-assurance.js';
import { IdpConfigSchema } from '../shared/policy-idp-config.js';
import { PolicyModeSchema, CentralMinimumModeSchema } from './policy-mode.js';

/**
 * Executable policy authorities.
 *
 * Each nested policy shape exists exactly once: as a Zod schema here. Runtime
 * validation parses the schema; TypeScript types are inferred from it; the
 * config layer re-exports the inferred types as its public surface. There is no
 * second, hand-written declaration to drift against.
 */

/**
 * Deep-readonly, exact-optional projection of a schema-inferred shape.
 *
 * `z.infer` yields mutable properties and admits explicit `undefined` for
 * optional fields. The exported policy types preserve the pre-existing API
 * contract instead: deeply readonly, and exact-optional (absence — not
 * `undefined`) under `exactOptionalPropertyTypes`. Runtime validation remains
 * with the schemas.
 */
type ExactDeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly ExactDeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: ExactDeepReadonly<Exclude<T[K], undefined>> }
    : T;

/** Versioned product decision for evidence-bound review challenges (#747). */
export const CHALLENGE_POLICY_VERSION = 'challenge-policy.v1' as const;

/**
 * Versioned review-challenge policy. REQUIRED in the Hard Assurance Epoch:
 * a snapshot without it would silently disable mandatory challenge coverage
 * when obligations are minted — absence must fail parsing.
 */
export const ChallengePolicySchema = z.object({
  version: z.literal(CHALLENGE_POLICY_VERSION),
  counts: z.object({
    TRIVIAL: z.literal(0),
    STANDARD: z.literal(1),
    'HIGH-RISK': z.literal(2),
  }),
});
export type ChallengePolicy = ExactDeepReadonly<z.infer<typeof ChallengePolicySchema>>;

/** Timestamp assurance evidence configuration for audit events. */
export const TimestampAssurancePolicySchema = z.object({
  /** Enable timestamp assurance evidence (default: false). */
  enabled: z.boolean(),
  /** Assurance mode: local_only, ntp_check, or tsa_critical. */
  mode: z.enum(['local_only', 'ntp_check', 'tsa_critical']),
  /**
   * Strict mode — TSA failure on critical events → session ERROR.
   * Slice 1 (#269): always false. Inert until a real TSA verifier lands.
   */
  strict: z.boolean(),
  /** Event kinds that require TSA evidence (e.g., decision, lifecycle). */
  criticalEvents: z.array(z.string()),
  /** TSA endpoint URL (required in tsa_critical mode). */
  tsaUrl: z.string().optional(),
  /** PEM-encoded TSA trust anchor certificates (for Slice 2 verification). */
  trustAnchors: z.array(z.string()).optional(),
  /** NTP server hostnames (default: pool.ntp.org). */
  ntpServers: z.array(z.string()).optional(),
  /** Max clock drift before warning (ms, default: 30000). */
  ntpDriftThresholdMs: z.number(),
  /** TSA request timeout (ms, default: 10000). */
  tsaTimeoutMs: z.number(),
});
export type TimestampAssurancePolicy = ExactDeepReadonly<
  z.infer<typeof TimestampAssurancePolicySchema>
>;

/** Controls which audit events are emitted and how. */
export const AuditPolicySchema = z.object({
  /** Emit per-transition audit events (one per state change). */
  emitTransitions: z.boolean(),
  /** Emit per-tool-call audit events. */
  emitToolCalls: z.boolean(),
  /** Enable SHA-256 hash chain for tamper detection. */
  enableChainHash: z.boolean(),
  /** Timestamp assurance evidence configuration. */
  timestampAssurance: TimestampAssurancePolicySchema,
});
export type AuditPolicy = ExactDeepReadonly<z.infer<typeof AuditPolicySchema>>;

/** Canonical iteration budgets for each independent review loop. */
export const ReviewBudgetSchema = z.object({
  plan: z.number().int().positive(),
  architecture: z.number().int().positive(),
  implementation: z.number().int().positive(),
});
export type ReviewBudget = ExactDeepReadonly<z.infer<typeof ReviewBudgetSchema>>;

/**
 * Policy-gated Discovery health enforcement (#399).
 *
 * Two-axis governance:
 * - enforcement: master switch. 'off' = advisory-only (no new workflow blocks).
 *   'advisory' = surface warnings/NOT_VERIFIED but never block. 'required' =
 *   unavailable Discovery ALWAYS blocks; degraded/drift follow the actions.
 * - onDegraded: action when Discovery is available but degraded or stale.
 * - onDrift: action when the cached drift verdict is not 'clean'.
 *
 * Policy NEVER fabricates Discovery evidence; only governs whether a workflow
 * may proceed with degraded/unavailable evidence.
 */
export const DiscoveryHealthPolicySchema = z.object({
  enforcement: z.enum(['off', 'advisory', 'required']),
  onDegraded: z.enum(['allow', 'warn', 'block']),
  onDrift: z.enum(['allow', 'warn', 'block']),
});
export type DiscoveryHealthPolicy = ExactDeepReadonly<z.infer<typeof DiscoveryHealthPolicySchema>>;

/**
 * Policy-gated validation-evidence enforcement (#400).
 *
 * Prevents HIGH-RISK/regulated sessions from passing VALIDATION vacuously when
 * no Discovery-derived verification commands are available: under 'required',
 * progression demands at least one applicable active check OR the explicit
 * policy-backed exception `allowNoCommands`.
 *
 * Never fabricates verification evidence and never permits arbitrary fallback
 * commands; command resolution stays candidate-only.
 */
export const ValidationEvidencePolicySchema = z.object({
  enforcement: z.enum(['off', 'advisory', 'required']),
  allowNoCommands: z.boolean(),
});
export type ValidationEvidencePolicy = ExactDeepReadonly<
  z.infer<typeof ValidationEvidencePolicySchema>
>;

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
 * by `hashVersion: policy-digest.v3`. It supports integrity comparison against
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
    reviewBudget: ReviewBudgetSchema,
    /** Frozen retry budget for F12-incoherent reviewer captures. */
    maxIncoherentReviewerCaptureRetries: z.number().int().nonnegative(),
    /** Frozen obligation-level reviewer-attempt budget. */
    maxReviewerAttempts: z.number().int().min(0).max(5),
    allowSelfApproval: z.boolean(),
    /** P34: Minimum required actor assurance for regulated approval decisions. */
    minimumActorAssuranceForApproval: ActorAssuranceSchema,
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
    /** Frozen mandatory review coverage profile. */
    reviewProfile: z.enum(['core', 'full']),
    /**
     * Versioned review-challenge policy. REQUIRED in the Hard Assurance Epoch:
     * a snapshot without it would silently disable mandatory challenge
     * coverage when obligations are minted — absence must fail parsing.
     */
    challengePolicy: ChallengePolicySchema,
    /** Runtime risk-classification enforcement frozen at hydrate time. */
    enforceRiskClassification: z.boolean(),
    /** Structured downgrade override permission. */
    allowRiskDowngradeOverride: z.boolean(),
    /** Reduced ceremony permission. */
    allowReducedCeremony: z.boolean(),
    /** Policy-gated Discovery health enforcement frozen at hydrate time (#399). */
    discoveryHealth: DiscoveryHealthPolicySchema,
    /** Policy-gated validation-evidence enforcement frozen at hydrate time (#400). */
    validationEvidence: ValidationEvidencePolicySchema,
    audit: AuditPolicySchema,
    /**
     * Actor classification map — frozen copy from policy preset.
     * Maps tool names to actor labels for the audit trail.
     * Tools not listed default to "system" at runtime.
     */
    actorClassification: z.record(z.string(), z.string()),
  })
  .strict()
  .readonly();
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;
