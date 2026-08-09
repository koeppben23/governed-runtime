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
 * @version v2 — separate artifact and projection digests
 */

import { z } from 'zod';

import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';

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
  /** False when the report covers none of the profile's locations OR when no
   *  mutants were actually evaluated (e.g. all were excluded, zero mutants present).
   *  True only when at least one mutant was killed or survived. */
  readonly covered: boolean;
  readonly killedCount: number;
  readonly survivorCount: number;
  readonly excludedCount: number;
  readonly survivors: readonly MutationSurvivor[];
  /** SHA-256 over the canonical projection (the provider result digest). */
  readonly projectionDigest: string;
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
  let surfacePresent = false;

  for (const location of [...profile.locations].sort()) {
    const file = report.files[location];
    if (file === undefined) continue;
    surfacePresent = true;
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
    killedCount,
    survivorCount: survivors.length,
    excludedCount,
    survivors,
  };
  // covered = true ONLY when a profile file was present AND at least one
  // mutant was actually evaluated (killed or survived). A profile with zero
  // evaluated mutants — empty files, or only CompileError / RuntimeError /
  // Ignored / Pending — is NOT a valid verdict. It proves nothing.
  const covered = surfacePresent && killedCount + survivors.length > 0;
  return { ...verdict, covered, projectionDigest: hashText(canonicalJsonStringify(verdict)) };
}

/**
 * Compute the projection digest — SHA-256 over the canonical JSON of the parsed
 * report (the subset FlowGuard consumes). This is the digest of the consumer's
 * semantic view, distinct from the artifact integrity digest.
 */
export function computeProjectionDigest(report: MutationReport): string {
  return hashText(canonicalJsonStringify(MutationReport.parse(report)));
}

/**
 * Compute the artifact digest — SHA-256 of the raw report file bytes.
 *
 * This digest covers the EXACT artifact on disk, including fields FlowGuard does
 * not consume. Tampering with any non-consumed field — or with the JSON encoding
 * itself — changes this digest and invalidates the trusted evidence.
 */
export function computeArtifactDigest(rawReport: string): string {
  return hashText(rawReport);
}
