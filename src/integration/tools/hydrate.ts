/**
 * @module integration/tools/hydrate
 * @description FlowGuard hydrate tool — bootstrap or reload session.
 *
 * This is the entry point for every FlowGuard workflow. Creates a new session
 * if none exists, runs repository discovery, resolves the governance profile,
 * and returns the session state.
 *
 * @version v3
 */

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';

import type { ToolContext, ToolDefinition, ToolResult } from './helpers.js';
import {
  getWorktree,
  resolvePolicyFromState,
  createPolicyContext,
  persistAndFormat,
  formatBlocked,
  formatError,
  appendNextAction,
} from './helpers.js';

// Rails
import { executeHydrate } from '../../rails/hydrate.js';
import type { HydrateInput, HydratePolicyInput, HydrateProfileInput } from '../../rails/hydrate.js';

// Adapters
import { readState } from '../../adapters/persistence.js';
import { listRepoSignals } from '../../adapters/git.js';
import {
  readConfig,
  writeDiscovery,
  writeProfileResolution,
  writeDiscoverySnapshot,
  writeProfileResolutionSnapshot,
} from '../../adapters/persistence.js';

// Workspace
import { initWorkspace, writeSessionPointer } from '../../adapters/workspace/index.js';

// Actor identity (P27)
import { resolveActor, ActorClaimError } from '../../adapters/actor.js';

// Discovery
import {
  runDiscovery,
  extractDiscoverySummary,
  extractDetectedStack,
  computeDiscoveryDigest,
} from '../../discovery/orchestrator.js';
import type { DiscoveryResult, ProfileResolution, DetectedStack } from '../../discovery/types.js';
import { PROFILE_RESOLUTION_SCHEMA_VERSION } from '../../discovery/types.js';
import { planVerificationCandidates } from '../../discovery/verification-planner.js';
import { defaultProfileRegistry as profileRegistryForResolution } from '../../config/profile.js';
import type { FlowGuardProfile, RepoSignals } from '../../config/profile.js';

// Config
import {
  detectCiContext,
  resolvePolicyForHydrate,
  validateExistingPolicyAgainstCentral,
} from '../../config/policy.js';

function throwHydrateError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

type ExistingHydrateState = Awaited<ReturnType<typeof readState>>;
type HydrateConfig = Awaited<ReturnType<typeof readConfig>>;
type HydratePolicyResolution = Awaited<ReturnType<typeof resolvePolicyForHydrate>>;
type HydrateArgs = { policyMode?: string; profileId?: string };
type HydrateWorkspace = Awaited<ReturnType<typeof initWorkspace>>;
type HydratePolicyContext = Awaited<ReturnType<typeof resolveHydratePolicy>>;
type ReadRepoFile = (relativePath: string) => Promise<string | undefined>;
type ExistingCentralEvidence = NonNullable<
  Awaited<ReturnType<typeof validateExistingPolicyAgainstCentral>>
>;

interface DiscoveryHydration {
  readonly repoSignals?: RepoSignals;
  readonly discoveryResult?: DiscoveryResult;
  readonly discoveryDigest?: string;
  readonly discoverySummary?: ReturnType<typeof extractDiscoverySummary>;
  readonly detectedStack?: DetectedStack | null;
  readonly verificationCandidates?: Awaited<ReturnType<typeof planVerificationCandidates>>;
  readonly profileResolution?: ProfileResolution;
}

interface ResolveDiscoveryHydrationInput {
  readonly existing: ExistingHydrateState;
  readonly worktree: string;
  readonly workspace: HydrateWorkspace;
  readonly config: HydrateConfig;
  readonly args: HydrateArgs;
  readonly resolvedAt: string;
}

interface BuildHydrateInputParams {
  readonly context: ToolContext;
  readonly worktree: string;
  readonly workspace: HydrateWorkspace;
  readonly policyContext: HydratePolicyContext;
  readonly config: HydrateConfig;
  readonly discovery: DiscoveryHydration;
  readonly actorInfo: Awaited<ReturnType<typeof resolveActor>>;
}

function digestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function resolveCentralEvidenceForExisting(existing: ExistingHydrateState) {
  if (!existing) return undefined;
  return validateExistingPolicyAgainstCentral({
    existingMode: existing.policySnapshot.mode as 'solo' | 'team' | 'team-ci' | 'regulated',
    centralPolicyPath: process.env.FLOWGUARD_POLICY_PATH,
    digestFn: digestText,
  });
}

function mergeCentralEvidence(
  existing: ExistingHydrateState,
  centralEvidence: ExistingCentralEvidence | undefined,
) {
  if (!existing || !centralEvidence) return existing;
  return {
    ...existing,
    policySnapshot: {
      ...existing.policySnapshot,
      centralMinimumMode: centralEvidence.minimumMode,
      policyDigest: centralEvidence.digest,
      policyVersion: centralEvidence.version,
      policyPathHint: centralEvidence.pathHint,
    },
  };
}

function snapshotCentralEvidence(existing: NonNullable<ExistingHydrateState>) {
  if (!existing.policySnapshot.centralMinimumMode) return undefined;
  return {
    minimumMode: existing.policySnapshot.centralMinimumMode,
    digest: existing.policySnapshot.policyDigest ?? '',
    ...(existing.policySnapshot.policyVersion
      ? { version: existing.policySnapshot.policyVersion }
      : {}),
    pathHint: existing.policySnapshot.policyPathHint ?? 'basename:unknown',
  };
}

function resolveExistingPolicyResolution(
  existing: NonNullable<ExistingHydrateState>,
  centralEvidenceForExisting: Awaited<ReturnType<typeof validateExistingPolicyAgainstCentral>>,
): HydratePolicyResolution {
  return {
    requestedMode: existing.policySnapshot.requestedMode as
      | 'solo'
      | 'team'
      | 'team-ci'
      | 'regulated',
    requestedSource: (existing.policySnapshot.source ?? 'default') as
      | 'explicit'
      | 'repo'
      | 'default',
    effectiveMode: existing.policySnapshot.mode as 'solo' | 'team' | 'team-ci' | 'regulated',
    effectiveSource: existing.policySnapshot.source ?? 'default',
    effectiveGateBehavior: existing.policySnapshot.effectiveGateBehavior,
    degradedReason: existing.policySnapshot.degradedReason as 'ci_context_missing' | undefined,
    policy: resolvePolicyFromState(existing),
    resolutionReason: existing.policySnapshot.resolutionReason as
      | 'repo_weaker_than_central'
      | 'default_weaker_than_central'
      | 'explicit_stronger_than_central'
      | undefined,
    centralEvidence: centralEvidenceForExisting ?? snapshotCentralEvidence(existing),
  };
}

async function resolveNewPolicyResolution(config: HydrateConfig, args: { policyMode?: string }) {
  return resolvePolicyForHydrate({
    explicitMode: args.policyMode as 'solo' | 'team' | 'team-ci' | 'regulated' | undefined,
    repoMode: config.policy.defaultMode,
    defaultMode: 'solo',
    ciContext: detectCiContext(),
    centralPolicyPath: process.env.FLOWGUARD_POLICY_PATH,
    digestFn: digestText,
    configMaxSelfReviewIterations: config.policy.maxSelfReviewIterations,
    configMaxImplReviewIterations: config.policy.maxImplReviewIterations,
    configRequireVerifiedActorsForApproval: config.policy.requireVerifiedActorsForApproval,
    configMinimumActorAssuranceForApproval: config.policy.minimumActorAssuranceForApproval,
    configIdentityProvider: config.policy.identityProvider,
    configIdentityProviderMode: config.policy.identityProviderMode,
  });
}

