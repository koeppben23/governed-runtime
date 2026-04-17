/**
 * @module config/policy
 * @description FlowGuard policy — operating mode configuration.
 *
 * Four presets:
 * - SOLO:      Single developer, no human gates, minimal ceremony
 * - TEAM:      Collaborative workflow, human gates, self-approval allowed
 * - TEAM-CI:   Team workflow with CI-only auto-approval
 * - REGULATED: Full FlowGuard, four-eyes principle, complete audit trail
 *
 * Policy lifecycle:
 * 1. Resolved at session creation (/hydrate) via `resolvePolicy(mode)`
 * 2. Frozen as an immutable PolicySnapshot in SessionState
 * 3. Governs the session for its entire lifetime — never mutated mid-session
 *
 * The PolicySnapshot stores FlowGuard-critical fields so auditors can verify
 * which rules governed a session — even if the policy presets are updated later.
 * The snapshot hash provides non-repudiation: if the hash matches a known policy,
 * the policy is authentic.
 *
 * Regulatory context:
 * - MaRisk AT 7.2: REGULATED enforces separation of duties via four-eyes
 * - ISO 27001 A.8.32: All modes enforce change management controls
 * - GoBD §146: TEAM/REGULATED enable tamper-evident hash chain
 * - DORA Art. 9: REGULATED provides full ICT change management FlowGuard
 *
 * Dependency: imports PolicySnapshot from state layer (inner → outer is correct).
 *
 * @version v1
 */

import type { PolicySnapshot } from '../state/evidence';

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

  /** Audit event emission controls. */
  readonly audit: AuditPolicy;

  /**
   * Actor classification per tool name.
   * Maps FlowGuard tool names to actor labels for the audit trail.
   * Tools not listed default to "system".
   */
  readonly actorClassification: Readonly<Record<string, string>>;
}

/** Supported policy modes. */
export type PolicyMode = 'solo' | 'team' | 'team-ci' | 'regulated';

/** Effective gate behavior after policy resolution. */
export type EffectiveGateBehavior = 'auto_approve' | 'human_gated';

/** Why policy mode was degraded. */
export type PolicyDegradedReason = 'ci_context_missing';

/** Detailed policy resolution result (requested vs effective). */
export interface PolicyResolution {
  readonly requestedMode: PolicyMode;
  readonly effectiveMode: PolicyMode;
  readonly effectiveGateBehavior: EffectiveGateBehavior;
  readonly degradedReason?: PolicyDegradedReason;
  readonly policy: FlowGuardPolicy;
}

// ─── Presets ──────────────────────────────────────────────────────────────────

/**
 * SOLO mode — single developer, minimal ceremony.
 *
 * - No human gates (auto-approve at PLAN_REVIEW/EVIDENCE_REVIEW)
 * - 1 review iteration (fast feedback, not deep convergence)
 * - Self-approval allowed (single person workflow)
 * - Hash chain disabled (overhead not justified for solo work)
 * - Audit events still emitted (traceability even in solo)
 */
export const SOLO_POLICY: FlowGuardPolicy = {
  mode: 'solo',
  requireHumanGates: false,
  maxSelfReviewIterations: 1,
  maxImplReviewIterations: 1,
  allowSelfApproval: true,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: false,
  },
  actorClassification: {
    flowguard_decision: 'system',
  },
};

/**
 * TEAM mode — collaborative workflow.
 *
 * - Human gates active (explicit approve/reject at review points)
 * - 3 review iterations (deep convergence via digest-stop)
 * - Self-approval allowed (trust within team)
 * - Full audit with hash chain
 */
export const TEAM_POLICY: FlowGuardPolicy = {
  mode: 'team',
  requireHumanGates: true,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
  },
  actorClassification: {
    flowguard_decision: 'human',
  },
};

/**
 * TEAM-CI mode — CI pipeline workflow.
 *
 * - Auto-approve at user gates (only when CI context is present)
 * - 3 review iterations (same as TEAM)
 * - Self-approval allowed (CI actor)
 * - Full audit with hash chain
 */
