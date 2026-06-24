import type { resolveActor } from '../../adapters/actor.js';
import type { WorkspaceInfo } from '../../adapters/workspace/index.js';
import type { FlowGuardConfig, HydratePolicyResolution } from '../../config/index.js';
import type { CentralPolicyEvidence, FlowGuardPolicy } from '../../config/policy.js';
import type { RepoSignals } from '../../config/profile.js';
import type { extractDiscoverySummary } from '../../discovery/orchestrator.js';
import type { DetectedStack, DiscoveryResult, ProfileResolution } from '../../discovery/types.js';
import type { planVerificationCandidates } from '../../discovery/verification-planner.js';
import type { RailContext } from '../../rails/types.js';
import type { PolicyMode } from '../../state/policy-mode.js';
import type { SessionState } from '../../state/schema.js';
import type { ToolContext } from './helpers.js';

export type ExistingHydrateState = SessionState | null;
export type HydrateConfig = FlowGuardConfig;
export type { HydratePolicyResolution } from '../../config/index.js';
export type HydrateArgs = {
  policyMode?: PolicyMode;
  profileId?: string;
  claimedTaskClass?: string;
};
export type HydrateWorkspace = {
  info: WorkspaceInfo;
  fingerprint: string;
  sessionDir: string;
  workspaceDir: string;
};
export type ReadRepoFile = (relativePath: string) => Promise<string | undefined>;
export type ExistingCentralEvidence = CentralPolicyEvidence;

export interface DiscoveryHydration {
  readonly repoSignals?: RepoSignals;
  readonly discoveryResult?: DiscoveryResult;
  readonly discoveryDigest?: string;
  readonly discoverySummary?: ReturnType<typeof extractDiscoverySummary>;
  readonly detectedStack?: DetectedStack | null;
  readonly verificationCandidates?: Awaited<ReturnType<typeof planVerificationCandidates>>;
  readonly profileResolution?: ProfileResolution;
}

export interface ResolveDiscoveryHydrationInput {
  readonly existing: ExistingHydrateState;
  readonly worktree: string;
  readonly workspace: HydrateWorkspace;
  readonly config: HydrateConfig;
  readonly args: HydrateArgs;
  readonly resolvedAt: string;
}

export interface HydratePolicyContext {
  readonly policy: FlowGuardPolicy;
  readonly policyResolution: HydratePolicyResolution;
  readonly ctx: RailContext;
  readonly existingWithCentralEvidence: ExistingHydrateState;
  readonly centralEvidenceForExisting?: ExistingCentralEvidence;
}

export interface BuildHydrateInputParams {
  readonly context: ToolContext;
  readonly worktree: string;
  readonly workspace: HydrateWorkspace;
  readonly policyContext: HydratePolicyContext;
  readonly config: HydrateConfig;
  readonly discovery: DiscoveryHydration;
  readonly actorInfo: Awaited<ReturnType<typeof resolveActor>>;
  readonly args: HydrateArgs;
  /**
   * Files already dirty at session start with content hashes (captured via git
   * in runHydrate before any editing). Undefined when git was unreadable or for
   * existing sessions.
   */
  readonly baselineDirtyFiles?: ReadonlyArray<{ path: string; hash: string | null }>;
}