async function resolveHydratePolicy(
  existing: ExistingHydrateState,
  config: HydrateConfig,
  args: { policyMode?: string },
) {
  const centralEvidenceForExisting = await resolveCentralEvidenceForExisting(existing);
  const existingWithCentralEvidence = mergeCentralEvidence(existing, centralEvidenceForExisting);
  const policyResolution = existing
    ? resolveExistingPolicyResolution(existing, centralEvidenceForExisting)
    : await resolveNewPolicyResolution(config, args);
  const policy = existing
    ? resolvePolicyFromState(existingWithCentralEvidence ?? existing)
    : policyResolution.policy;
  const ctx = createPolicyContext(policy);
  return { policy, policyResolution, ctx, existingWithCentralEvidence, centralEvidenceForExisting };
}

function requireDiscoveryContract(
  discoveryDigest: string | undefined,
  discoverySummary: ReturnType<typeof extractDiscoverySummary> | undefined,
): void {
  if (!discoveryDigest || !discoverySummary) {
    throwHydrateError(
      'HYDRATE_DISCOVERY_CONTRACT_FAILED',
      'Hydrate cannot enter READY without persisted discoveryDigest and discoverySummary',
    );
  }
}

function requireDiscoveryArtifacts(wsDir: string, sessDir: string): void {
  const required = [
    `${wsDir}/discovery/discovery.json`,
    `${wsDir}/discovery/profile-resolution.json`,
    `${sessDir}/discovery-snapshot.json`,
    `${sessDir}/profile-resolution-snapshot.json`,
  ];

  for (const filePath of required) {
    if (!existsSync(filePath)) {
      throwHydrateError(
        'HYDRATE_DISCOVERY_CONTRACT_FAILED',
        `Hydrate discovery contract failed: missing artifact ${filePath}`,
      );
    }
  }
}

