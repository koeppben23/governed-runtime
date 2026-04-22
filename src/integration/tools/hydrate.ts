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

import type { ToolDefinition } from './helpers';
import {
  getWorktree,
  resolvePolicyFromState,
  createPolicyContext,
  persistAndFormat,
  formatError,
  appendNextAction,
} from './helpers';

// Rails
import { executeHydrate } from '../../rails/hydrate';

// Adapters
import { readState } from '../../adapters/persistence';
import { listRepoSignals } from '../../adapters/git';
import {
  configPath,
  readConfig,
  PersistenceError,
  writeDefaultConfig,
  writeDiscovery,
  writeProfileResolution,
  writeDiscoverySnapshot,
  writeProfileResolutionSnapshot,
} from '../../adapters/persistence';

// Workspace
import { initWorkspace, writeSessionPointer } from '../../adapters/workspace';

// Actor identity (P27)
import { resolveActor } from '../../adapters/actor';

// Discovery
import {
  runDiscovery,
  extractDiscoverySummary,
  extractDetectedStack,
  computeDiscoveryDigest,
} from '../../discovery/orchestrator';
import type { DiscoveryResult, ProfileResolution, DetectedStack } from '../../discovery/types';
import { PROFILE_RESOLUTION_SCHEMA_VERSION } from '../../discovery/types';
import { planVerificationCandidates } from '../../discovery/verification-planner';
import { defaultProfileRegistry as profileRegistryForResolution } from '../../config/profile';

// Config
import {
  detectCiContext,
  resolvePolicyForHydrate,
  validateExistingPolicyAgainstCentral,
} from '../../config/policy';

function throwHydrateError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

