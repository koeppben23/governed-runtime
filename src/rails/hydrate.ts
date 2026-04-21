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
import type { DiscoverySummary } from '../discovery/types';
import type { DetectedStack } from '../discovery/types';
import { evaluate } from '../machine/evaluate';
import type { RailResult, RailContext } from './types';
import { blocked } from '../config/reasons';
import { defaultProfileRegistry } from '../config/profile';
import type { FlowGuardProfile, RepoSignals } from '../config/profile';
import type { DiscoveryResult } from '../discovery/types';
import { extractBaseInstructions, extractByPhaseInstructions } from '../config/profile';
import { resolvePolicy, createPolicySnapshot } from '../config/policy';
import type { EffectiveGateBehavior, PolicyDegradedReason, PolicyMode } from '../config/policy';

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
  /**
   * Identity of the session initiator (author).
   * Used for four-eyes principle enforcement.
   * Defaults to sessionId if not provided.
   */
  readonly initiatedBy?: string;
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

  if (input.profileId && input.profileId !== 'baseline') {
    // Explicit profile requested — look up by ID
    profile = defaultProfileRegistry.get(input.profileId);
  } else if (input.repoSignals) {
    // Auto-detect from repo signals (highest confidence wins)
    profile = defaultProfileRegistry.detect({
      repoSignals: input.repoSignals,
      discovery: input.discoveryResult,
    });
  }

  // Fall back to baseline if nothing matched
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
  const policy = resolvePolicy(policyMode);
  const now = ctx.now();
  const snapshotWithContext = createPolicySnapshot(policy, now, ctx.digest, {
    requestedMode: input.requestedPolicyMode ?? policy.mode,
    effectiveGateBehavior:
      input.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve'),
    degradedReason: input.policyDegradedReason,
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

    // Discovery
    discoveryDigest: input.discoveryDigest ?? null,
    discoverySummary: input.discoverySummary ?? null,
    detectedStack: input.detectedStack ?? null,

    // Metadata
    transition: null,
    error: null,
    createdAt: now,
  };

  // 7. Evaluate (will be "pending" at READY — waiting for flow selection)
  const result = evaluate(newState, ctx.policy);

  return { kind: 'ok', state: newState, evalResult: result, transitions: [] };
}