function formatPersistError(prefix: string, err: unknown): string {
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

async function runRequiredDiscovery(
  worktree: string,
  fingerprint: string,
  repoSignals: RepoSignals,
): Promise<DiscoveryResult> {
  try {
    return await runDiscovery({
      worktreePath: worktree,
      fingerprint,
      allFiles: repoSignals.files,
      packageFiles: repoSignals.packageFiles,
      configFiles: repoSignals.configFiles,
    });
  } catch (err) {
    throwHydrateError(
      'DISCOVERY_RESULT_MISSING',
      formatPersistError('Discovery failed before producing a result', err),
    );
  }
}

async function writeRequiredDiscovery(wsDir: string, discoveryResult: DiscoveryResult) {
  try {
    await writeDiscovery(wsDir, discoveryResult);
  } catch (err) {
    throwHydrateError(
      'DISCOVERY_PERSIST_FAILED',
      formatPersistError('Failed to persist discovery.json', err),
    );
  }
}

async function writeRequiredProfileResolution(wsDir: string, profileResolution: ProfileResolution) {
  try {
    await writeProfileResolution(wsDir, profileResolution);
  } catch (err) {
    throwHydrateError(
      'PROFILE_RESOLUTION_PERSIST_FAILED',
      formatPersistError('Failed to persist profile-resolution.json', err),
    );
  }
}

async function writeRequiredDiscoverySnapshot(sessDir: string, discoveryResult: DiscoveryResult) {
  try {
    await writeDiscoverySnapshot(sessDir, discoveryResult);
  } catch (err) {
    throwHydrateError(
      'DISCOVERY_PERSIST_FAILED',
      formatPersistError('Failed to persist discovery snapshot', err),
    );
  }
}

async function writeRequiredProfileSnapshot(sessDir: string, profileResolution: ProfileResolution) {
  try {
    await writeProfileResolutionSnapshot(sessDir, profileResolution);
  } catch (err) {
    throwHydrateError(
      'PROFILE_RESOLUTION_PERSIST_FAILED',
      formatPersistError('Failed to persist profile-resolution snapshot', err),
    );
  }
}

function requireProfile(profileId: string, source: string): FlowGuardProfile {
  const profile = profileRegistryForResolution.get(profileId);
  if (!profile) {
    const sourceText = source ? ` ${source}` : '';
    throwHydrateError('INVALID_PROFILE', `Profile "${profileId}"${sourceText} is not registered.`);
  }
  return profile;
}

function resolveConfiguredProfile(config: HydrateConfig): FlowGuardProfile | null {
  const configDefaultProfileId = config.profile.defaultId;
  if (!configDefaultProfileId) return null;
  return requireProfile(configDefaultProfileId, 'from config');
}

function selectProfile(
  args: HydrateArgs,
  configProfile: FlowGuardProfile | null,
  detectedProfile: FlowGuardProfile | null | undefined,
): FlowGuardProfile | undefined {
  if (args.profileId !== undefined) return requireProfile(args.profileId, '');
  return configProfile ?? detectedProfile ?? profileRegistryForResolution.get('baseline');
}

function collectProfileCandidates(
  detectionInput: { repoSignals: RepoSignals; discovery: DiscoveryResult },
  selectedProfile: FlowGuardProfile | undefined,
): Pick<ProfileResolution, 'secondary' | 'rejected'> {
  const secondary: ProfileResolution['secondary'] = [];
  const rejected: ProfileResolution['rejected'] = [];

  for (const pid of profileRegistryForResolution.ids()) {
    const profile = profileRegistryForResolution.get(pid);
    if (!profile?.detect || profile.id === selectedProfile?.id) continue;
    const score = profile.detect(detectionInput);
    if (score > 0)
      secondary.push({ id: profile.id, name: profile.name, confidence: score, evidence: [] });
    else rejected.push({ id: profile.id, score: 0, reason: 'No matching signals' });
  }

  return { secondary, rejected };
}

function buildProfileResolution(
  detectionInput: { repoSignals: RepoSignals; discovery: DiscoveryResult },
  selectedProfile: FlowGuardProfile | undefined,
  config: HydrateConfig,
  resolvedAt: string,
): ProfileResolution {
  const candidates = collectProfileCandidates(detectionInput, selectedProfile);
  return {
    schemaVersion: PROFILE_RESOLUTION_SCHEMA_VERSION,
    resolvedAt,
    primary: {
      id: selectedProfile?.id ?? 'baseline',
      name: selectedProfile?.name ?? 'Baseline FlowGuard',
      confidence: selectedProfile?.detect?.(detectionInput) ?? 0.1,
      evidence: [],
    },
    secondary: candidates.secondary,
    rejected: candidates.rejected,
    activeChecks: [
      ...(config.profile.activeChecks ??
        selectedProfile?.activeChecks ?? ['test_quality', 'rollback_safety']),
    ],
  };
}

function createReadRepoFile(worktree: string): ReadRepoFile {
  const resolvedWorktree = nodePath.resolve(worktree);
  return async (relativePath: string): Promise<string | undefined> => {
    try {
      const targetPath = nodePath.resolve(resolvedWorktree, relativePath);
      const inWorktree = targetPath.startsWith(resolvedWorktree + nodePath.sep);
      if (!inWorktree && targetPath !== resolvedWorktree) return undefined;
      return await fsReadFile(targetPath, 'utf8');
    } catch {
      return undefined;
    }
  };
}

async function computeDiscoveryHydration(
  discoveryResult: DiscoveryResult,
  repoSignals: RepoSignals,
  readRepoFile: ReadRepoFile,
) {
  const discoveryDigest = computeDiscoveryDigest(discoveryResult);
  const discoverySummary = extractDiscoverySummary(discoveryResult);
  const detectedStack = await extractDetectedStack(
    discoveryResult,
    repoSignals.files,
    readRepoFile,
  );
  const verificationCandidates = await planVerificationCandidates({
    detectedStack,
    allFiles: repoSignals.files,
    readFile: readRepoFile,
  });
  return { discoveryDigest, discoverySummary, detectedStack, verificationCandidates };
}

async function hydrateDiscoveryForNewSession(
  worktree: string,
  workspace: HydrateWorkspace,
  config: HydrateConfig,
  args: HydrateArgs,
  resolvedAt: string,
): Promise<DiscoveryHydration> {
  const repoSignals = await listRepoSignals(worktree);
  if (!repoSignals) {
    throwHydrateError(
      'DISCOVERY_RESULT_MISSING',
      'Discovery requires repository signals on first hydrate, but none were available',
    );
  }

  const discoveryResult = await runRequiredDiscovery(worktree, workspace.fingerprint, repoSignals);
  await writeRequiredDiscovery(workspace.workspaceDir, discoveryResult);
  const detectionInput = { repoSignals, discovery: discoveryResult };
  const detectedProfile = profileRegistryForResolution.detect(detectionInput);
  const selectedProfile = selectProfile(args, resolveConfiguredProfile(config), detectedProfile);
  const profileResolution = buildProfileResolution(
    detectionInput,
    selectedProfile,
    config,
    resolvedAt,
  );
  await writeRequiredProfileResolution(workspace.workspaceDir, profileResolution);
  await writeRequiredDiscoverySnapshot(workspace.sessionDir, discoveryResult);
  await writeRequiredProfileSnapshot(workspace.sessionDir, profileResolution);

  const hydration = await computeDiscoveryHydration(
    discoveryResult,
    repoSignals,
    createReadRepoFile(worktree),
  );
  requireDiscoveryContract(hydration.discoveryDigest, hydration.discoverySummary);
  requireDiscoveryArtifacts(workspace.workspaceDir, workspace.sessionDir);
  return { repoSignals, discoveryResult, profileResolution, ...hydration };
}

function discoveryForExistingSession(): DiscoveryHydration {
  return {};
}

async function resolveDiscoveryHydration(
  input: ResolveDiscoveryHydrationInput,
): Promise<DiscoveryHydration> {
  const { existing, worktree, workspace, config, args, resolvedAt } = input;
  if (existing) return discoveryForExistingSession();
  return hydrateDiscoveryForNewSession(worktree, workspace, config, args, resolvedAt);
}

function buildExistingPolicyInput(
  existing: NonNullable<ExistingHydrateState>,
  centralEvidenceForExisting: ExistingCentralEvidence | undefined,
): HydratePolicyInput {
  return {
    policyMode: existing.policySnapshot.mode,
    requestedPolicyMode: existing.policySnapshot.requestedMode as
      | 'solo'
      | 'team'
      | 'team-ci'
      | 'regulated',
    policySource: existing.policySnapshot.source ?? 'default',
    effectiveGateBehavior: existing.policySnapshot.effectiveGateBehavior,
    policyDegradedReason: existing.policySnapshot.degradedReason as
      | 'ci_context_missing'
      | undefined,
    policyResolutionReason: existing.policySnapshot.resolutionReason as
      | 'repo_weaker_than_central'
      | 'default_weaker_than_central'
      | 'explicit_stronger_than_central'
      | undefined,
    centralMinimumMode:
      centralEvidenceForExisting?.minimumMode ?? existing.policySnapshot.centralMinimumMode,
    policyDigest: centralEvidenceForExisting?.digest ?? existing.policySnapshot.policyDigest,
    policyVersion: centralEvidenceForExisting
      ? centralEvidenceForExisting.version
      : existing.policySnapshot.policyVersion,
    policyPathHint: centralEvidenceForExisting?.pathHint ?? existing.policySnapshot.policyPathHint,
  };
}

function buildNewPolicyInput(
  policyResolution: HydratePolicyResolution,
  config: HydrateConfig,
): HydratePolicyInput {
  return {
    policyMode: policyResolution.effectiveMode,
    requestedPolicyMode: policyResolution.requestedMode,
    policySource: policyResolution.effectiveSource,
    effectiveGateBehavior: policyResolution.effectiveGateBehavior,
    policyDegradedReason: policyResolution.degradedReason,
    policyResolutionReason: policyResolution.resolutionReason,
    centralMinimumMode: policyResolution.centralEvidence?.minimumMode,
    policyDigest: policyResolution.centralEvidence?.digest,
    policyVersion: policyResolution.centralEvidence?.version,
    policyPathHint: policyResolution.centralEvidence?.pathHint,
    maxSelfReviewIterations: config.policy.maxSelfReviewIterations,
    maxImplReviewIterations: config.policy.maxImplReviewIterations,
    requireVerifiedActorsForApproval: config.policy.requireVerifiedActorsForApproval,
    identityProvider: config.policy.identityProvider,
    identityProviderMode: config.policy.identityProviderMode,
    minimumActorAssuranceForApproval: config.policy.minimumActorAssuranceForApproval,
    policyResolution,
  };
}

function buildPolicyInput(
  existing: ExistingHydrateState,
  policyResolution: HydratePolicyResolution,
  config: HydrateConfig,
  centralEvidenceForExisting: ExistingCentralEvidence | undefined,
): HydratePolicyInput {
  if (existing) return buildExistingPolicyInput(existing, centralEvidenceForExisting);
  return buildNewPolicyInput(policyResolution, config);
}

function buildProfileInput(
  existing: ExistingHydrateState,
  discovery: DiscoveryHydration,
  config: HydrateConfig,
  actorInfo: Awaited<ReturnType<typeof resolveActor>>,
): HydrateProfileInput {
  return {
    profileId: existing
      ? existing.activeProfile?.id
      : (discovery.profileResolution?.primary?.id ?? 'baseline'),
    activeChecks: existing ? undefined : config.profile.activeChecks,
    repoSignals: discovery.repoSignals,
    discoveryResult: discovery.discoveryResult,
    initiatedBy: actorInfo.id,
    initiatedByIdentity: {
      actorId: actorInfo.id,
      actorEmail: actorInfo.email,
      actorSource: actorInfo.source,
      actorAssurance: actorInfo.assurance,
    },
    actorInfo,
  };
}

function buildHydrateInput(params: BuildHydrateInputParams): HydrateInput {
  const { context, worktree, workspace, policyContext, config, discovery, actorInfo } = params;
  const { existingWithCentralEvidence, centralEvidenceForExisting, policyResolution } =
    policyContext;
  return {
    session: {
      sessionId: context.sessionID,
      worktree,
      fingerprint: workspace.fingerprint,
      discoveryDigest: discovery.discoveryDigest,
      discoverySummary: discovery.discoverySummary,
      detectedStack: discovery.detectedStack,
      verificationCandidates: discovery.verificationCandidates,
    },
    policy: buildPolicyInput(
      existingWithCentralEvidence,
      policyResolution,
      config,
      centralEvidenceForExisting,
    ),
    profile: buildProfileInput(existingWithCentralEvidence, discovery, config, actorInfo),
  };
}

async function formatNewSessionResponse(
  sessDir: string,
  result: Extract<ReturnType<typeof executeHydrate>, { kind: 'ok' }>,
  discovery: DiscoveryHydration,
  policyResolution: HydratePolicyResolution,
): Promise<ToolResult> {
  const state = result.state;
  const formattedResult = await persistAndFormat(sessDir, result);
  const outputStr =
    typeof formattedResult === 'object' && 'output' in formattedResult
      ? formattedResult.output
      : formattedResult;
  const formatted = JSON.parse(outputStr) as Record<string, unknown>;
  const response: Record<string, unknown> = {
    ...formatted,
    profileId: state.activeProfile?.id ?? 'baseline',
    profileName: state.activeProfile?.name ?? 'Baseline Governance',
    profileDetected: !!discovery.repoSignals,
    discoveryComplete: !!discovery.discoveryResult,
    discoverySummary: discovery.discoverySummary ?? null,
    policyResolution: formatPolicyResolution(policyResolution),
  };
  return appendNextAction(JSON.stringify(response), state);
}

function formatPolicyResolution(
  policyResolution: HydratePolicyResolution,
): Record<string, unknown> {
  return {
    requestedMode: policyResolution.requestedMode,
    effectiveMode: policyResolution.effectiveMode,
    source: policyResolution.effectiveSource,
    effectiveGateBehavior: policyResolution.effectiveGateBehavior,
    reason: policyResolution.degradedReason ?? null,
    resolutionReason: policyResolution.resolutionReason ?? null,
    centralMinimumMode: policyResolution.centralEvidence?.minimumMode ?? null,
    centralPolicyDigest: policyResolution.centralEvidence?.digest ?? null,
    centralPolicyVersion: policyResolution.centralEvidence?.version ?? null,
    centralPolicyPathHint: policyResolution.centralEvidence?.pathHint ?? null,
  };
}

async function formatHydrateResult(
  sessDir: string,
  existing: ExistingHydrateState,
  result: ReturnType<typeof executeHydrate>,
  discovery: DiscoveryHydration,
  policyResolution: HydratePolicyResolution,
): Promise<ToolResult> {
  if (result.kind === 'ok' && !existing) {
    return formatNewSessionResponse(sessDir, result, discovery, policyResolution);
  }
  return persistAndFormat(sessDir, result);
}

async function runHydrate(args: HydrateArgs, context: ToolContext): Promise<ToolResult> {
  const worktree = getWorktree(context);
  const workspace = await initWorkspace(worktree, context.sessionID);
  const config = await readConfig(worktree);
  const existing = await readState(workspace.sessionDir);
  const policyContext = await resolveHydratePolicy(existing, config, args);
  const discovery = await resolveDiscoveryHydration({
    existing,
    worktree,
    workspace,
    config,
    args,
    resolvedAt: policyContext.ctx.now(),
  });
  const actorInfo = await resolveActor(worktree);
  const result = executeHydrate(
    policyContext.existingWithCentralEvidence,
    buildHydrateInput({
      context,
      worktree,
      workspace,
      policyContext,
      config,
      discovery,
      actorInfo,
    }),
    policyContext.ctx,
  );
  writeSessionPointer(workspace.fingerprint, context.sessionID, workspace.sessionDir).catch(
    () => {},
  );
  return formatHydrateResult(
    workspace.sessionDir,
    existing,
    result,
    discovery,
    policyContext.policyResolution,
  );
}

async function executeHydrateTool(args: HydrateArgs, context: ToolContext): Promise<ToolResult> {
  try {
    return await runHydrate(args, context);
  } catch (err) {
    if (err instanceof ActorClaimError) return formatBlocked(err.code);
    return formatError(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_hydrate — Bootstrap Session
// ═══════════════════════════════════════════════════════════════════════════════

export const hydrate: ToolDefinition = {
  description:
    'Bootstrap or reload the FlowGuard session. Creates a new session if none exists, ' +
    'or returns the existing session unchanged (idempotent). ' +
    'Optionally configure policy mode (solo/team/regulated) and profile. ' +
    'This MUST be the first FlowGuard tool call in any workflow.',
  args: {
    policyMode: z
      .enum(['solo', 'team', 'team-ci', 'regulated'])
      .optional()
      .describe(
        'FlowGuard policy mode. When omitted, reads from repo config ' +
          "(policy.defaultMode), then falls back to 'solo'. " +
          "Priority: explicit arg > config > 'solo'.",
      ),
    profileId: z
      .string()
      .default('baseline')
      .describe("Governance profile ID. Defaults to 'baseline'."),
  },
  async execute(args, context) {
    return executeHydrateTool(args, context);
  },
};
