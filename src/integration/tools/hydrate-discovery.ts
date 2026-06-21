/** @module integration/tools/hydrate-discovery */

import { existsSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { throwHydrateError } from './hydrate-errors.js';
import type {
  ReadRepoFile,
  HydrateConfig,
  HydrateWorkspace,
  DiscoveryHydration,
  ResolveDiscoveryHydrationInput,
  HydrateArgs,
} from './hydrate.js';
import {
  runDiscovery,
  extractDiscoverySummary,
  extractDetectedStack,
  computeDiscoveryDigest,
} from '../../discovery/orchestrator.js';
import type { DiscoveryResult, ProfileResolution } from '../../discovery/types.js';
import { PROFILE_RESOLUTION_SCHEMA_VERSION } from '../../discovery/types.js';
import { planVerificationCandidates } from '../../discovery/verification-planner.js';
import {
  writeDiscovery,
  writeProfileResolution,
  writeDiscoverySnapshot,
  writeProfileResolutionSnapshot,
} from '../../adapters/persistence-discovery.js';
import { listRepoSignals } from '../../adapters/git.js';
import { defaultProfileRegistry as profileRegistryForResolution } from '../../config/profile.js';
import type { FlowGuardProfile, RepoSignals } from '../../config/profile.js';

export function requireDiscoveryContract(
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

export function requireDiscoveryArtifacts(wsDir: string, sessDir: string): void {
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

export function formatPersistError(prefix: string, err: unknown): string {
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

export async function runRequiredDiscovery(
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
      packageFilePaths: repoSignals.packageFilePaths,
      configFilePaths: repoSignals.configFilePaths,
    });
  } catch (err) {
    throwHydrateError(
      'DISCOVERY_RESULT_MISSING',
      formatPersistError('Discovery failed before producing a result', err),
    );
  }
}

export async function writeRequiredDiscovery(wsDir: string, discoveryResult: DiscoveryResult) {
  try {
    await writeDiscovery(wsDir, discoveryResult);
  } catch (err) {
    throwHydrateError(
      'DISCOVERY_PERSIST_FAILED',
      formatPersistError('Failed to persist discovery.json', err),
    );
  }
}

export async function writeRequiredProfileResolution(
  wsDir: string,
  profileResolution: ProfileResolution,
) {
  try {
    await writeProfileResolution(wsDir, profileResolution);
  } catch (err) {
    throwHydrateError(
      'PROFILE_RESOLUTION_PERSIST_FAILED',
      formatPersistError('Failed to persist profile-resolution.json', err),
    );
  }
}

export async function writeRequiredDiscoverySnapshot(
  sessDir: string,
  discoveryResult: DiscoveryResult,
) {
  try {
    await writeDiscoverySnapshot(sessDir, discoveryResult);
  } catch (err) {
    throwHydrateError(
      'DISCOVERY_PERSIST_FAILED',
      formatPersistError('Failed to persist discovery snapshot', err),
    );
  }
}

export async function writeRequiredProfileSnapshot(
  sessDir: string,
  profileResolution: ProfileResolution,
) {
  try {
    await writeProfileResolutionSnapshot(sessDir, profileResolution);
  } catch (err) {
    throwHydrateError(
      'PROFILE_RESOLUTION_PERSIST_FAILED',
      formatPersistError('Failed to persist profile-resolution snapshot', err),
    );
  }
}

export function requireProfile(profileId: string, source: string): FlowGuardProfile {
  const profile = profileRegistryForResolution.get(profileId);
  if (!profile) {
    const sourceText = source ? ` ${source}` : '';
    throwHydrateError('INVALID_PROFILE', `Profile "${profileId}"${sourceText} is not registered.`);
  }
  return profile;
}

export function resolveConfiguredProfile(config: HydrateConfig): FlowGuardProfile | null {
  const configDefaultProfileId = config.profile.defaultId;
  if (!configDefaultProfileId) return null;
  return requireProfile(configDefaultProfileId, 'from config');
}

export function selectProfile(
  args: HydrateArgs,
  configProfile: FlowGuardProfile | null,
  detectedProfile: FlowGuardProfile | null | undefined,
): FlowGuardProfile | undefined {
  if (args.profileId !== undefined) return requireProfile(args.profileId, '');
  return configProfile ?? detectedProfile ?? profileRegistryForResolution.get('baseline');
}

export function collectProfileCandidates(
  detectionInput: { repoSignals: RepoSignals; discovery: DiscoveryResult },
  selectedProfile: FlowGuardProfile | undefined,
): Pick<ProfileResolution, 'secondary' | 'rejected'> {
  const secondary: ProfileResolution['secondary'] = [];
  const rejected: ProfileResolution['rejected'] = [];

  for (const pid of profileRegistryForResolution.ids()) {
    const profile = profileRegistryForResolution.get(pid);
    if (!profile?.detect || profile.id === selectedProfile?.id) continue;
    const score = profile.detect(detectionInput);
    const evidence = buildProfileEvidence(profile, detectionInput);
    if (score > 0)
      secondary.push({ id: profile.id, name: profile.name, confidence: score, evidence });
    else
      rejected.push({
        id: profile.id,
        score: 0,
        reason:
          evidence.length > 0
            ? `Checked signals [${evidence.join(', ')}] — none matched`
            : 'No matching signals',
      });
  }

  return { secondary, rejected };
}

/**
 * Build concrete evidence strings for a profile detection decision.
 *
 * Inspects the detection input for signals relevant to the profile's checks
 * (files, package manifests, config files, discovered stack).
 */
export function buildProfileEvidence(
  profile: FlowGuardProfile,
  detectionInput: { repoSignals: RepoSignals; discovery: DiscoveryResult },
): string[] {
  const evidence: string[] = [];
  const { repoSignals, discovery } = detectionInput;
  const profileId = profile.id.toLowerCase();

  // Check for matching package files using a keyword-to-manifest map
  const manifestSignals: Record<string, string[]> = {
    java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    node: ['package.json'],
    typescript: ['package.json'],
    rust: ['Cargo.toml'],
    go: ['go.mod'],
    python: ['pyproject.toml', 'requirements.txt'],
  };
  for (const [keyword, manifests] of Object.entries(manifestSignals)) {
    if (!profileId.includes(keyword)) continue;
    for (const f of repoSignals.packageFiles) {
      if (manifests.includes(f)) evidence.push(`packageFile:${f}`);
    }
  }

  // Check for matching languages/frameworks in discovered stack
  for (const lang of discovery.stack.languages) {
    if (profileId.includes(lang.id.toLowerCase())) {
      evidence.push(`language:${lang.id}`);
    }
  }
  for (const fw of discovery.stack.frameworks) {
    if (profileId.includes(fw.id.toLowerCase())) {
      evidence.push(`framework:${fw.id}`);
    }
  }

  return evidence;
}

export function buildProfileResolution(
  detectionInput: { repoSignals: RepoSignals; discovery: DiscoveryResult },
  selectedProfile: FlowGuardProfile | undefined,
  config: HydrateConfig,
  resolvedAt: string,
): ProfileResolution {
  const candidates = collectProfileCandidates(detectionInput, selectedProfile);
  const primaryEvidence = selectedProfile
    ? buildProfileEvidence(selectedProfile, detectionInput)
    : [];
  return {
    schemaVersion: PROFILE_RESOLUTION_SCHEMA_VERSION,
    resolvedAt,
    primary: {
      id: selectedProfile?.id ?? 'baseline',
      name: selectedProfile?.name ?? 'Baseline FlowGuard',
      confidence: selectedProfile?.detect?.(detectionInput) ?? 0.1,
      evidence: primaryEvidence,
    },
    secondary: candidates.secondary,
    rejected: candidates.rejected,
    activeChecks: [...(config.profile.activeChecks ?? selectedProfile?.activeChecks ?? [])],
  };
}

export function createReadRepoFile(worktree: string): ReadRepoFile {
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

export async function computeDiscoveryHydration(
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

export async function hydrateDiscoveryForNewSession(
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

export function discoveryForExistingSession(): DiscoveryHydration {
  return {};
}

export async function resolveDiscoveryHydration(
  input: ResolveDiscoveryHydrationInput,
): Promise<DiscoveryHydration> {
  const { existing, worktree, workspace, config, args, resolvedAt } = input;
  if (existing) return discoveryForExistingSession();
  return hydrateDiscoveryForNewSession(worktree, workspace, config, args, resolvedAt);
}
/**
/**
 * Hydrate read-modify-write, serialized under the session write lock (#429).
 *
 * Pre-lock: only pure path/config resolution (worktree, workspace, config) —
 * none of which read session state. Everything that participates in the
 * read-modify-write — the fresh state read, policy/discovery/actor resolution,
 * the pure executeHydrate, the Discovery-health reconcile, and the final
 * write — runs INSIDE the lock so a concurrent mutable transaction cannot
 * interleave and be lost (the prior defect read state with no lock and only
 * acquired it at write time).
 *
 * The lock is intentionally held across discovery/git for the duration of the
 * transaction; the 10s acquisition timeout in the lock adapter is the
 * fail-closed compensation (mapped to SESSION_LOCK_CONTENDED by the caller).
 */
