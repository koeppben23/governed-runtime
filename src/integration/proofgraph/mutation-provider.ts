/**
 * @module integration/proofgraph/mutation-provider
 * @description Opt-in semantic mutation profiles, report loading, and
 *              MutationAttempt persistence.
 *
 * Owns the three things the pure mutation modules must not: the profile registry
 * (which repository surfaces are mutated for explicitly selected critical
 * claims), reading an already-produced mutation report from disk, and recording
 * a `MutationAttempt` in session state through the
 * `flowguard_record_mutation_evidence` tool.
 *
 * Recording, never executing: this never launches a mutation run. If no report
 * exists, profiles evaluate to `unavailable` evidence rather than blocking or
 * pretending. That keeps the repo-wide mutation job off the per-PR path, which
 * the repository documents as unreliable.
 *
 * The canonical trust boundary is the `MutationAttempt` in session state — NOT a
 * freely editable filesystem envelope. A raw Stryker report without a
 * corresponding `MutationAttempt` is insufficient for trusted evidence.
 *
 * @version v2 — session-state attempts replace filesystem envelopes
 */

import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  MutationReport,
  computeArtifactDigest,
  computeProjectionDigest,
  summarizeMutationProfile,
  type MutationProfile,
  type MutationProfileSummary,
} from '../../audit/proofgraph/mutation-report.js';
import type { MutationAttempt } from '../../state/evidence-mutation.js';
import type { VerifiedProfileVerdict } from '../../audit/proofgraph/mutation-binder.js';

/** Default location of the recorded mutation report (Stryker `json` reporter). */
export const MUTATION_REPORT_RELATIVE_PATH = path.join('reports', 'mutation', 'mutation.json');

/** Command that produces the recorded report. */
const MUTATION_COMMAND = 'npm run mutation';

/**
 * Opt-in mutation profiles.
 *
 * Deliberately narrow: only surfaces whose semantics a surviving mutant would
 * genuinely falsify. The ProofGraph evaluator decides verification states, so a
 * mutant surviving there means the claim's tests do not pin its semantics.
 */
export const MUTATION_PROFILES: readonly MutationProfile[] = [
  {
    profileId: 'proofgraph-evaluator',
    locations: ['src/audit/proofgraph/evaluate.ts'],
    command: MUTATION_COMMAND,
  },
  {
    profileId: 'proofgraph-gate',
    locations: ['src/audit/proofgraph/gate.ts'],
    command: MUTATION_COMMAND,
  },
];

/** Valid profile ids, for declaration-time validation. */
export const MUTATION_PROFILE_IDS = MUTATION_PROFILES.map((p) => p.profileId);

/**
 * Registry-level capability check: does any registered mutation provider
 * produce `flowguard_executed` evidence that can satisfy a positive
 * `fault_injection` proof requirement?
 *
 * Currently returns `false` — all registered profiles rely on externally
 * self-reported reports. When a FlowGuard-executed mutation provider is added,
 * this function becomes the single authority for declaration-satisfiability
 * gating, preventing caller-level booleans from drifting out of sync with the
 * provider registry.
 */
export function hasProvingMutationProvider(): boolean {
  return false;
}

/**
 * Load and parse a recorded mutation report.
 *
 * @param repoRoot   Repository root the report path is resolved against.
 * @param reportPath Optional override of the report location.
 * @returns The parsed report, or `null` when absent/unreadable/malformed.
 */
export async function loadMutationReport(
  repoRoot: string,
  reportPath: string = MUTATION_REPORT_RELATIVE_PATH,
): Promise<MutationReport | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(repoRoot, reportPath), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = MutationReport.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Load raw report content as a string (for artifact digest).
 */
