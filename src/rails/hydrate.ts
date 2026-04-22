/**
 * @module hydrate
 * @description /hydrate rail — bootstrap a FlowGuard session.
 *
 * This is the FIRST command in every workflow. It creates or loads the SessionState.
 * Named "hydrate" (not "init") because OpenCode already has /init.
 *
 * Behavior:
 * 1. If state already exists → return it unchanged (idempotent)
 * 2. If state is null → create a new SessionState:
 *    - Generate UUID
 *    - Resolve binding from OpenCode tool context (sessionId, worktree)
 *    - Set phase = READY (user selects a flow via /ticket, /architecture, or /review)
 *    - Resolve profile → set activeChecks
 *    - Resolve policy → create immutable PolicySnapshot
 *    - Record initiatedBy (for four-eyes principle)
 *    - All evidence slots = null
 * 3. Evaluate the new state (returns "pending" at READY — waiting for flow selection)
 *
 * Idempotent: calling /hydrate on an existing session is a no-op.
 * This makes it safe to call at the start of every command as a guard.
 *
 * Special: This is the ONLY rail that accepts `null` as state input.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema';
import type { BindingInfo } from '../state/evidence';
import type { ActorInfo } from '../audit/types';
import type { DecisionIdentity } from '../state/evidence';
import type { DiscoverySummary } from '../discovery/types';
import type { DetectedStack } from '../discovery/types';
import type { VerificationCandidates } from '../discovery/types';
import { evaluate } from '../machine/evaluate';
import type { RailResult, RailContext } from './types';
import { blocked } from '../config/reasons';
import { defaultProfileRegistry } from '../config/profile';
import type { FlowGuardProfile, RepoSignals } from '../config/profile';
import type { DiscoveryResult } from '../discovery/types';
import { extractBaseInstructions, extractByPhaseInstructions } from '../config/profile';
import { resolvePolicy, createPolicySnapshot } from '../config/policy';
import type { EffectiveGateBehavior, PolicyDegradedReason, PolicyMode } from '../config/policy';
import type { PolicySource, PolicyResolutionReason, CentralMinimumMode } from '../config/policy';

// ─── Input ────────────────────────────────────────────────────────────────────

export interface HydrateInput {
  /** OpenCode session ID (from context.sessionID). */
  readonly sessionId: string;
  /** Git worktree path (from context.worktree). */
  readonly worktree: string;
  /**
   * Repository fingerprint (24 hex chars).
   * Computed by workspace.ts from the canonical remote URL or local path.
   */
  readonly fingerprint: string;
  /**
   * Active validation checks.
   * If provided, overrides the profile's default checks.
   * If omitted, resolved from the profile.
   */
  readonly activeChecks?: string[];
  /**
   * Profile ID to use (e.g., "baseline", "backend-java").
   * If omitted, auto-detect from repoSignals (falls back to "baseline").
   */
  readonly profileId?: string;
  /**
   * Repository signals for automatic profile detection.
   * Used only when profileId is not provided.
   * If omitted, profile falls back to the explicit profileId or "baseline".
   */
  readonly repoSignals?: RepoSignals;
  /**
   * Policy mode ("solo" | "team" | "regulated").
   * Defaults to "team" if not provided.
   */
  readonly policyMode?: string;
  /** Requested policy mode before CI/context resolution. */
  readonly requestedPolicyMode?: PolicyMode;
  /** Effective gate behavior for the resolved policy mode. */
  readonly effectiveGateBehavior?: EffectiveGateBehavior;
  /** Optional reason why requested mode was degraded. */
  readonly policyDegradedReason?: PolicyDegradedReason;
  /** Applied policy source (P29). */
  readonly policySource?: PolicySource;
  /** Why source precedence selected/overrode a mode (P29). */
  readonly policyResolutionReason?: PolicyResolutionReason;
  /** Central minimum mode used during precedence resolution (P29). */
  readonly centralMinimumMode?: CentralMinimumMode;
  /** Digest of central policy bundle used during hydrate (P29). */
  readonly policyDigest?: string;
  /** Version from central policy bundle (P29). */
  readonly policyVersion?: string;
  /** Redacted path hint for central policy bundle (P29). */
  readonly policyPathHint?: string;
  /** P31: Override maxSelfReviewIterations from config.policy */
  readonly maxSelfReviewIterations?: number;
  /** P31: Override maxImplReviewIterations from config.policy */
  readonly maxImplReviewIterations?: number;
  /** Override verified actor requirement from config.policy for new sessions. */
  readonly requireVerifiedActorsForApproval?: boolean;
  /**
   * Identity of the session initiator (author).
   * Used for four-eyes principle enforcement.
   * Tool layer should pass actor identity (not OpenCode sessionId).
   * Defaults to sessionId only as a backward-compatible fallback.
   */
  readonly initiatedBy?: string;
  /**
   * Structured initiator identity for regulated approval (P30).
   * Persists actor identity at session creation for four-eyes proof.
   */
  readonly initiatedByIdentity?: DecisionIdentity;
  /**
   * Resolved actor identity (P27).
   * Best-effort operator identity resolved at hydrate time.
   * Absent for pre-P27 sessions.
   */
  readonly actorInfo?: ActorInfo;
  /**
   * Discovery result from the orchestrator.
   * Used for profile detection when available (Phase 5+).
   * The rail does NOT run discovery — the tool layer does.
   */
  readonly discoveryResult?: DiscoveryResult;
  /**
   * SHA-256 digest of the DiscoveryResult.
   * Computed by the tool layer and embedded in SessionState.
   */
  readonly discoveryDigest?: string;
  /**
   * Lightweight discovery summary for SessionState.
   * Extracted from DiscoveryResult by the tool layer.
   */
  readonly discoverySummary?: DiscoverySummary;
  /**
   * Compact detected stack versions for SessionState.
   * Extracted from DiscoveryResult by the tool layer.
   * Derived evidence — NOT SSOT.
   */
  readonly detectedStack?: DetectedStack | null;
  /**
   * Advisory verification command candidates derived from stack + manifest evidence.
   * Derived evidence — NOT SSOT.
   */
  readonly verificationCandidates?: VerificationCandidates;
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