export const TEAM_CI_POLICY: FlowGuardPolicy = {
  mode: 'team-ci',
  requireHumanGates: false,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
  },
  actorClassification: {
    flowguard_decision: 'system',
  },
};

/**
 * REGULATED mode — full FlowGuard for banks, DATEV, regulated industries.
 *
 * - Human gates active (explicit approve/reject required)
 * - 3 review iterations (full convergence)
 * - Four-eyes principle enforced (initiator ≠ reviewer)
 * - Full audit with hash chain
 * - Abort also classified as human action
 *
 * Regulatory coverage:
 * - MaRisk AT 7.2 (1-5): Documented change request, impact analysis,
 *   test evidence, authorized approval, separation of duties
 * - BAIT 4.3.2: Change management with documented approval process
 * - ISO 27001 A.8.32: Change management controls
 * - GoBD §146 Abs. 4: Tamper-evident, immutable audit trail
 * - DORA Art. 9: ICT change management with audit trail
 */
export const REGULATED_POLICY: FlowGuardPolicy = {
  mode: 'regulated',
  requireHumanGates: true,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: false,
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
  },
  actorClassification: {
    flowguard_decision: 'human',
    flowguard_abort_session: 'human',
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

/** All known policy presets, indexed by mode. */
const POLICIES: Readonly<Record<string, FlowGuardPolicy>> = {
  solo: SOLO_POLICY,
  team: TEAM_POLICY,
  'team-ci': TEAM_CI_POLICY,
  regulated: REGULATED_POLICY,
};

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Detect whether this process runs in a CI context.
 *
 * Conservative default: false when context is missing or unclear.
 */
export function detectCiContext(env: Record<string, string | undefined> = process.env): boolean {
  const ciSignals = [
    env.CI,
    env.GITHUB_ACTIONS,
    env.GITLAB_CI,
    env.BUILDKITE,
    env.JENKINS_URL,
    env.TF_BUILD,
    env.TEAMCITY_VERSION,
    env.CIRCLECI,
    env.DRONE,
    env.BITBUCKET_BUILD_NUMBER,
    env.BUILDKITE_BUILD_ID,
  ];
  return ciSignals.some(isTruthyEnv);
}

function normalizePolicyMode(mode?: string): PolicyMode {
  if (!mode) return 'team';
  if (mode === 'solo' || mode === 'team' || mode === 'team-ci' || mode === 'regulated') {
    return mode;
  }
  return 'team';
}

/**
 * Resolve policy with runtime context awareness.
 *
 * THIS IS THE RUNTIME AUTHORITY. Use this for session creation and any
 * user-facing resolution where the effective mode matters.
 *
 * Degradation rules:
 * - team-ci + no CI detected → effectiveMode="team", effectiveGateBehavior="human_gated"
 * - All other modes → effectiveMode = requestedMode
 *
 * The returned policy object reflects the effective (possibly degraded) policy.
 * Compare: resolvePolicy() returns the raw preset without context.
 */
export function resolvePolicyWithContext(
  mode?: string,
  ciContext = detectCiContext(),
): PolicyResolution {
  const requestedMode = normalizePolicyMode(mode);
  if (requestedMode === 'team-ci' && !ciContext) {
    return {
      requestedMode,
      effectiveMode: 'team',
      effectiveGateBehavior: 'human_gated',
      degradedReason: 'ci_context_missing',
      policy: TEAM_POLICY,
    };
  }

  const policy = POLICIES[requestedMode] ?? TEAM_POLICY;
  return {
    requestedMode,
    effectiveMode: policy.mode,
    effectiveGateBehavior: policy.requireHumanGates ? 'human_gated' : 'auto_approve',
    policy,
  };
}

/**
 * Resolve a FlowGuard policy PRESET by mode name.
 *
 * ⚠ Authority scope: PRESET LOOKUP ONLY.
 * Returns the raw policy object for a given mode string without applying
 * runtime context (CI detection, degradation, etc.).
 *
 * Use for:
 *   - Config lookups (map mode strings to policy objects)
 *   - PolicySnapshot factory input (pass the already-resolved effective mode)
 *   - Preset comparison (e.g., policyTests)
 *
 * Do NOT use for:
 *   - Session creation → resolvePolicyWithContext()
 *   - Runtime gate evaluation → resolvePolicyWithContext()
 *
 * Runtime authority is resolvePolicyWithContext():
 *   - Applies CI context detection
 *   - Degrades team-ci to team when CI is not detected
 *   - Returns effective mode, effective gate behavior, and degradedReason
 *
 * team-ci returns TEAM_CI_POLICY (the preset, not the degraded result).
 * Degradation to TEAM_POLICY only happens inside resolvePolicyWithContext.
 *
 * @param mode - Policy mode string (solo | team | team-ci | regulated).
 *               Falls back to "team" for unknown or undefined values.
 */
export function getPolicyPreset(mode?: string): FlowGuardPolicy {
  const m = normalizePolicyMode(mode);
  return POLICIES[m] ?? TEAM_POLICY;
}

/**
 * @deprecated Use getPolicyPreset() for preset lookup, or
 * resolvePolicyWithContext() for runtime authority.
 */
export function resolvePolicy(mode?: string): FlowGuardPolicy {
  return getPolicyPreset(mode);
}

/** All known policy mode names. */
export function policyModes(): string[] {
  return Object.keys(POLICIES);
}

// ─── Snapshot Factory ─────────────────────────────────────────────────────────

/**
 * Create an immutable policy snapshot for embedding in SessionState.
 *
 * The snapshot freezes all FlowGuard-critical fields. The hash provides
 * non-repudiation: given the hash and the policy registry, an auditor
 * can verify which exact policy governed a session.
 *
 * @param policy - The resolved FlowGuard policy.
 * @param resolvedAt - ISO-8601 timestamp when the policy was frozen.
 * @param digestFn - SHA-256 digest function (injected for testability).
 */
export function createPolicySnapshot(
  policy: FlowGuardPolicy,
  resolvedAt: string,
  digestFn: (text: string) => string,
  resolution?: {
    requestedMode: PolicyMode;
    effectiveGateBehavior: EffectiveGateBehavior;
    degradedReason?: PolicyDegradedReason;
  },
): PolicySnapshot {
  // Canonical JSON: sorted keys for deterministic hashing.
  // This ensures the same policy always produces the same hash,
  // regardless of object key insertion order in different JS engines.
  const canonical = JSON.stringify(policy, Object.keys(policy).sort());

  return {
    mode: policy.mode,
    hash: digestFn(canonical),
    resolvedAt,
    requestedMode: resolution?.requestedMode ?? policy.mode,
    effectiveGateBehavior:
      resolution?.effectiveGateBehavior ??
      (policy.requireHumanGates ? 'human_gated' : 'auto_approve'),
    ...(resolution?.degradedReason ? { degradedReason: resolution.degradedReason } : {}),
    requireHumanGates: policy.requireHumanGates,
    maxSelfReviewIterations: policy.maxSelfReviewIterations,
    maxImplReviewIterations: policy.maxImplReviewIterations,
    allowSelfApproval: policy.allowSelfApproval,
    audit: {
      emitTransitions: policy.audit.emitTransitions,
      emitToolCalls: policy.audit.emitToolCalls,
      enableChainHash: policy.audit.enableChainHash,
    },
    actorClassification: { ...policy.actorClassification },
  };
}

/**
 * Reconstruct an executable policy from a frozen policy snapshot.
 *
 * Snapshot fields are the sole authority. No preset fallback.
 * All governance-critical fields including actorClassification
 * are read exclusively from the snapshot.
 */
export function policyFromSnapshot(snapshot: PolicySnapshot): FlowGuardPolicy {
  return {
    mode: snapshot.mode as PolicyMode,
    requireHumanGates: snapshot.requireHumanGates,
    maxSelfReviewIterations: snapshot.maxSelfReviewIterations,
    maxImplReviewIterations: snapshot.maxImplReviewIterations,
    allowSelfApproval: snapshot.allowSelfApproval,
    audit: {
      emitTransitions: snapshot.audit.emitTransitions,
      emitToolCalls: snapshot.audit.emitToolCalls,
      enableChainHash: snapshot.audit.enableChainHash,
    },
    actorClassification: { ...snapshot.actorClassification },
  };
}
