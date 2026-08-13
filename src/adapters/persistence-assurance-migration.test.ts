/**
 * @module persistence-assurance-migration.test
 * @description Read-boundary shape-only migration: review-assurance.v3 →
 *              review-assurance.v4. No authority is invented; legacy
 *              obligations stay loadable and authority-less.
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

describe('review-assurance v3 -> v4 shape-only migration', () => {
  it('HAPPY: v3 state loads with the v4 literal and preserves obligations verbatim', async () => {
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
    expect(assurance.assuranceSchemaVersion).toBe('review-assurance.v4');

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
    expect(loaded!.reviewAssurance?.assuranceSchemaVersion).toBe('review-assurance.v4');
    // Shape-only: obligations preserved, no authority invented.
    const loadedObligation = loaded!.reviewAssurance?.obligations[0];
    expect(loadedObligation?.obligationId).toBe(obligation.obligationId);
    expect(loadedObligation?.repositoryAuthority).toBeUndefined();
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

  it('EDGE: writeState persists the v4 literal', async () => {
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
    expect(raw).toContain('"review-assurance.v4"');
  });
});
