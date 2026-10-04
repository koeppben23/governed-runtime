/**
 * @module integration/proofgraph/mutation-verification.test
 * @description Per-attempt digest verification of recorded mutation reports (#762).
 *
 * Guards the trust boundary that a recorded `MutationAttempt` may only ever be
 * evaluated against the exact artifact it was recorded from. A replaced or
 * edited report must never supply survivor counts for a historical attempt.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  resolveVerifiedMutationVerdicts,
  MUTATION_REPORT_RELATIVE_PATH,
} from './mutation-provider.js';
import {
  MutationReport,
  computeArtifactDigest,
  computeProjectionDigest,
} from '../../audit/proofgraph/mutation-report.js';
import type { MutationAttempt } from '../../state/evidence-mutation.js';

const EVALUATOR = 'src/audit/proofgraph/evaluate.ts';
const PROFILE = 'proofgraph-evaluator';
const ATTEMPT_ID = '00000000-0000-4000-8000-0000000000a1';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'flowguard-mutation-verify-'));
  await mkdir(path.join(root, 'reports', 'mutation'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function reportJson(statuses: string[]): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    files: {
      [EVALUATOR]: {
        mutants: statuses.map((status, i) => ({
          id: String(i),
          mutatorName: 'ConditionalExpression',
          status,
        })),
      },
    },
  });
}

async function writeReport(raw: string): Promise<void> {
  await writeFile(path.join(root, MUTATION_REPORT_RELATIVE_PATH), raw, 'utf-8');
}

function attemptFor(raw: string, overrides: Partial<MutationAttempt> = {}): MutationAttempt {
  const report = MutationReport.parse(JSON.parse(raw));
  return {
    attemptId: ATTEMPT_ID,
    implementationDigest: 'impl-current',
    command: 'npm run mutation',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    exitCode: 0,
    artifactDigest: computeArtifactDigest(raw),
    projectionDigest: computeProjectionDigest(report),
    reportPath: MUTATION_REPORT_RELATIVE_PATH,
    providerVersion: 'semantic-mutation.v1',
    ...overrides,
  };
}

describe('resolveVerifiedMutationVerdicts', () => {
  it('returns a profile verdict when both recorded digests match the artifact', async () => {
    const raw = reportJson(['Killed', 'Killed']);
    await writeReport(raw);
    const verdicts = await resolveVerifiedMutationVerdicts(root, [attemptFor(raw)]);
    expect(verdicts.get(ATTEMPT_ID)?.get(PROFILE)).toEqual({
      survivorCount: 0,
      killedCount: 2,
      covered: true,
    });
  });

  it('reports survivors from the verified artifact', async () => {
    const raw = reportJson(['Killed', 'Survived']);
    await writeReport(raw);
    const verdicts = await resolveVerifiedMutationVerdicts(root, [attemptFor(raw)]);
    expect(verdicts.get(ATTEMPT_ID)?.get(PROFILE)?.survivorCount).toBe(1);
  });

  it('yields NO verdict when the report on disk was replaced after recording', async () => {
    const recorded = reportJson(['Killed', 'Survived']);
    const attempt = attemptFor(recorded);
    // A different artifact is now on disk (survivors "disappeared").
    await writeReport(reportJson(['Killed', 'Killed']));
    const verdicts = await resolveVerifiedMutationVerdicts(root, [attempt]);
    expect(verdicts.has(ATTEMPT_ID)).toBe(false);
  });

  it('yields NO verdict when the artifact digest does not match', async () => {
    const raw = reportJson(['Killed']);
    await writeReport(raw);
    const verdicts = await resolveVerifiedMutationVerdicts(root, [
      attemptFor(raw, { artifactDigest: 'f'.repeat(64) }),
    ]);
    expect(verdicts.has(ATTEMPT_ID)).toBe(false);
  });

  it('yields NO verdict when the projection digest does not match', async () => {
    const raw = reportJson(['Killed']);
    await writeReport(raw);
    const verdicts = await resolveVerifiedMutationVerdicts(root, [
      attemptFor(raw, { projectionDigest: 'e'.repeat(64) }),
    ]);
    expect(verdicts.has(ATTEMPT_ID)).toBe(false);
  });

  it('yields NO verdict when the recorded report is missing', async () => {
    const raw = reportJson(['Killed']);
    const verdicts = await resolveVerifiedMutationVerdicts(root, [attemptFor(raw)]);
    expect(verdicts.has(ATTEMPT_ID)).toBe(false);
  });

  it('yields NO verdict when the report is unparseable', async () => {
    const raw = reportJson(['Killed']);
    const attempt = attemptFor(raw);
    await writeReport('{ not json');
    const verdicts = await resolveVerifiedMutationVerdicts(root, [attempt]);
    expect(verdicts.has(ATTEMPT_ID)).toBe(false);
  });

  it('evaluates each attempt against ITS OWN reportPath, not one shared report', async () => {
    const cleanRaw = reportJson(['Killed', 'Killed']);
    const dirtyRaw = reportJson(['Survived', 'Survived']);
    const otherPath = path.join('reports', 'mutation', 'older.json');
    await writeReport(cleanRaw);
    await writeFile(path.join(root, otherPath), dirtyRaw, 'utf-8');

    const cleanAttempt = attemptFor(cleanRaw);
    const dirtyAttempt = attemptFor(dirtyRaw, {
      attemptId: '00000000-0000-4000-8000-0000000000b2',
      reportPath: otherPath,
    });

    const verdicts = await resolveVerifiedMutationVerdicts(root, [cleanAttempt, dirtyAttempt]);
    // Each attempt keeps its own verdict; the default report does not leak.
    expect(verdicts.get(cleanAttempt.attemptId)?.get(PROFILE)?.survivorCount).toBe(0);
    expect(verdicts.get(dirtyAttempt.attemptId)?.get(PROFILE)?.survivorCount).toBe(2);
  });
});