export async function loadReportRaw(
  repoRoot: string,
  reportPath: string = MUTATION_REPORT_RELATIVE_PATH,
): Promise<string | null> {
  try {
    return await readFile(path.join(repoRoot, reportPath), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Create a `MutationAttempt` from a recorded mutation run.
 *
 * This is called by the `flowguard_record_mutation_evidence` tool. The tool
 * provides run metadata; this function computes digests, validates the report,
 * and returns the immutable attempt. The caller persists it in session state.
 *
 * @param rawReport          Raw mutation report JSON string.
 * @param implementationDigest Current session implementation digest (derived by the tool).
 * @param command              Command that produced the report.
 * @param startedAt            ISO-8601 start timestamp.
 * @param completedAt          ISO-8601 completion timestamp.
 * @param exitCode             Exit code of the command.
 * @param reportPath           Repository-relative path to the report.
 * @returns                   A validated MutationAttempt, or an error description.
 */
export function buildMutationAttempt(
  rawReport: string,
  implementationDigest: string,
  run: {
    command: string;
    startedAt: string;
    completedAt: string;
    exitCode: number;
  },
  reportPath: string,
):
  | { readonly kind: 'ok'; readonly attempt: MutationAttempt; readonly report: MutationReport }
  | { readonly kind: 'error'; readonly message: string } {
  let report: MutationReport;
  try {
    const parsed: unknown = JSON.parse(rawReport);
    const result = MutationReport.safeParse(parsed);
    if (!result.success) {
      return { kind: 'error', message: 'failed to parse mutation report' };
    }
    report = result.data;
  } catch {
    return { kind: 'error', message: 'invalid JSON in mutation report' };
  }
  const artifactDigest = computeArtifactDigest(rawReport);
  const projectionDigest = computeProjectionDigest(report);
  const attemptId = crypto.randomUUID();
  return {
    kind: 'ok',
    attempt: {
      attemptId,
      implementationDigest,
      command: run.command,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      exitCode: run.exitCode,
      artifactDigest,
      projectionDigest,
      reportPath,
      providerVersion: 'semantic-mutation.v1',
    },
    report,
  };
}

/**
 * Evaluate every registered profile against a recorded report.
 */
export function evaluateMutationProfiles(report: MutationReport | null): MutationProfileSummary[] {
  if (report === null) return [];
  return MUTATION_PROFILES.map((profile) => summarizeMutationProfile(report, profile));
}

/** Verdict for one (attempt, profile) pair, derived from a DIGEST-VERIFIED report. */
export type { VerifiedProfileVerdict } from '../../audit/proofgraph/mutation-binder.js';

/**
 * Per-attempt verified verdicts: `attemptId -> profileId -> verdict`.
 * An attempt whose report failed verification is absent, so the binder emits
 * explicit `unavailable` evidence instead of a verdict from the wrong artifact.
 */
export type VerifiedMutationVerdicts = ReadonlyMap<
  string,
  ReadonlyMap<string, VerifiedProfileVerdict>
>;

/**
 * Resolve a profile to the newest digest-verified attempt for the current
 * implementation. The attempt id tie-break keeps selection deterministic.
 */
export function resolveVerifiedMutationAttempt(
  attempts: readonly MutationAttempt[],
  profileId: string,
  implementationDigest: string,
  verdicts: VerifiedMutationVerdicts,
): MutationAttempt | null {
  const eligible = attempts.filter(
    (attempt) =>
      attempt.implementationDigest === implementationDigest &&
      (verdicts.get(attempt.attemptId)?.get(profileId)?.covered ?? false),
  );
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) =>
    a.completedAt === b.completedAt
      ? a.attemptId.localeCompare(b.attemptId)
      : a.completedAt.localeCompare(b.completedAt),
  )[eligible.length - 1]!;
}

/**
 * Resolve digest-verified profile verdicts for the recorded mutation attempts.
 *
 * Each attempt is evaluated against ITS OWN `reportPath`, and only after BOTH
 * recorded digests match the artifact currently on disk:
 *
 * 1. `artifactDigest` over the exact raw bytes, and
 * 2. `projectionDigest` over the canonical parsed subset.
 *
 * If the report is missing, unreadable, unparseable, or either digest differs,
 * the attempt yields NO verdict. This prevents a replaced `mutation.json` from
 * supplying survivor counts for an unrelated historical attempt, which would
 * otherwise pair a verdict from artifact B with the recorded digest of A.
 *
 * @param worktree Repository root the attempt report paths are resolved against.
 * @param attempts Recorded mutation attempts from session state.
 */
export async function resolveVerifiedMutationVerdicts(
  worktree: string,
  attempts: readonly MutationAttempt[],
): Promise<VerifiedMutationVerdicts> {
  const verified = new Map<string, ReadonlyMap<string, VerifiedProfileVerdict>>();
  for (const attempt of attempts) {
    const raw = await loadReportRaw(worktree, attempt.reportPath);
    if (raw === null) continue;
    if (computeArtifactDigest(raw) !== attempt.artifactDigest) continue;

    let report: MutationReport;
    try {
      const result = MutationReport.safeParse(JSON.parse(raw));
      if (!result.success) continue;
      report = result.data;
    } catch {
      continue;
    }
    if (computeProjectionDigest(report) !== attempt.projectionDigest) continue;

    const byProfile = new Map<string, VerifiedProfileVerdict>();
    for (const summary of evaluateMutationProfiles(report)) {
      byProfile.set(summary.profileId, {
        survivorCount: summary.survivorCount,
        killedCount: summary.killedCount,
        covered: summary.covered,
      });
    }
    verified.set(attempt.attemptId, byProfile);
  }
  return verified;
}
