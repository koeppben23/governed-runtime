/**
 * @module hydrate
 * @description /hydrate rail — bootstrap a FlowGuard session.
 *
 * This is the FIRST command in every workflow. It creates or loads the SessionState.
 * Named "hydrate" (not "init") because OpenCode already has /init.
 *
 * Behavior:
 * 1. If state already exists → return it unchanged except explicit risk-class
 *    recovery may update claimedTaskClass (a blocked riskGate is NOT cleared)
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
 * Idempotent: calling /hydrate on an existing session is a no-op unless
 * claimedTaskClass is provided to record an explicit risk-class claim. That
 * recovery may only update claimedTaskClass; it must not rebind the session or
 * rewrite the policy snapshot. A blocked riskGate is fail-closed and is NOT
 * cleared by hydrate — recovering from a blocked risk gate requires a fresh
 * governed session.
 *
 * Special: This is the ONLY rail that accepts `null` as state input.
 *
 * @version v1
 */

import {
  CURRENT_ASSURANCE_EPOCH,
  CURRENT_AUDIT_CHAIN_FORMAT,
  CURRENT_SESSION_STATE_SCHEMA_VERSION,
  CURRENT_STATE_DIGEST_FORMAT,
  type SessionState,
  type TaskClass,
} from '../state/schema.js';
import type { BindingInfo } from '../state/evidence.js';
import { FINGERPRINT_PATTERN } from '../state/evidence.js';
import type { ActorInfo } from '../audit/types.js';
import type { DecisionIdentity } from '../state/evidence.js';
import type { DiscoverySummary } from '../discovery/types.js';
import type { DetectedStack } from '../discovery/types.js';
import type { VerificationCandidates } from '../discovery/types.js';
import type { ExecutionSubjectInput } from '../state/discovery-schemas.js';
import type { IdpConfig, IdentityProviderMode } from '../identity/types.js';
import { evaluate } from '../machine/evaluate.js';
import type { RailResult, RailBlocked, RailContext } from './types.js';
import { blocked } from '../config/reasons.js';
import { defaultProfileRegistry } from '../config/profile.js';
import type { FlowGuardProfile, RepoSignals } from '../config/profile.js';
import type { DiscoveryResult } from '../discovery/types.js';
import { extractBaseInstructions, extractByPhaseInstructions } from '../config/profile.js';
import {
  freezePolicySnapshot,
  getPolicyPreset,
  createPolicySnapshot,
  type FlowGuardPolicy,
} from '../config/policy.js';
import type { EffectiveGateBehavior, PolicyDegradedReason, PolicyMode } from '../config/policy.js';
import type { PolicySource, PolicyResolutionReason, CentralMinimumMode } from '../config/policy.js';
import type { HydratePolicyResolution } from '../config/policy.js';

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
  readonly executionSubjectInputsByKind?: Record<string, ExecutionSubjectInput[]>;
  readonly executionSubjectInputsByCandidateId?: Record<string, ExecutionSubjectInput[]>;
  readonly claimedTaskClass?: TaskClass;
  /**
   * Files already dirty in the worktree at session start (with content hashes),
   * captured by the async tool layer (runHydrate) via git before any editing.
   * Undefined when git could not be read; absence means implement will not
   * scope (records the full worktree, as before) and marks scoping unavailable.
   */
  readonly baselineDirtyFiles?: ReadonlyArray<{ path: string; hash: string | null }>;
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
  readonly enforceRiskClassification?: boolean;
  readonly allowRiskDowngradeOverride?: boolean;
  readonly allowReducedCeremony?: boolean;
  readonly policyResolution?: HydratePolicyResolution;
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
/**
 * Apply config overrides from HydratePolicyInput onto a base FlowGuardPolicy.
 *
 * Centralizes the field-by-field override mapping. When a new governance
 * field is added to FlowGuardPolicy, it only needs to be added here.
 */
export function applyHydrateOverrides(
  base: FlowGuardPolicy,
  p: HydratePolicyInput,
): FlowGuardPolicy {
  return {
    ...base,
    ...(p.maxSelfReviewIterations !== undefined
      ? { maxSelfReviewIterations: p.maxSelfReviewIterations }
      : {}),
    ...(p.maxImplReviewIterations !== undefined
      ? { maxImplReviewIterations: p.maxImplReviewIterations }
      : {}),
    ...(p.requireVerifiedActorsForApproval !== undefined
      ? { requireVerifiedActorsForApproval: p.requireVerifiedActorsForApproval }
      : {}),
    ...(p.identityProvider !== undefined ? { identityProvider: p.identityProvider } : {}),
    ...(p.identityProviderMode !== undefined
      ? { identityProviderMode: p.identityProviderMode }
      : {}),
    ...(p.minimumActorAssuranceForApproval !== undefined
      ? { minimumActorAssuranceForApproval: p.minimumActorAssuranceForApproval }
      : {}),
    ...(p.enforceRiskClassification !== undefined
      ? { enforceRiskClassification: p.enforceRiskClassification }
      : {}),
    ...(p.allowRiskDowngradeOverride !== undefined
      ? { allowRiskDowngradeOverride: p.allowRiskDowngradeOverride }
      : {}),
    ...(p.allowReducedCeremony !== undefined
      ? { allowReducedCeremony: p.allowReducedCeremony }
      : {}),
  };
}

function validateHydrateInput(s: HydrateSessionInput): RailBlocked | null {
  if (!s.sessionId.trim()) return blocked('MISSING_SESSION_ID');
  if (!s.worktree.trim()) return blocked('MISSING_WORKTREE');
  if (!s.fingerprint || !FINGERPRINT_PATTERN.test(s.fingerprint))
    return blocked('INVALID_FINGERPRINT');
  return null;
}

