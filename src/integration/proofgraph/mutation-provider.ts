/**
 * @module integration/proofgraph/mutation-provider
 * @description Opt-in semantic mutation profiles and recorded-report loading.
 *
 * Owns the two things the pure mutation modules must not: the profile registry
 * (which repository surfaces are mutated for explicitly selected critical
 * claims) and reading an already-produced mutation report from disk.
 *
 * Recording, never executing: this never launches a mutation run. If no report
 * exists, profiles evaluate to `unavailable` evidence rather than blocking or
 * pretending. That keeps the repo-wide mutation job off the per-PR path, which
 * the repository documents as unreliable.
 *
 * @version v1
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  MutationReport,
  summarizeMutationProfile,
  type MutationProfile,
} from '../../audit/proofgraph/mutation-report.js';
import type { MutationEvaluation } from '../../audit/proofgraph/mutation-binder.js';

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
