/**
 * @module discovery/drift
 * @description Read-only rediscovery/drift detection.
 *
 * Compares current repo signals with a previously persisted Discovery digest
 * to detect whether the repository has changed since the session was created.
 *
 * Invariants:
 * - NEVER writes to disk or modifies session snapshots.
 * - Advisory only — produces a DriftResult for operator/agent awareness.
 * - Failure is explicit (throws), never silently passes.
 */

import { computeDiscoveryDigest, runDiscovery } from './orchestrator.js';
import { readDiscovery } from '../adapters/persistence-discovery.js';
import { listRepoSignals } from '../adapters/git.js';
import type { CollectorDiagnostic } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of a read-only drift comparison. */
export interface DriftResult {
  /** Whether the repository has meaningfully changed since the persisted discovery. */
  readonly drifted: boolean;
  /** SHA-256 digest of the current repo state (newly computed). */
  readonly currentDigest: string;
  /** SHA-256 digest from the persisted discovery.json. Null if no persisted discovery. */
  readonly persistedDigest: string | null;
  /** Collectors whose status changed (if drifted). */
  readonly changedCollectors?: string[];
  /** Per-collector diagnostics from the fresh discovery run. */
  readonly diagnostics?: CollectorDiagnostic[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether the repository has drifted since the last persisted discovery.
 *
 * Performs a full (but read-only) rediscovery:
 * 1. Re-runs listRepoSignals from git
 * 2. Re-runs all collectors (bounded by same timeout as normal discovery)
 * 3. Computes a new digest
 * 4. Compares with the persisted discovery.json digest
 *
 * @param workspaceDir - Absolute path to the workspace directory (contains discovery/).
 * @param worktree - Absolute path to the git worktree root.
 * @param fingerprint - Repository fingerprint (24-hex).
 * @returns DriftResult with comparison outcome.
 * @throws On infrastructure failure (git unavailable, workspace unreadable).
 */
export async function checkDiscoveryDrift(
  workspaceDir: string,
  worktree: string,
  fingerprint: string,
): Promise<DriftResult> {
  // Read existing persisted discovery (may not exist for first-run)
  const persisted = await readDiscovery(workspaceDir);
  const persistedDigest = persisted ? computeDiscoveryDigest(persisted) : null;

  // Re-run discovery (read-only — we never write)
  const repoSignals = await listRepoSignals(worktree);
  const freshResult = await runDiscovery({
    worktreePath: worktree,
    fingerprint,
    allFiles: repoSignals.files,
    packageFiles: repoSignals.packageFiles,
    configFiles: repoSignals.configFiles,
    packageFilePaths: repoSignals.packageFilePaths,
    configFilePaths: repoSignals.configFilePaths,
  });

  const currentDigest = computeDiscoveryDigest(freshResult);
  const drifted = persistedDigest !== null && currentDigest !== persistedDigest;

  // Identify which collectors changed status
  let changedCollectors: string[] | undefined;
  if (drifted && persisted) {
    changedCollectors = [];
    for (const [name, status] of Object.entries(freshResult.collectors)) {
      if (persisted.collectors[name] !== status) {
        changedCollectors.push(name);
      }
    }
    // Also check for new collectors not in persisted
    for (const name of Object.keys(persisted.collectors)) {
      if (!(name in freshResult.collectors)) {
        changedCollectors.push(name);
      }
    }
  }

  return {
    drifted,
    currentDigest,
    persistedDigest,
    ...(changedCollectors && changedCollectors.length > 0 ? { changedCollectors } : {}),
    ...(freshResult.diagnostics ? { diagnostics: freshResult.diagnostics } : {}),
  };
}
