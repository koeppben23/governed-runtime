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
 *    - Set phase = TICKET
 *    - Resolve profile → set activeChecks
 *    - Resolve policy → create immutable PolicySnapshot
 *    - Record initiatedBy (for four-eyes principle)
 *    - All evidence slots = null
 * 3. Evaluate the new state (returns "pending" at TICKET — waiting for /ticket)
 *
 * Idempotent: calling /hydrate on an existing session is a no-op.
 * This makes it safe to call at the start of every command as a guard.
 *
 * Special: This is the ONLY rail that accepts `null` as state input.
 *
 * @version v1
 */

import type { SessionState } from "../state/schema";
import type { BindingInfo } from "../state/evidence";
import { evaluate } from "../machine/evaluate";
import type { RailResult, RailContext } from "./types";
import { blocked } from "../config/reasons";
import { defaultProfileRegistry } from "../config/profile";
import type { FlowGuardProfile, RepoSignals } from "../config/profile";
import { extractBaseInstructions, extractByPhaseInstructions } from "../config/profile";
import { resolvePolicy, createPolicySnapshot } from "../config/policy";

// ─── Input ────────────────────────────────────────────────────────────────────

export interface HydrateInput {
  /** OpenCode session ID (from context.sessionID). */
  readonly sessionId: string;
  /** Git worktree path (from context.worktree). */
  readonly worktree: string;
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
  /**
   * Identity of the session initiator (author).
   * Used for four-eyes principle enforcement.
   * Defaults to sessionId if not provided.
   */
  readonly initiatedBy?: string;
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
    return blocked("MISSING_SESSION_ID");
  }
  if (!input.worktree.trim()) {
    return blocked("MISSING_WORKTREE");
  }

  // 2. Idempotent: if state exists, return it unchanged
  if (existingState !== null) {
    const result = evaluate(existingState, ctx.policy);
    return { kind: "ok", state: existingState, evalResult: result, transitions: [] };
  }

  // 3. Resolve profile → activeChecks + activeProfile
  let profile: FlowGuardProfile | undefined;

  if (input.profileId && input.profileId !== "baseline") {
    // Explicit profile requested — look up by ID
    profile = defaultProfileRegistry.get(input.profileId);
  } else if (input.repoSignals) {
    // Auto-detect from repo signals (highest confidence wins)
    profile = defaultProfileRegistry.detect(input.repoSignals);
  }

  // Fall back to baseline if nothing matched
  if (!profile) {
    profile = defaultProfileRegistry.get("baseline");
  }

  const activeChecks =
    input.activeChecks ?? profile?.activeChecks?.slice() ?? ["test_quality", "rollback_safety"];

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
  const policyMode = input.policyMode ?? "team";
  const policy = resolvePolicy(policyMode);
  const now = ctx.now();
  const policySnapshot = createPolicySnapshot(policy, now, ctx.digest);

  // 5. Create binding
  const binding: BindingInfo = {
    sessionId: input.sessionId,
    worktree: input.worktree,
    resolvedAt: now,
  };

  // 6. Create new state
  const newState: SessionState = {
    id: crypto.randomUUID(),
    schemaVersion: "v1",
    phase: "TICKET",

    binding,

    // All evidence slots start empty
    ticket: null,
    plan: null,
    selfReview: null,
    validation: [],
    implementation: null,
    implReview: null,
    reviewDecision: null,

    // Configuration
    activeProfile,
    activeChecks,
    policySnapshot,
    initiatedBy: input.initiatedBy ?? input.sessionId,

    // Metadata
    transition: null,
    error: null,
    createdAt: now,
  };

  // 7. Evaluate (will be "pending" at TICKET — waiting for /ticket)
  const result = evaluate(newState, ctx.policy);

  return { kind: "ok", state: newState, evalResult: result, transitions: [] };
}
