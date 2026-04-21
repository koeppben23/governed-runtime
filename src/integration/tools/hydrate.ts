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
import { detectCiContext, resolvePolicyWithContext } from '../../config/policy';

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
      .default('solo')
      .describe(
        "FlowGuard policy mode. 'solo' = no human gates (default). " +
          "'team' = human gates, self-approval allowed. " +
          "'regulated' = human gates, four-eyes principle enforced.",
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

      const existing = await readState(sessDir);

      // Resolve policy for context
      const ciContext = detectCiContext();
      const policyResolution = resolvePolicyWithContext(args.policyMode, ciContext);
      const policy = existing ? resolvePolicyFromState(existing) : policyResolution.policy;
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

        // 3. Detect profile with discovery context
        const detectionInput = { repoSignals, discovery: discoveryResult };
        const detectedProfile = profileRegistryForResolution.detect(detectionInput);
        const selectedProfile = detectedProfile ?? profileRegistryForResolution.get('baseline');

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
          activeChecks: [...(selectedProfile?.activeChecks ?? ['test_quality', 'rollback_safety'])],
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
        const readRepoFile = async (relativePath: string): Promise<string | undefined> => {
          try {
            return await fsReadFile(nodePath.join(worktree, relativePath), 'utf8');
          } catch {
            return undefined;
          }
        };
        discoveryDigest = computeDiscoveryDigest(discoveryResult);
        discoverySummary = extractDiscoverySummary(discoveryResult);
        detectedStack = await extractDetectedStack(discoveryResult, repoSignals.files, readRepoFile);
        verificationCandidates = await planVerificationCandidates({
          detectedStack,
          allFiles: repoSignals.files,
          readFile: readRepoFile,
        });
        requireDiscoveryContract(discoveryDigest, discoverySummary);
        requireDiscoveryArtifacts(wsDir, sessDir);
      }

      const result = executeHydrate(
        existing,
        {
          sessionId: context.sessionID,
          worktree,
          fingerprint,
          policyMode: existing ? existing.policySnapshot.mode : policyResolution.effectiveMode,
          requestedPolicyMode: existing
            ? (existing.policySnapshot.requestedMode as 'solo' | 'team' | 'team-ci' | 'regulated')
            : policyResolution.requestedMode,
          effectiveGateBehavior: existing
            ? existing.policySnapshot.effectiveGateBehavior
            : policyResolution.effectiveGateBehavior,
          policyDegradedReason: existing
            ? (existing.policySnapshot.degradedReason as 'ci_context_missing' | undefined)
            : policyResolution.degradedReason,
          profileId: args.profileId,
          repoSignals,
          initiatedBy: context.sessionID,
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
            effectiveGateBehavior: policyResolution.effectiveGateBehavior,
            reason: policyResolution.degradedReason ?? null,
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
