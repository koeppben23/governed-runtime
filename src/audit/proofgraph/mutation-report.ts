/**
 * @module audit/proofgraph/mutation-report
 * @description Parse recorded mutation results into ProofGraph fault-injection evidence.
 *
 * Selective semantic mutation, recorded rather than executed: this module never
 * runs a mutation tool. It ingests an ALREADY PRODUCED mutation report (the
 * `mutation-testing-elements` schema emitted by Stryker's `json` reporter) and
 * turns the mutants covering an explicitly selected profile into evidence.
 *
 * This is deliberate. The repository documents repo-wide per-PR mutation runs as
 * unreliable, so mutation must never become a per-PR execution requirement.
 * Recording and reporting are separated from execution, which keeps the evidence
 * deterministic and testable from a fixture.
 *
 * Survivor semantics (explicit, never inferred):
 * - `Survived`     -> a surviving mutant: the tests did not detect the change.
 * - `NoCoverage`   -> a surviving mutant: no test exercised it at all.
 * - `Killed`/`Timeout` -> detected by the tests.
 * - `CompileError`/`RuntimeError`/`Ignored`/`Pending` -> excluded from the verdict,
 *   never silently counted as detected.
 *
 * A profile with surviving mutants yields FAILING evidence; a profile the report
 * does not cover yields `unavailable`, never a pass-by-fallback.
 *
 * @version v1
 */

import { z } from 'zod';

import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';

/** Envelope version for persisted mutation evidence records. */
export const MUTATION_EVIDENCE_VERSION = 'mutation-evidence.v1' as const;

/**
 * FlowGuard-owned envelope wrapping a recorded mutation run.
 *
 * Every mutation run that should serve as ProofGraph fault-injection evidence
 * MUST produce this envelope. The envelope captures the implementation revision,
 * command, start/completion timestamps, and report digest at the time the
 * mutation was executed. A raw Stryker report without this envelope is an
 * unbound legacy artifact that cannot be bound to a specific implementation
 * revision and yields NOT_VERIFIED, never a pass-by-fallback.
 */
export const RecordedMutationEvidence = z
  .object({
    version: z.literal(MUTATION_EVIDENCE_VERSION),
    implementationDigest: z.string().min(1),
    command: z.string().min(1),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reportPath: z.string().min(1),
    providerVersion: z.string().min(1),
  })
  .strict()
  .readonly();
export type RecordedMutationEvidence = z.infer<typeof RecordedMutationEvidence>;

/** Mutant statuses defined by the mutation-testing-elements schema. */
export const MutantStatus = z.enum([
  'Killed',
  'Survived',
  'NoCoverage',
  'CompileError',
  'RuntimeError',
  'Timeout',
  'Ignored',
  'Pending',
]);
export type MutantStatus = z.infer<typeof MutantStatus>;

/**
 * The subset of the mutation report this module consumes.
 *
 * Deliberately NOT strict: this parses a FOREIGN tool's output, which carries
 * many fields we do not consume. Strictness belongs on our own persisted
 * evidence records, not on an external format. Missing or malformed required
 * fields still fail closed.
 */
export const MutationReport = z.object({
  schemaVersion: z.string().min(1),
  files: z.record(
    z.string(),
    z.object({
      mutants: z.array(
        z.object({
          id: z.string().min(1),
          mutatorName: z.string().min(1),
          status: MutantStatus,
          location: z
            .object({ start: z.object({ line: z.number().int().nonnegative() }).partial() })
            .partial()
            .optional(),
        }),
      ),
    }),
  ),
});
export type MutationReport = z.infer<typeof MutationReport>;

/** An opt-in mutation profile: which locations a selected claim is mutated over. */
export interface MutationProfile {
  /** Stable profile identifier a claim references. */
  readonly profileId: string;
  /** Report file paths covered by this profile. */
  readonly locations: readonly string[];
  /** Command that produced the report (recorded for reproducibility). */
  readonly command: string;
}

/** A single surviving mutant, retained for reviewer-facing reporting. */
export interface MutationSurvivor {
  readonly mutantId: string;
  readonly location: string;
  readonly mutatorName: string;
  readonly status: 'Survived' | 'NoCoverage';
}

/** Verdict for one profile evaluated against a report. */
export interface MutationProfileSummary {
  readonly profileId: string;
  /** False when the report covers none of the profile's locations. */
  readonly covered: boolean;
  readonly killedCount: number;
  readonly survivorCount: number;
  readonly excludedCount: number;
  readonly survivors: readonly MutationSurvivor[];
  /** SHA-256 over the canonical verdict (the provider output digest). */
  readonly resultDigest: string;
}

function isSurvivor(status: MutantStatus): status is 'Survived' | 'NoCoverage' {
  return status === 'Survived' || status === 'NoCoverage';
}

function isDetected(status: MutantStatus): boolean {
  return status === 'Killed' || status === 'Timeout';
}

/**
 * Summarize one mutation profile against a parsed report.
 *
 * @param report  Parsed mutation report.
 * @param profile The opt-in profile to evaluate.
 */
export function summarizeMutationProfile(
  report: MutationReport,
  profile: MutationProfile,
): MutationProfileSummary {
  const survivors: MutationSurvivor[] = [];
  let killedCount = 0;
  let excludedCount = 0;
  let covered = false;

  for (const location of [...profile.locations].sort()) {
    const file = report.files[location];
    if (file === undefined) continue;
    covered = true;
    for (const mutant of file.mutants) {
      if (isSurvivor(mutant.status)) {
        survivors.push({
          mutantId: mutant.id,
          location,
          mutatorName: mutant.mutatorName,
          status: mutant.status,
        });
      } else if (isDetected(mutant.status)) {
        killedCount += 1;
      } else {
        excludedCount += 1;
      }
    }
  }

  survivors.sort((a, b) =>
    a.location === b.location
      ? a.mutantId.localeCompare(b.mutantId)
      : a.location.localeCompare(b.location),
  );
  const verdict = {
    profileId: profile.profileId,
    covered,
    killedCount,
    survivorCount: survivors.length,
    excludedCount,
    survivors,
  };
  return { ...verdict, resultDigest: hashText(canonicalJsonStringify(verdict)) };
}

/**
 * Compute the canonical digest of a raw mutation report JSON.
 *
 * This is a SHA-256 over the canonical JSON of the parsed report. It serves as
 * the {@link RecordedMutationEvidence.reportDigest} for tamper detection: if the
 * report on disk no longer matches this digest, the evidence is invalid.
 */
export function computeReportDigest(report: MutationReport): string {
  const canonical = canonicalJsonStringify(MutationReport.parse(report));
  return hashText(canonical);
}

/**
 * Verify that a persisted envelope still matches the report it was recorded for.
 *
 * @returns `true` when the computed digest of `report` equals `envelope.reportDigest`.
 */
export function verifyReportDigest(
  envelope: RecordedMutationEvidence,
  report: MutationReport,
): boolean {
  return computeReportDigest(report) === envelope.reportDigest;
}