/**
 * Bootstrap or load a FlowGuard session.
 *
 * @param existingState - Current state, or null if this is a new session.
 * @param input - Binding info from OpenCode tool context.
 * @param ctx - Rail context (now, digest, policy).
 * @returns RailOk with the (possibly new) session state.
 */
export function executeHydrate(
  existingState: SessionState | null,
  input: HydrateInput,
  ctx: RailContext,
): RailResult {
  // 1. Validate input
  if (!input.sessionId.trim()) {
    return blocked('MISSING_SESSION_ID');
  }
  if (!input.worktree.trim()) {
    return blocked('MISSING_WORKTREE');
  }
  if (!input.fingerprint || !/^[0-9a-f]{24}$/.test(input.fingerprint)) {
    return blocked('INVALID_FINGERPRINT');
  }

  // 2. Idempotent: if state exists, return it unchanged
  if (existingState !== null) {
    const result = evaluate(existingState, ctx.policy);
    return { kind: 'ok', state: existingState, evalResult: result, transitions: [] };
  }

  // 3. Resolve profile → activeChecks + activeProfile
  let profile: FlowGuardProfile | undefined;

  // P31: explicit > config > detected > baseline
  // profileId === undefined → auto-detect
  // profileId set (including "baseline") → explicit profile
  if (input.profileId !== undefined) {
    profile = defaultProfileRegistry.get(input.profileId);
  } else if (input.repoSignals) {
    profile = defaultProfileRegistry.detect({
      repoSignals: input.repoSignals,
      discovery: input.discoveryResult,
    });
  }

  if (!profile) {
    profile = defaultProfileRegistry.get('baseline');
  }

  const activeChecks = input.activeChecks ??
    profile?.activeChecks?.slice() ?? ['test_quality', 'rollback_safety'];

  const activeProfile = profile
    ? {
        id: profile.id,
        name: profile.name,
        ruleContent: extractBaseInstructions(profile.instructions),
        ...(extractByPhaseInstructions(profile.instructions)
          ? { phaseRuleContent: extractByPhaseInstructions(profile.instructions) }
          : {}),
      }
    : null;

  // 4. Resolve policy → immutable snapshot
  const policyMode = input.policyMode ?? 'solo';
  let policy = resolvePolicy(policyMode);
  // P31: Apply config iteration limit overrides
  if (
    input.maxSelfReviewIterations !== undefined ||
    input.maxImplReviewIterations !== undefined ||
    input.requireVerifiedActorsForApproval !== undefined
  ) {
    policy = {
      ...policy,
      maxSelfReviewIterations: input.maxSelfReviewIterations ?? policy.maxSelfReviewIterations,
      maxImplReviewIterations: input.maxImplReviewIterations ?? policy.maxImplReviewIterations,
      requireVerifiedActorsForApproval:
        input.requireVerifiedActorsForApproval ?? policy.requireVerifiedActorsForApproval,
    };
  }
  const now = ctx.now();
  const snapshotWithContext = createPolicySnapshot(policy, now, ctx.digest, {
    requestedMode: input.requestedPolicyMode ?? policy.mode,
    source: input.policySource ?? 'default',
    effectiveGateBehavior:
      input.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve'),
    degradedReason: input.policyDegradedReason,
    resolutionReason: input.policyResolutionReason,
    centralMinimumMode: input.centralMinimumMode,
    policyDigest: input.policyDigest,
    policyVersion: input.policyVersion,
    policyPathHint: input.policyPathHint,
  });

  // 5. Create binding
  const binding: BindingInfo = {
    sessionId: input.sessionId,
    worktree: input.worktree,
    fingerprint: input.fingerprint,
    resolvedAt: now,
  };

  // 6. Create new state
  const newState: SessionState = {
    id: crypto.randomUUID(),
    schemaVersion: 'v1',
    phase: 'READY',

    binding,

    // All evidence slots start empty
    ticket: null,
    architecture: null,
    plan: null,
    selfReview: null,
    validation: [],
    implementation: null,
    implReview: null,
    reviewDecision: null,
    nextAdrNumber: 1,

    // Configuration
    activeProfile,
    activeChecks,
    policySnapshot: snapshotWithContext,
    initiatedBy: input.initiatedBy ?? input.sessionId,
    ...(input.initiatedByIdentity ? { initiatedByIdentity: input.initiatedByIdentity } : {}),
    ...(input.actorInfo ? { actorInfo: input.actorInfo } : {}),

    // Discovery
    discoveryDigest: input.discoveryDigest ?? null,
    discoverySummary: input.discoverySummary ?? null,
    detectedStack: input.detectedStack ?? null,
    verificationCandidates: input.verificationCandidates ?? [],

    // Metadata
    transition: null,
    error: null,
    createdAt: now,
  };

  // 7. Evaluate (will be "pending" at READY — waiting for flow selection)
  const result = evaluate(newState, ctx.policy);

  return { kind: 'ok', state: newState, evalResult: result, transitions: [] };
}
