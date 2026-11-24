/**
 * @module documentation/java-reference-evidence
 * @description Contract guards for the public Java reference-evidence case study.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CASE_DIR = join(REPO_ROOT, 'docs', 'case-studies');
const EVIDENCE_DIR = join(CASE_DIR, 'java-governed-delivery', 'evidence');
const read = (path: string): string => readFileSync(path, 'utf8');
const json = (path: string): unknown => JSON.parse(read(path));

describe('Java reference evidence contract', () => {
  it('states the observed controls and the blocked negative control honestly', () => {
    const study = read(join(CASE_DIR, 'java-governed-delivery.md'));
    expect(study).toContain('Positive control — governed delivery');
    expect(study).toContain('Negative control — missing evidence');
    expect(study).toContain('BLOCKED / NOT_VERIFIED');
    expect(study).toContain('Overall: PARTIAL');
    expect(study).toMatch(/must not be presented\s+as a completed three-control reference/);
  });

  it('binds the positive evidence to the actual export package', () => {
    const evidence = json(join(EVIDENCE_DIR, 'reference-evidence.json')) as {
      positiveControl?: {
        exportPackageSha256?: string;
        livePhase?: string;
        archivedPhase?: string;
      };
      negativeControl?: { result?: string; status?: string };
    };
    expect(evidence.positiveControl).toMatchObject({
      livePhase: 'COMPLETE',
      archivedPhase: 'EXPORT_READY',
    });
    expect(evidence.negativeControl).toMatchObject({
      result: 'BLOCKED',
      status: 'NOT_VERIFIED',
    });

    const packageFile = join(EVIDENCE_DIR, 'export-ses_df179688dffektuwvOOVINJBIc.tar.gz');
    const digest = createHash('sha256').update(readFileSync(packageFile)).digest('hex');
    expect(digest).toBe(evidence.positiveControl?.exportPackageSha256);
    expect(read(`${packageFile}.sha256`)).toContain(digest);
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
