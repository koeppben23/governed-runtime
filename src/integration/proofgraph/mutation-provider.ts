/**
 * @module integration/proofgraph/mutation-provider
 * @description Opt-in semantic mutation profiles, recorded-report loading, and
 *              envelope verification.
 *
 * Owns the three things the pure mutation modules must not: the profile registry
 * (which repository surfaces are mutated for explicitly selected critical
 * claims), reading an already-produced mutation report from disk, and loading
 * the FlowGuard-owned {@link RecordedMutationEvidence} envelope that binds the
 * report to the implementation revision it was executed against.
 *
 * Recording, never executing: this never launches a mutation run. If no report
 * or envelope exists, profiles evaluate to `unavailable` evidence rather than
 * blocking or pretending. That keeps the repo-wide mutation job off the per-PR
 * path, which the repository documents as unreliable.
 *
 * The envelope is the authority for the implementation digest, command, and
 * timestamps of the mutation run. Without it the report is an unbound legacy
 * artifact — the binder yields NOT_VERIFIED, never a pass-by-fallback.
 *
 * @version v1
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  MutationReport,
  RecordedMutationEvidence,
  computeReportDigest,
  summarizeMutationProfile,
  type MutationProfile,
  type RecordedMutationEvidence as RecordedMutationEvidenceType,
} from '../../audit/proofgraph/mutation-report.js';
import type { MutationEvaluation } from '../../audit/proofgraph/mutation-binder.js';

/** Default location of the recorded mutation report (Stryker `json` reporter). */
export const MUTATION_REPORT_RELATIVE_PATH = path.join('reports', 'mutation', 'mutation.json');
/** Default location of the FlowGuard-owned mutation evidence envelope. */
export const MUTATION_EVIDENCE_RELATIVE_PATH = path.join('.flowguard', 'mutation-evidence.json');

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
 * Result of loading the mutation evidence for a repository state.
 *
 * A `null` envelope means no recorded evidence exists (the mutation run never
 * produced a `mutation-evidence.v1` envelope, or the envelope was tampered
 * with or unreadable). The report is still returned if available for diagnostic
 * use, but without a valid envelope the binder produces NOT_VERIFIED results.
 */
export interface MutationEvidenceResult {
  readonly envelope: RecordedMutationEvidenceType | null;
  /** The parsed mutation report, or null when absent/unreadable. */
  readonly report: MutationReport | null;
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
 * Load the recorded mutation evidence envelope and verify it against the report.
 *
 * @param repoRoot        Repository root.
 * @param evidencePath    Override of the envelope location.
 * @param reportPath      Override of the report location.
 */
export async function loadMutationEvidence(
  repoRoot: string,
  evidencePath: string = MUTATION_EVIDENCE_RELATIVE_PATH,
  reportPath: string = MUTATION_REPORT_RELATIVE_PATH,
): Promise<MutationEvidenceResult> {
  let envelope: RecordedMutationEvidenceType | null = null;
  let rawEnv: string;
  try {
    rawEnv = await readFile(path.join(repoRoot, evidencePath), 'utf-8');
  } catch {
    return { envelope: null, report: await loadMutationReport(repoRoot, reportPath) };
  }
  try {
    const parsed: unknown = JSON.parse(rawEnv);
    const result = RecordedMutationEvidence.safeParse(parsed);
    if (!result.success) {
      return { envelope: null, report: await loadMutationReport(repoRoot, reportPath) };
    }
    envelope = result.data;
  } catch {
    return { envelope: null, report: await loadMutationReport(repoRoot, reportPath) };
  }

  const report = await loadMutationReport(repoRoot, envelope.reportPath);
  if (report === null) {
    return { envelope: null, report: null };
  }

  // Tamper detection: the report on disk must match the recorded digest.
  if (computeReportDigest(report) !== envelope.reportDigest) {
    return { envelope: null, report };
  }

  return { envelope, report };
}

/**
 * Evaluate every registered profile against a recorded report.
 *
 * A `null` report yields evaluations without summaries, which the binder turns
 * into explicit `unavailable` evidence.
 */
export function evaluateMutationProfiles(report: MutationReport | null): MutationEvaluation[] {
  return MUTATION_PROFILES.map((profile) =>
    report === null ? { profile } : { profile, summary: summarizeMutationProfile(report, profile) },
  );
}
