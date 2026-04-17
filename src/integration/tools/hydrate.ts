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

import { z } from "zod";

import type { ToolDefinition } from "./helpers";
import {
  getWorktree,
  resolvePolicyFromState,
  createPolicyContext,
  persistAndFormat,
  formatError,
  appendNextAction,
} from "./helpers";

// State
import type { SessionState } from "../../state/schema";

// Rails
import { executeHydrate } from "../../rails/hydrate";

// Adapters
import { readState } from "../../adapters/persistence";
import { listRepoSignals } from "../../adapters/git";
import {
  writeDiscovery,
  writeProfileResolution,
  writeDiscoverySnapshot,
  writeProfileResolutionSnapshot,
} from "../../adapters/persistence";

// Workspace
import {
  initWorkspace,
  writeSessionPointer,
} from "../../adapters/workspace";

// Discovery
import { runDiscovery, extractDiscoverySummary, computeDiscoveryDigest } from "../../discovery/orchestrator";
import type { DiscoveryResult, ProfileResolution } from "../../discovery/types";
import { PROFILE_RESOLUTION_SCHEMA_VERSION } from "../../discovery/types";
import { defaultProfileRegistry as profileRegistryForResolution } from "../../config/profile";

// Config
import { detectCiContext, resolvePolicyWithContext } from "../../config/policy";

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_hydrate — Bootstrap Session
// ═══════════════════════════════════════════════════════════════════════════════

export const hydrate: ToolDefinition = {
  description:
    "Bootstrap or reload the FlowGuard session. Creates a new session if none exists, " +
    "or returns the existing session unchanged (idempotent). " +
    "Optionally configure policy mode (solo/team/regulated) and profile. " +
    "This MUST be the first FlowGuard tool call in any workflow.",
  args: {
    policyMode: z
      .enum(["solo", "team", "team-ci", "regulated"])
      .default("solo")
      .describe(
        "FlowGuard policy mode. 'solo' = no human gates (default). " +
        "'team' = human gates, self-approval allowed. " +
        "'regulated' = human gates, four-eyes principle enforced.",
      ),
    profileId: z
      .string()
      .default("baseline")
      .describe("Governance profile ID. Defaults to 'baseline'."),
  },
  async execute(args, context) {
    try {
      const worktree = getWorktree(context);

      // Initialize workspace + session directories (idempotent)
      const wsResult = await initWorkspace(worktree, context.sessionID);
      const { fingerprint, sessionDir: sessDir, workspaceDir: wsDir } = wsResult;

      const existing = await readState(sessDir);

      // Resolve policy for context
      const ciContext = detectCiContext();
      const policyResolution = resolvePolicyWithContext(args.policyMode, ciContext);
      const policy = existing
        ? resolvePolicyFromState(existing)
        : policyResolution.policy;
      const ctx = createPolicyContext(policy);

      // ── Discovery (only for new sessions) ──────────────────────
      let repoSignals = existing ? undefined : await listRepoSignals(worktree);
      let discoveryResult: DiscoveryResult | undefined;
      let discoveryDigest: string | undefined;
      let discoverySummary: ReturnType<typeof extractDiscoverySummary> | undefined;
      let profileResolution: ProfileResolution | undefined;
      let discoveryError: string | undefined;

      if (!existing && repoSignals) {
        try {
          // 1. Run discovery orchestrator
          discoveryResult = await runDiscovery({
            worktreePath: worktree,
            fingerprint,
            allFiles: repoSignals.files,
            packageFiles: repoSignals.packageFiles,
            configFiles: repoSignals.configFiles,
          });

          // 2. Write workspace-level discovery
          await writeDiscovery(wsDir, discoveryResult);

          // 3. Detect profile with discovery context
          const detectionInput = { repoSignals, discovery: discoveryResult };
          const detectedProfile = profileRegistryForResolution.detect(detectionInput);
          const selectedProfile = detectedProfile ?? profileRegistryForResolution.get("baseline");

          // 4. Build profile resolution (including rejected candidates)
          const allCandidates: ProfileResolution["secondary"] = [];
          const rejectedCandidates: ProfileResolution["rejected"] = [];

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
                reason: "No matching signals",
              });
            }
          }

          profileResolution = {
            schemaVersion: PROFILE_RESOLUTION_SCHEMA_VERSION,
            resolvedAt: ctx.now(),
            primary: {
              id: selectedProfile?.id ?? "baseline",
              name: selectedProfile?.name ?? "Baseline FlowGuard",
              confidence: selectedProfile?.detect?.(detectionInput) ?? 0.1,
              evidence: [],
            },
            secondary: allCandidates,
            rejected: rejectedCandidates,
            activeChecks: [...(selectedProfile?.activeChecks ?? ["test_quality", "rollback_safety"])],
          };

          // 5. Write workspace-level profile resolution
          await writeProfileResolution(wsDir, profileResolution);

          // 6. Write immutable snapshots to session dir (BEFORE state)
          await writeDiscoverySnapshot(sessDir, discoveryResult);
          await writeProfileResolutionSnapshot(sessDir, profileResolution);

          // 7. Compute digest and summary
          discoveryDigest = computeDiscoveryDigest(discoveryResult);
          discoverySummary = extractDiscoverySummary(discoveryResult);
        } catch (err) {
          // Discovery failed — degrade gracefully.
          // Session will be created without discovery data.
          discoveryResult = undefined;
          discoveryDigest = undefined;
          discoverySummary = undefined;
          profileResolution = undefined;
          discoveryError = err instanceof Error ? err.message : String(err);
        }
      }

      const result = executeHydrate(existing, {
        sessionId: context.sessionID,
        worktree,
        fingerprint,
        policyMode: existing ? existing.policySnapshot.mode : policyResolution.effectiveMode,
        requestedPolicyMode: existing
          ? ((existing.policySnapshot.requestedMode ?? existing.policySnapshot.mode) as
              | "solo"
              | "team"
              | "team-ci"
              | "regulated")
          : policyResolution.requestedMode,
        effectiveGateBehavior: existing
          ? (existing.policySnapshot.effectiveGateBehavior
              ?? (policy.requireHumanGates ? "human_gated" : "auto_approve"))
          : policyResolution.effectiveGateBehavior,
        policyDegradedReason: existing
          ? (existing.policySnapshot.degradedReason as "ci_context_missing" | undefined)
          : policyResolution.degradedReason,
        profileId: args.profileId,
        repoSignals,
        initiatedBy: context.sessionID,
        discoveryResult,
        discoveryDigest,
        discoverySummary,
      }, ctx);

      // Write session pointer (fire-and-forget, non-authoritative)
      writeSessionPointer(fingerprint, context.sessionID, sessDir).catch(() => {});

      // Include detected profile info in the response for new sessions
      if (result.kind === "ok" && !existing) {
        const state = result.state;
        // persistAndFormat returns JSON + optional "\nNext action: ..." footer — strip before parsing
        const rawFormatted = await persistAndFormat(sessDir, result);
        const jsonEnd = rawFormatted.indexOf("\n");
        const formatted = JSON.parse(jsonEnd >= 0 ? rawFormatted.slice(0, jsonEnd) : rawFormatted);
        const response: Record<string, unknown> = {
          ...formatted,
          profileId: state.activeProfile?.id ?? "baseline",
          profileName: state.activeProfile?.name ?? "Baseline Governance",
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
        if (discoveryError) {
          response.discoveryError = discoveryError;
        }
        return appendNextAction(JSON.stringify(response), state);
      }

      return await persistAndFormat(sessDir, result);
    } catch (err) {
      return formatError(err);
    }
  },
};