function handleExistingState(
  existingState: SessionState,
  s: HydrateSessionInput,
  ctx: RailContext,
): RailResult {
  const nextState = s.claimedTaskClass
    ? { ...existingState, claimedTaskClass: s.claimedTaskClass }
    : existingState;
  const result = evaluate(nextState, ctx.policy);
  return { kind: 'ok', state: nextState, evalResult: result, transitions: [] };
}

function resolvePolicySnapshot(p: HydratePolicyInput, ctx: RailContext, now: string) {
  if (p.policyResolution) return freezePolicySnapshot(p.policyResolution, now, ctx.digest);
  // NOTE: this preset fallback is only reached by callers that build a
  // HydratePolicyInput WITHOUT a resolved policyResolution (rail-level tests /
  // defensive callers). The production tool path always sets policyResolution
  // and takes the early return above. The user-facing default for /start is
  // resolved one layer up (resolveNewPolicyResolution → defaultMode: 'team').
  const basePolicy = getPolicyPreset(p.policyMode ?? 'solo');
  const policy = applyHydrateOverrides(basePolicy, p);
  return createPolicySnapshot(policy, now, ctx.digest, {
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
}

function resolveProfile(pr: HydrateProfileInput, s: HydrateSessionInput) {
  let profile: FlowGuardProfile | undefined;
  if (pr.profileId !== undefined) profile = defaultProfileRegistry.get(pr.profileId);
  else if (pr.repoSignals)
    profile = defaultProfileRegistry.detect({
      repoSignals: pr.repoSignals,
      discovery: pr.discoveryResult,
    });
  if (!profile) profile = defaultProfileRegistry.get('baseline')!;

  const activeChecks =
    pr.activeChecks && pr.activeChecks.length > 0
      ? pr.activeChecks
      : deriveActiveChecksFromCandidates(s.verificationCandidates);
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
  return { profile, activeChecks, activeProfile };
}

function buildNewHydrateState(
  s: HydrateSessionInput,
  p: HydratePolicyInput,
  pr: HydrateProfileInput,
  ctx: RailContext,
): RailResult {
  const { activeChecks, activeProfile } = resolveProfile(pr, s);

  const now = ctx.now();
  const snapshotWithContext = resolvePolicySnapshot(p, ctx, now);
  const binding: BindingInfo = {
    hostSessionId: s.sessionId,
    worktree: s.worktree,
    fingerprint: s.fingerprint,
    resolvedAt: now,
  };

  const sessionId = crypto.randomUUID();
  const newState: SessionState = {
    id: sessionId,
    flowguardSessionId: sessionId,
    schemaVersion: CURRENT_SESSION_STATE_SCHEMA_VERSION,
    assuranceEpoch: CURRENT_ASSURANCE_EPOCH,
    stateDigestFormat: CURRENT_STATE_DIGEST_FORMAT,
    auditChainFormat: CURRENT_AUDIT_CHAIN_FORMAT,
    phase: 'READY',
    ...(s.claimedTaskClass ? { claimedTaskClass: s.claimedTaskClass } : {}),
    binding,
    ticket: null,
    architecture: null,
    plan: null,
    selfReview: null,
    validation: [],
    validationAttempts: [],
    mutationAttempts: [],
    mutationEpisodes: [],
    mutationEpisodeResolutions: [],
    challengeResolutions: [],
    implValidation: [],
    implementation: null,
    reducedCeremony: null,
    implReview: null,
    reviewDecision: null,
    reviewReportPath: null,
    standaloneReviewEvidence: [],
    nextAdrNumber: 1,
    activeProfile,
    activeChecks,
    policySnapshot: snapshotWithContext,
    initiatedBy: pr.initiatedBy ?? s.sessionId,
    ...(pr.initiatedByIdentity ? { initiatedByIdentity: pr.initiatedByIdentity } : {}),
    ...(pr.actorInfo ? { actorInfo: pr.actorInfo } : {}),
    discoveryDigest: s.discoveryDigest ?? null,
    discoverySummary: s.discoverySummary ?? null,
    detectedStack: s.detectedStack ?? null,
    verificationCandidates: s.verificationCandidates ?? [],
    executionSubjectInputsByKind: s.executionSubjectInputsByKind ?? {},
    executionSubjectInputsByCandidateId: s.executionSubjectInputsByCandidateId ?? {},
    ...(s.baselineDirtyFiles
      ? {
          implementationBaseline: {
            dirtyFiles: s.baselineDirtyFiles.map((d) => ({ path: d.path, hash: d.hash })),
            capturedAt: now,
          },
        }
      : {}),
    transition: null,
    pendingAuditOperations: [],
    error: null,
    createdAt: now,
  };

  const result = evaluate(newState, ctx.policy);
  return { kind: 'ok', state: newState, evalResult: result, transitions: [] };
}

export function executeHydrate(
  existingState: SessionState | null,
  input: HydrateInput,
  ctx: RailContext,
): RailResult {
  const { session: s, policy: p, profile: pr } = input;
  const validationBlock = validateHydrateInput(s);
  if (validationBlock) return validationBlock;
  if (existingState !== null) return handleExistingState(existingState, s, ctx);
  return buildNewHydrateState(s, p, pr, ctx);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive activeChecks from verificationCandidates.
 *
 * Each unique `kind` from the candidates becomes an active check ID.
 * Only kinds that have a discovered command are included (which is all
 * candidates, since verificationCandidates only contains entries with commands).
 *
 * Returns empty array if no candidates — VALIDATION phase is vacuously passed.
 */
function deriveActiveChecksFromCandidates(
  candidates: VerificationCandidates | undefined,
): string[] {
  if (!candidates || candidates.length === 0) return [];
  // Unique kinds, preserving discovery order (deterministic)
  return [...new Set(candidates.map((c) => c.kind))];
}
