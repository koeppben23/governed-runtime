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

/**
 * Build a profile verdict map keyed by attempt ID, for the binder.
 *
 * Evaluates profiles from the report and maps them to the attempt that
 * recorded them. The binder uses this to resolve `mutation_attempt` refs.
 */
export function buildProfileVerdictMap(
  report: MutationReport | null,
  attemptId: string,
): Map<
  string,
  { readonly survivorCount: number; readonly killedCount: number; readonly covered: boolean }
> {
  const map = new Map<string, { survivorCount: number; killedCount: number; covered: boolean }>();
  if (report === null) return map;
  const summaries = evaluateMutationProfiles(report);
  const covered = summaries.some((s) => s.covered);
  const totalKilled = summaries.reduce((sum, s) => sum + s.killedCount, 0);
  const totalSurvivors = summaries.reduce((sum, s) => sum + s.survivorCount, 0);
  map.set(attemptId, { survivorCount: totalSurvivors, killedCount: totalKilled, covered });
  return map;
}