async function ensureWorkspaceConfig(wsDir: string): Promise<void> {
  const filePath = configPath(wsDir);
  if (existsSync(filePath)) {
    try {
      await readConfig(wsDir);
    } catch (err) {
      if (err instanceof PersistenceError) {
        throwHydrateError(
          'WORKSPACE_CONFIG_INVALID',
          `Workspace config is invalid at ${filePath}: ${err.message}`,
        );
      }
      throwHydrateError(
        'WORKSPACE_CONFIG_INVALID',
        `Workspace config is invalid at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  try {
    await writeDefaultConfig(wsDir);
  } catch (err) {
    throwHydrateError(
      'WORKSPACE_CONFIG_WRITE_FAILED',
      `Failed to write workspace config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!existsSync(filePath)) {
    throwHydrateError(
      'WORKSPACE_CONFIG_MISSING',
      `Workspace config is required but missing at ${filePath}`,
    );
  }
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
        'FlowGuard policy mode. When omitted, reads from workspace config ' +
          "(policy.defaultMode), then falls back to 'solo'. " +
          "Priority: explicit arg > config > 'solo'.",
      ),
    profileId: z
      .string()
      .default('baseline')
      .describe("Governance profile ID. Defaults to 'baseline'."),
  },
  async execute(args, context) {
    try {
      const worktree = getWorktree(context);

      // Initialize workspace + session directories (idempotent)
      const wsResult = await initWorkspace(worktree, context.sessionID);
      const { fingerprint, sessionDir: sessDir, workspaceDir: wsDir } = wsResult;

      // Workspace config must be materialized and editable.
      await ensureWorkspaceConfig(wsDir);

      // ── Policy mode resolution ─────────────────────────────────
      // P29 precedence (requested): explicit tool arg > repo config > default.
      // Optional central minimum via FLOWGUARD_POLICY_PATH:
      // - If set: file must exist/read/validate (fail-closed)
      // - If unset: no central override
      const config = await readConfig(wsDir);

      const existing = await readState(sessDir);

      // Resolve policy for context
      const ciContext = detectCiContext();
      const centralEvidenceForExisting = existing
        ? await validateExistingPolicyAgainstCentral({
            existingMode: existing.policySnapshot.mode as 'solo' | 'team' | 'team-ci' | 'regulated',
            centralPolicyPath: process.env.FLOWGUARD_POLICY_PATH,
            digestFn: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
          })
        : undefined;
      const existingWithCentralEvidence =
        existing && centralEvidenceForExisting
          ? {
              ...existing,
              policySnapshot: {
                ...existing.policySnapshot,
                centralMinimumMode: centralEvidenceForExisting.minimumMode,
                policyDigest: centralEvidenceForExisting.digest,
                policyVersion: centralEvidenceForExisting.version,
                policyPathHint: centralEvidenceForExisting.pathHint,
              },
            }
          : existing;
      const policyResolution = existing
        ? {
            requestedMode: existing.policySnapshot.requestedMode as
              | 'solo'
              | 'team'
              | 'team-ci'
              | 'regulated',
            requestedSource: (existing.policySnapshot.source ?? 'default') as
              | 'explicit'
              | 'repo'
              | 'default',
            effectiveMode: existing.policySnapshot.mode as
              | 'solo'
              | 'team'
              | 'team-ci'
              | 'regulated',
            effectiveSource: existing.policySnapshot.source ?? 'default',
            effectiveGateBehavior: existing.policySnapshot.effectiveGateBehavior,
            degradedReason: existing.policySnapshot.degradedReason as
              | 'ci_context_missing'
              | undefined,
            policy: resolvePolicyFromState(existing),
            resolutionReason: existing.policySnapshot.resolutionReason as
              | 'repo_weaker_than_central'
              | 'default_weaker_than_central'
              | 'explicit_stronger_than_central'
              | undefined,
            centralEvidence:
              centralEvidenceForExisting ??
              (existing.policySnapshot.centralMinimumMode
                ? {
                    minimumMode: existing.policySnapshot.centralMinimumMode,
                    digest: existing.policySnapshot.policyDigest ?? '',
                    ...(existing.policySnapshot.policyVersion
                      ? { version: existing.policySnapshot.policyVersion }
                      : {}),
                    pathHint: existing.policySnapshot.policyPathHint ?? 'basename:unknown',
                  }
                : undefined),
          }
        : await resolvePolicyForHydrate({
            explicitMode: args.policyMode,
            repoMode: config.policy.defaultMode,
            defaultMode: 'solo',
            ciContext,
            centralPolicyPath: process.env.FLOWGUARD_POLICY_PATH,
            digestFn: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
            configMaxSelfReviewIterations: config.policy.maxSelfReviewIterations,
            configMaxImplReviewIterations: config.policy.maxImplReviewIterations,
          });
      const policy = existing
        ? resolvePolicyFromState(existingWithCentralEvidence)
        : policyResolution.policy;
      const ctx = createPolicyContext(policy);

      // ── Discovery (only for new sessions) ──────────────────────
      const repoSignals = existing ? undefined : await listRepoSignals(worktree);
      let discoveryResult: DiscoveryResult | undefined;
      let discoveryDigest: string | undefined;
      let discoverySummary: ReturnType<typeof extractDiscoverySummary> | undefined;
      let detectedStack: DetectedStack | null | undefined;
      let verificationCandidates:
        | Awaited<ReturnType<typeof planVerificationCandidates>>
        | undefined;
      let profileResolution: ProfileResolution | undefined;
      if (!existing && !repoSignals) {
        throwHydrateError(
          'DISCOVERY_RESULT_MISSING',
          'Discovery requires repository signals on first hydrate, but none were available',
        );
      }

      if (!existing && repoSignals) {
        // 1. Run discovery orchestrator
        try {
          discoveryResult = await runDiscovery({
            worktreePath: worktree,
            fingerprint,
            allFiles: repoSignals.files,
            packageFiles: repoSignals.packageFiles,
            configFiles: repoSignals.configFiles,
          });
        } catch (err) {
          throwHydrateError(
            'DISCOVERY_RESULT_MISSING',
            `Discovery failed before producing a result: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (!discoveryResult) {
          throwHydrateError('DISCOVERY_RESULT_MISSING', 'Discovery did not return a result');
        }

        // 2. Write workspace-level discovery
        try {
          await writeDiscovery(wsDir, discoveryResult);
        } catch (err) {
          throwHydrateError(
            'DISCOVERY_PERSIST_FAILED',
            `Failed to persist discovery.json: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // 3. Profile resolution with explicit > config > detected > baseline priority (P31)
        const detectionInput = { repoSignals, discovery: discoveryResult };
        const explicitProfileId = args.profileId;
        const configDefaultProfileId = config.profile.defaultId;
        const configDefaultProfile = configDefaultProfileId
          ? profileRegistryForResolution.get(configDefaultProfileId)
          : null;
        const detectedProfile = profileRegistryForResolution.detect(detectionInput);

        if (configDefaultProfileId && !configDefaultProfile) {
          throwHydrateError(
            'INVALID_PROFILE',
            `Profile "${configDefaultProfileId}" from config is not registered.`,
          );
        }

        // Validate explicit profileId if provided
        if (explicitProfileId !== undefined) {
          const explicitProfileLookup = profileRegistryForResolution.get(explicitProfileId);
          if (!explicitProfileLookup) {
            throwHydrateError(
              'INVALID_PROFILE',
              `Profile "${explicitProfileId}" is not registered.`,
            );
          }
        }

        // P31 priority: explicit > config > detected > baseline
        const selectedProfile = explicitProfileId !== undefined
          ? profileRegistryForResolution.get(explicitProfileId)
          : configDefaultProfile ?? detectedProfile ?? profileRegistryForResolution.get('baseline');

        // 4. Build profile resolution (including rejected candidates)
        const allCandidates: ProfileResolution['secondary'] = [];
        const rejectedCandidates: ProfileResolution['rejected'] = [];

        for (const pid of profileRegistryForResolution.ids()) {
          const p = profileRegistryForResolution.get(pid);
          if (!p?.detect) continue;
          const score = p.detect(detectionInput);
          if (p.id === selectedProfile?.id) continue;
          if (score > 0) {
            allCandidates.push({
              id: p.id,
              name: p.name,
              confidence: score,
              evidence: [],
            });
          } else {
            rejectedCandidates.push({
              id: p.id,
              score: 0,
              reason: 'No matching signals',
            });
          }
        }

        profileResolution = {
          schemaVersion: PROFILE_RESOLUTION_SCHEMA_VERSION,
          resolvedAt: ctx.now(),
          primary: {
            id: selectedProfile?.id ?? 'baseline',
            name: selectedProfile?.name ?? 'Baseline FlowGuard',
            confidence: selectedProfile?.detect?.(detectionInput) ?? 0.1,
            evidence: [],
          },
          secondary: allCandidates,
          rejected: rejectedCandidates,
          activeChecks: [
            ...(config.profile.activeChecks ?? selectedProfile?.activeChecks ?? [
              'test_quality',
              'rollback_safety',
            ]),
          ],
        };

        // 5. Write workspace-level profile resolution
        try {
          await writeProfileResolution(wsDir, profileResolution);
        } catch (err) {
          throwHydrateError(
            'PROFILE_RESOLUTION_PERSIST_FAILED',
            `Failed to persist profile-resolution.json: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // 6. Write immutable snapshots to session dir (BEFORE state)
        try {
          await writeDiscoverySnapshot(sessDir, discoveryResult);
        } catch (err) {
          throwHydrateError(
            'DISCOVERY_PERSIST_FAILED',
            `Failed to persist discovery snapshot: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        try {
          await writeProfileResolutionSnapshot(sessDir, profileResolution);
        } catch (err) {
          throwHydrateError(
            'PROFILE_RESOLUTION_PERSIST_FAILED',
            `Failed to persist profile-resolution snapshot: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // 7. Compute digest, summary, and detected stack
        const resolvedWorktree = nodePath.resolve(worktree);
        const readRepoFile = async (relativePath: string): Promise<string | undefined> => {
          try {
            const targetPath = nodePath.resolve(resolvedWorktree, relativePath);
            if (
              !targetPath.startsWith(resolvedWorktree + nodePath.sep) &&
              targetPath !== resolvedWorktree
            ) {
              return undefined;
            }
            return await fsReadFile(targetPath, 'utf8');
          } catch {
            return undefined;
          }
        };
        discoveryDigest = computeDiscoveryDigest(discoveryResult);
        discoverySummary = extractDiscoverySummary(discoveryResult);
        detectedStack = await extractDetectedStack(
          discoveryResult,
          repoSignals.files,
          readRepoFile,
        );
        verificationCandidates = await planVerificationCandidates({
          detectedStack,
          allFiles: repoSignals.files,
          readFile: readRepoFile,
        });
        requireDiscoveryContract(discoveryDigest, discoverySummary);
        requireDiscoveryArtifacts(wsDir, sessDir);
      }

      // P27: Resolve actor identity (env → git → unknown)
      const actorInfo = await resolveActor(worktree);

      const result = executeHydrate(
        existingWithCentralEvidence,
        {
          sessionId: context.sessionID,
          worktree,
          fingerprint,
          policyMode: existing ? existing.policySnapshot.mode : policyResolution.effectiveMode,
          requestedPolicyMode: existing
            ? (existing.policySnapshot.requestedMode as 'solo' | 'team' | 'team-ci' | 'regulated')
            : policyResolution.requestedMode,
          policySource: existing
            ? (existing.policySnapshot.source ?? 'default')
            : policyResolution.effectiveSource,
          effectiveGateBehavior: existing
            ? existing.policySnapshot.effectiveGateBehavior
            : policyResolution.effectiveGateBehavior,
          policyDegradedReason: existing
            ? (existing.policySnapshot.degradedReason as 'ci_context_missing' | undefined)
            : policyResolution.degradedReason,
          policyResolutionReason: existing
            ? (existing.policySnapshot.resolutionReason as
                | 'repo_weaker_than_central'
                | 'default_weaker_than_central'
                | 'explicit_stronger_than_central'
                | undefined)
            : policyResolution.resolutionReason,
          centralMinimumMode: existing
            ? (centralEvidenceForExisting?.minimumMode ??
              existing.policySnapshot.centralMinimumMode)
            : policyResolution.centralEvidence?.minimumMode,
          policyDigest: existing
            ? (centralEvidenceForExisting?.digest ?? existing.policySnapshot.policyDigest)
            : policyResolution.centralEvidence?.digest,
          policyVersion: existing
            ? centralEvidenceForExisting
              ? centralEvidenceForExisting.version
              : existing.policySnapshot.policyVersion
            : policyResolution.centralEvidence?.version,
          policyPathHint: existing
            ? (centralEvidenceForExisting?.pathHint ?? existing.policySnapshot.policyPathHint)
            : policyResolution.centralEvidence?.pathHint,
          // P31: Existing sessions preserve snapshot profile. New sessions get resolved profile.
          profileId: existing ? existing.activeProfile?.id : profileResolution?.primary?.id ?? 'baseline',
          // P31: pass config-provided activeChecks into rails when explicitly configured.
          // Otherwise keep existing rails profile-driven behavior.
          activeChecks: existing ? undefined : config.profile.activeChecks,
          repoSignals,
          // P31: Only apply config iteration limits to NEW sessions
          // Existing sessions preserve their snapshot values
          maxSelfReviewIterations: existing ? undefined : config.policy.maxSelfReviewIterations,
          maxImplReviewIterations: existing ? undefined : config.policy.maxImplReviewIterations,
          initiatedBy: actorInfo.id,
          initiatedByIdentity: {
            actorId: actorInfo.id,
            actorEmail: actorInfo.email,
            actorSource: actorInfo.source,
            actorAssurance: 'best_effort',
          },
          actorInfo,
          discoveryResult,
          discoveryDigest,
          discoverySummary,
          detectedStack,
          verificationCandidates,
        },
        ctx,
      );

      // Write session pointer (fire-and-forget, non-authoritative)
      writeSessionPointer(fingerprint, context.sessionID, sessDir).catch(() => {});

      // Include detected profile info in the response for new sessions
      if (result.kind === 'ok' && !existing) {
        const state = result.state;
        // persistAndFormat returns JSON + optional "\nNext action: ..." footer — strip before parsing
        const rawFormatted = await persistAndFormat(sessDir, result);
        const jsonEnd = rawFormatted.indexOf('\n');
        const formatted = JSON.parse(jsonEnd >= 0 ? rawFormatted.slice(0, jsonEnd) : rawFormatted);
        const response: Record<string, unknown> = {
          ...formatted,
          profileId: state.activeProfile?.id ?? 'baseline',
          profileName: state.activeProfile?.name ?? 'Baseline Governance',
          profileDetected: !!repoSignals,
          discoveryComplete: !!discoveryResult,
          discoverySummary: discoverySummary ?? null,
          policyResolution: {
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
          },
        };
        return appendNextAction(JSON.stringify(response), state);
      }

      return await persistAndFormat(sessDir, result);
    } catch (err) {
      return formatError(err);
    }
  },
};
