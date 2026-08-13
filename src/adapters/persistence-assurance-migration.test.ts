/**
 * @module persistence-assurance-migration.test
 * @description Read-boundary shape-only migrations: review-assurance.v3 →
 *              v4 (literal) and v4 → v5 (literal + pre-v5 observations become
 *              evidence-incapable). No authority is invented; legacy states
 *              stay loadable.
 *
 * @test-policy HAPPY, BAD
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readState, statePath, writeState } from './persistence.js';
import {
  createReviewObligation,
  createObligationAndAttempt,
} from '../integration/review/assurance.js';
import { makeState } from '../fixtures.js';

let sessDir: string;

beforeAll(async () => {
  sessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-migrate-'));
  fs.mkdirSync(sessDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(sessDir, { recursive: true, force: true });
});

describe('review-assurance shape-only read migrations', () => {
  it('HAPPY: v3 state loads with the v5 literal and preserves obligations verbatim', async () => {
    const { assurance, obligation } = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'plan',
        iteration: 0,
        planVersion: 1,
        now: '2026-08-13T10:00:00.000Z',
        subjectDigest: 'subject-digest',
        changedFiles: ['src/a.ts'],
      },
      '2026-08-13T10:00:00.000Z',
    );
    expect(assurance.assuranceSchemaVersion).toBe('review-assurance.v5');

    // Persist as if written by a v3 runtime: literal downgraded, no new fields.
    const legacy = JSON.parse(JSON.stringify(assurance)) as Record<string, unknown>;
    legacy.assuranceSchemaVersion = 'review-assurance.v3';
    const legacyObligations = legacy.obligations as Record<string, unknown>[];
    expect(legacyObligations[0]?.repositoryAuthority).toBeUndefined();
    expect(legacyObligations[0]?.repositoryRevisionProvenance).toEqual({
      kind: 'unavailable',
      reason: 'frozen_repository_authority_missing',
    });

    const legacyState = { ...makeState('PLAN'), reviewAssurance: legacy };
    fs.writeFileSync(statePath(sessDir), JSON.stringify(legacyState, null, 2) + '\n', 'utf-8');

    const loaded = await readState(sessDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.reviewAssurance?.assuranceSchemaVersion).toBe('review-assurance.v5');
    // Shape-only: obligations preserved, no authority invented.
    const loadedObligation = loaded!.reviewAssurance?.obligations[0];
    expect(loadedObligation?.obligationId).toBe(obligation.obligationId);
    expect(loadedObligation?.repositoryAuthority).toBeUndefined();
  });

  it('REGRESSION: pre-v5 v4 observation state survives upgrade without gaining authority', async () => {
    // Build a VALID PR-A v4 state: attempt with old-shape observations
    // (no resolvedObjectKind, no lineCount) minted by the real pre-v5 replay.
    const { assurance, obligation } = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'plan',
        iteration: 0,
        planVersion: 1,
        now: '2026-08-13T10:00:00.000Z',
        subjectDigest: 'subject-digest',
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
    const newShapeObservation = {
      ...oldShapeObservation,
      observationId: '22222222-2222-4222-8222-222222222222',
      resolvedObjectKind: 'commit',
      lineCount: 1,
    };
    const legacyAssurance = JSON.parse(JSON.stringify(assurance)) as Record<string, unknown>;
    legacyAssurance.assuranceSchemaVersion = 'review-assurance.v4';
    const attempts = legacyAssurance.attempts as Record<string, unknown>[];
    attempts[0]!.observations = [oldShapeObservation, newShapeObservation];

    const legacyState = { ...makeState('PLAN'), reviewAssurance: legacyAssurance };
    fs.writeFileSync(statePath(sessDir), JSON.stringify(legacyState, null, 2) + '\n', 'utf-8');

    const loaded = await readState(sessDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.reviewAssurance?.assuranceSchemaVersion).toBe('review-assurance.v5');
    const loadedObservations = loaded!.reviewAssurance?.attempts[0]?.observations ?? [];
    // Pre-v5 observations are stripped (evidence-incapable); the v5-shaped
    // observation survives. Nothing is manufactured.
    expect(loadedObservations).toHaveLength(1);
    expect(loadedObservations[0]!.observationId).toBe('22222222-2222-4222-8222-222222222222');
    expect(loadedObservations[0]!.resolvedObjectKind).toBe('commit');
    const loadedObs = loadedObservations[0]!;
    if (loadedObs.representation === 'utf8_text') {
      expect(loadedObs.lineCount).toBe(1);
    }
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
      iteration: 0,
      planVersion: 1,
      now: '2026-08-13T10:00:00.000Z',
      subjectDigest: 'subject-digest',
      changedFiles: [],
    });
    const { assurance } = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'plan',
        iteration: 0,
        planVersion: 1,
        now: '2026-08-13T10:00:00.000Z',
        subjectDigest: 'subject-digest',
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
