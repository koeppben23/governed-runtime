/**
 * @module persistence-assurance-migration.test
 * @description Assurance epoch read boundary: legacy review-assurance v3/v4
 *              state shapes are never migrated on read — they fail closed
 *              with SCHEMA_VALIDATION_FAILED. Only current-generation
 *              (review-assurance.v5) state loads.
 *
 * @test-policy HAPPY, BAD
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readState, statePath, writeState } from './persistence.js';
import {
  artifactReviewSubjectScope,
  createReviewObligation,
  createObligationAndAttempt,
  freezeReviewMaterial,
} from '../integration/review/assurance.js';
import { makeState } from '../fixtures.js';

let sessDir: string;
const FROZEN_MATERIAL = freezeReviewMaterial('frozen review material\n', 'subject-digest');

beforeAll(async () => {
  sessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-migrate-'));
  fs.mkdirSync(sessDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(sessDir, { recursive: true, force: true });
});

describe('review-assurance legacy rejection at the read boundary', () => {
  it('BAD: a review-assurance.v3 state fails closed instead of migrating', async () => {
    const { assurance } = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'plan',
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        iteration: 0,
        planVersion: 1,
        now: '2026-08-13T10:00:00.000Z',
        subjectDigest: 'subject-digest',
        reviewMaterial: FROZEN_MATERIAL,
        reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest'),
        changedFiles: ['src/a.ts'],
      },
      '2026-08-13T10:00:00.000Z',
    );
    expect(assurance.assuranceSchemaVersion).toBe('review-assurance.v5');

    // Persist as if written by a v3 runtime: literal downgraded, no new fields.
    const legacy = JSON.parse(JSON.stringify(assurance)) as Record<string, unknown>;
    legacy.assuranceSchemaVersion = 'review-assurance.v3';

    const legacyState = { ...makeState('PLAN'), reviewAssurance: legacy };
    fs.writeFileSync(statePath(sessDir), JSON.stringify(legacyState, null, 2) + '\n', 'utf-8');

    await expect(readState(sessDir)).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('BAD: a review-assurance.v4 state fails closed instead of stripping observations', async () => {
    const { assurance, obligation } = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'plan',
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        iteration: 0,
        planVersion: 1,
        now: '2026-08-13T10:00:00.000Z',
        subjectDigest: 'subject-digest',
        reviewMaterial: FROZEN_MATERIAL,
        reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest'),
        changedFiles: ['src/a.ts'],
      },
      '2026-08-13T10:00:00.000Z',
    );
    const v5Attempt = assurance.attempts[0]!;
    const oldShapeObservation = {
      observationId: '11111111-1111-4111-8111-111111111111',
      obligationId: obligation.obligationId,
      attemptId: v5Attempt.attemptId,
      observedBySessionId: 'ses_child_legacy',
      path: 'src/a.ts',
      revision: 'head',
      repositoryIdentity: { host: 'github.com', owner: 'acme', name: 'repo' },
      resolvedObjectSha: 'a'.repeat(40),
      contentDigest: 'sha256:' + 'b'.repeat(64),
      byteLength: 4,
      representation: 'utf8_text',
      capturedAt: '2026-08-13T10:00:00.000Z',
      boundAt: '2026-08-13T10:00:00.000Z',
      acquisition: { kind: 'local_git_object' },
    };
    const legacyAssurance = JSON.parse(JSON.stringify(assurance)) as Record<string, unknown>;
    legacyAssurance.assuranceSchemaVersion = 'review-assurance.v4';
    const attempts = legacyAssurance.attempts as Record<string, unknown>[];
    attempts[0]!.observations = [oldShapeObservation];

    const legacyState = { ...makeState('PLAN'), reviewAssurance: legacyAssurance };
    fs.writeFileSync(statePath(sessDir), JSON.stringify(legacyState, null, 2) + '\n', 'utf-8');

    await expect(readState(sessDir)).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('REGRESSION: v5-persisted observations are preserved unchanged', async () => {
    const { assurance, obligation } = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'plan',
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        iteration: 0,
        planVersion: 1,
        now: '2026-08-13T10:00:00.000Z',
        subjectDigest: 'subject-digest',
        reviewMaterial: FROZEN_MATERIAL,
        reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest'),
        changedFiles: ['src/a.ts'],
      },
      '2026-08-13T10:00:00.000Z',
    );
    const attempt = assurance.attempts[0]!;
    const validObservation = {
      observationId: '33333333-3333-4333-8333-333333333333',
      obligationId: obligation.obligationId,
      attemptId: attempt.attemptId,
      observedBySessionId: 'ses_child_v5',
      path: 'src/a.ts',
      revision: 'head',
      repositoryIdentity: { host: 'github.com', owner: 'acme', name: 'repo' },
      resolvedObjectSha: 'a'.repeat(40),
      resolvedObjectKind: 'commit',
      contentDigest: 'sha256:' + 'b'.repeat(64),
      byteLength: 4,
      representation: 'utf8_text',
      lineCount: 1,
      capturedAt: '2026-08-13T10:00:00.000Z',
      boundAt: '2026-08-13T10:00:00.000Z',
      acquisition: { kind: 'local_git_object' },
    };
    const v5Assurance = JSON.parse(JSON.stringify(assurance)) as Record<string, unknown>;
    const attempts = v5Assurance.attempts as Record<string, unknown>[];
    attempts[0]!.observations = [validObservation];

    const v5State = { ...makeState('PLAN'), reviewAssurance: v5Assurance };
    fs.writeFileSync(statePath(sessDir), JSON.stringify(v5State, null, 2) + '\n', 'utf-8');

    const loaded = await readState(sessDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.reviewAssurance?.assuranceSchemaVersion).toBe('review-assurance.v5');
    const loadedObservations = loaded!.reviewAssurance?.attempts[0]?.observations ?? [];
    expect(loadedObservations).toHaveLength(1);
    expect(loadedObservations[0]!.observationId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('BAD: corrupt assurance still fails closed', async () => {
    const bad = {
      ...makeState('PLAN'),
      reviewAssurance: { assuranceSchemaVersion: 'review-assurance.v2', obligations: [] },
    };
    fs.writeFileSync(statePath(sessDir), JSON.stringify(bad) + '\n', 'utf-8');
    await expect(readState(sessDir)).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('EDGE: writeState persists the v5 literal', async () => {
    const obligation = createReviewObligation({
      obligationType: 'plan',
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      iteration: 0,
      planVersion: 1,
      now: '2026-08-13T10:00:00.000Z',
      subjectDigest: 'subject-digest',
      reviewMaterial: FROZEN_MATERIAL,
      reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest'),
      changedFiles: [],
    });
    const { assurance } = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'plan',
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        iteration: 0,
        planVersion: 1,
        now: '2026-08-13T10:00:00.000Z',
        subjectDigest: 'subject-digest',
        reviewMaterial: FROZEN_MATERIAL,
        reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest'),
        changedFiles: [],
      },
      '2026-08-13T10:00:00.000Z',
    );
    void obligation;
    await writeState(sessDir, { ...makeState('PLAN'), reviewAssurance: assurance });
    const raw = fs.readFileSync(statePath(sessDir), 'utf-8');
    expect(raw).toContain('"review-assurance.v5"');
  });
});
