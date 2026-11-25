/**
 * @module documentation/java-reference-evidence
 * @description Contract guards for the public Java reference-evidence case study.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CASE_DIR = join(REPO_ROOT, 'docs', 'case-studies');
const EVIDENCE_DIR = join(CASE_DIR, 'java-governed-delivery', 'evidence');
const read = (path: string): string => readFileSync(path, 'utf8');
const json = (path: string): unknown => JSON.parse(read(path));

describe('Java reference evidence contract', () => {
  it('states the completed controls honestly', () => {
    const study = read(join(CASE_DIR, 'java-governed-delivery.md'));
    expect(study).toContain('Positive control — governed delivery');
    expect(study).toContain('Negative control — missing evidence');
    expect(study).toContain('**PASS**');
    expect(study).toContain('Overall: COMPLETE');
    expect(study).toContain('PROOFGRAPH_CRITICAL_FACTS_UNPROVEN');
    expect(study).not.toContain('BLOCKED / NOT_VERIFIED');
    expect(study).not.toContain('Overall: PARTIAL');
  });

  it('binds the completed controls to the withheld package manifest', () => {
    const evidence = json(join(EVIDENCE_DIR, 'reference-evidence.json')) as {
      positiveControl?: {
        exportPackageSha256?: string;
        livePhase?: string;
        archivedPhase?: string;
        initialPlanDigest?: string;
        verificationCandidateIds?: unknown;
      };
      negativeControl?: {
        result?: string;
        status?: string;
        denial?: string;
        packageProduced?: boolean;
        initialPlanDigest?: string;
        verificationCandidateIds?: unknown;
        priorRelatedEvidence?: string;
      };
      harness?: { status?: string; patchDigest?: string | null };
    };
    expect(evidence.positiveControl).toMatchObject({
      livePhase: 'COMPLETE',
      archivedPhase: 'EXPORT_READY',
    });
    expect(evidence.negativeControl).toMatchObject({
      result: 'PASS',
      status: 'VERIFIED',
      denial: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
      packageProduced: false,
    });
    expect(evidence.harness).toMatchObject({
      status: 'VERIFIED',
      patchDigest: null,
    });
    expect(evidence.positiveControl?.initialPlanDigest).toBe(
      evidence.negativeControl?.initialPlanDigest,
    );
    expect(evidence.positiveControl?.verificationCandidateIds).toEqual(
      evidence.negativeControl?.verificationCandidateIds,
    );
    expect(
      existsSync(join(EVIDENCE_DIR, evidence.negativeControl?.priorRelatedEvidence ?? 'missing')),
    ).toBe(true);

    // The raw package is withheld in this draft. After publication approval,
    // restore the byte-level SHA-256 check against the package file here.
    const manifest = json(join(EVIDENCE_DIR, 'package-manifest.json')) as {
      package?: { sha256?: string; file?: string };
      publication?: { status?: string };
    };
    expect(manifest.package?.sha256).toBe(evidence.positiveControl?.exportPackageSha256);
    expect(manifest.publication?.status).toBe('withheld_pending_explicit_owner_approval');
    expect(existsSync(join(EVIDENCE_DIR, manifest.package?.file ?? 'missing'))).toBe(false);
  });

  it('keeps the red-green proof and both integrity findings', () => {
    const redGreen = read(join(EVIDENCE_DIR, 'red-green.txt'));
    expect(redGreen).toContain('Tests run: 16, Failures: 0, Errors: 0, Skipped: 1');
    expect(redGreen).toContain('NullPointerException');
    expect(redGreen).toContain('HTTP status: 500');

    const integrity = json(join(EVIDENCE_DIR, 'integrity-controls.json')) as {
      manipulationA?: { findings?: string[]; exitCode?: number };
      manipulationB?: { findings?: string[]; exitCode?: number };
      originalAfterManipulations?: { exitCode?: number; verified?: boolean };
    };
    expect(integrity.manipulationA).toMatchObject({
      exitCode: 1,
      findings: ['archive_checksum_mismatch'],
    });
    expect(integrity.manipulationB).toMatchObject({
      exitCode: 1,
      findings: ['file_digest_mismatch'],
    });
    expect(integrity.originalAfterManipulations).toMatchObject({
      exitCode: 0,
      verified: true,
    });
  });
});
