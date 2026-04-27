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

import type { SessionState } from '../state/schema.js';
import type { BindingInfo } from '../state/evidence.js';
import type { ActorInfo } from '../audit/types.js';
import type { DecisionIdentity } from '../state/evidence.js';
import type { DiscoverySummary } from '../discovery/types.js';
import type { DetectedStack } from '../discovery/types.js';
import type { VerificationCandidates } from '../discovery/types.js';
import type { IdpConfig, IdentityProviderMode } from '../identity/types.js';
import { evaluate } from '../machine/evaluate.js';
import type { RailResult, RailContext } from './types.js';
import { blocked } from '../config/reasons.js';
import { defaultProfileRegistry } from '../config/profile.js';
import type { FlowGuardProfile, RepoSignals } from '../config/profile.js';
import type { DiscoveryResult } from '../discovery/types.js';
import { extractBaseInstructions, extractByPhaseInstructions } from '../config/profile.js';
import { resolvePolicy, createPolicySnapshot } from '../config/policy.js';
import type { EffectiveGateBehavior, PolicyDegradedReason, PolicyMode } from '../config/policy.js';
import type { PolicySource, PolicyResolutionReason, CentralMinimumMode } from '../config/policy.js';

// ─── Input ────────────────────────────────────────────────────────────────────

/**
 * Session binding and discovery evidence.
 *
 * Fields required to establish a session and the discovery artifacts
 * derived by the tool layer before calling executeHydrate.
 */
export interface HydrateSessionInput {
  readonly sessionId: string;
  readonly worktree: string;
  readonly fingerprint: string;
  readonly discoveryDigest?: string;
  readonly discoverySummary?: DiscoverySummary;
  readonly detectedStack?: DetectedStack | null;
  readonly verificationCandidates?: VerificationCandidates;
}

/**
 * Policy resolution context.
 *
 * All fields that influence how the governance policy is resolved
 * and snapshot-frozen at session creation time.
 */
export interface HydratePolicyInput {
  readonly policyMode?: string;
  readonly requestedPolicyMode?: PolicyMode;
  readonly effectiveGateBehavior?: EffectiveGateBehavior;
  readonly policyDegradedReason?: PolicyDegradedReason;
  readonly policySource?: PolicySource;
  readonly policyResolutionReason?: PolicyResolutionReason;
  readonly centralMinimumMode?: CentralMinimumMode;
  readonly policyDigest?: string;
  readonly policyVersion?: string;
  readonly policyPathHint?: string;
  readonly maxSelfReviewIterations?: number;
  readonly maxImplReviewIterations?: number;
  readonly requireVerifiedActorsForApproval?: boolean;
  readonly identityProvider?: IdpConfig;
  readonly identityProviderMode?: IdentityProviderMode;
  readonly minimumActorAssuranceForApproval?: 'best_effort' | 'claim_validated' | 'idp_verified';
}

/**
 * Profile resolution and actor identity.
 *
 * Fields that drive profile selection and track the session initiator
 * for regulated four-eyes principle enforcement.
 */
export interface HydrateProfileInput {
  readonly profileId?: string;
  readonly activeChecks?: string[];
  readonly repoSignals?: RepoSignals;
  readonly discoveryResult?: DiscoveryResult;
  readonly initiatedBy?: string;
  readonly initiatedByIdentity?: DecisionIdentity;
  readonly actorInfo?: ActorInfo;
}

/** Composite input for executeHydrate — three cohesive sub-interfaces. */
export interface HydrateInput {
  readonly session: HydrateSessionInput;
  readonly policy: HydratePolicyInput;
  readonly profile: HydrateProfileInput;
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
  const { session: s, policy: p, profile: pr } = input;
  const sessionId = s.sessionId;
  const worktree = s.worktree;
  const fingerprint = s.fingerprint;

  // 1. Validate input
  if (!sessionId.trim()) {
    return blocked('MISSING_SESSION_ID');
  }
  if (!worktree.trim()) {
    return blocked('MISSING_WORKTREE');
  }
  if (!fingerprint || !/^[0-9a-f]{24}$/.test(fingerprint)) {
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
  if (pr.profileId !== undefined) {
    profile = defaultProfileRegistry.get(pr.profileId);
  } else if (pr.repoSignals) {
    profile = defaultProfileRegistry.detect({
      repoSignals: pr.repoSignals,
      discovery: pr.discoveryResult,
    });
  }

  if (!profile) {
    profile = defaultProfileRegistry.get('baseline');
  }

  const activeChecks = pr.activeChecks ??
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
  const policyMode = p.policyMode ?? 'solo';
  let policy = resolvePolicy(policyMode);
  // P31: Apply config overrides
  if (
    p.maxSelfReviewIterations !== undefined ||
    p.maxImplReviewIterations !== undefined ||
    p.requireVerifiedActorsForApproval !== undefined ||
    p.identityProvider !== undefined ||
    p.identityProviderMode !== undefined ||
    p.minimumActorAssuranceForApproval !== undefined
  ) {
    policy = {
      ...policy,
      maxSelfReviewIterations: p.maxSelfReviewIterations ?? policy.maxSelfReviewIterations,
      maxImplReviewIterations: p.maxImplReviewIterations ?? policy.maxImplReviewIterations,
      requireVerifiedActorsForApproval:
        p.requireVerifiedActorsForApproval ?? policy.requireVerifiedActorsForApproval,
      identityProvider: p.identityProvider ?? policy.identityProvider,
      identityProviderMode: p.identityProviderMode ?? policy.identityProviderMode,
      minimumActorAssuranceForApproval:
        p.minimumActorAssuranceForApproval ?? policy.minimumActorAssuranceForApproval,
    };
  }
  const now = ctx.now();
  const snapshotWithContext = createPolicySnapshot(policy, now, ctx.digest, {
    requestedMode: p.requestedPolicyMode ?? policy.mode,
    source: p.policySource ?? 'default',
    effectiveGateBehavior:
      p.effectiveGateBehavior ?? (policy.requireHumanGates ? 'human_gated' : 'auto_approve'),
    degradedReason: p.policyDegradedReason,
    resolutionReason: p.policyResolutionReason,
    centralMinimumMode: p.centralMinimumMode,
    policyDigest: p.policyDigest,
    policyVersion: p.policyVersion,
    policyPathHint: p.policyPathHint,
  });

  // 5. Create binding
  const binding: BindingInfo = {
    sessionId: sessionId,
    worktree: worktree,
    fingerprint: fingerprint,
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
    initiatedBy: pr.initiatedBy ?? sessionId,
    ...(pr.initiatedByIdentity ? { initiatedByIdentity: pr.initiatedByIdentity } : {}),
    ...(pr.actorInfo ? { actorInfo: pr.actorInfo } : {}),

    // Discovery
    discoveryDigest: s.discoveryDigest ?? null,
    discoverySummary: s.discoverySummary ?? null,
    detectedStack: s.detectedStack ?? null,
    verificationCandidates: s.verificationCandidates ?? [],

    // Metadata
    transition: null,
    error: null,
    createdAt: now,
  };

  // 7. Evaluate (will be "pending" at READY — waiting for flow selection)
  const result = evaluate(newState, ctx.policy);

  return { kind: 'ok', state: newState, evalResult: result, transitions: [] };
}
