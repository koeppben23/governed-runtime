/**
 * @module adapters/persistence-more.test
 * @description Direct coverage for the persistence read/write authority:
 *              readState failure modes, legacy verdict/validation/assurance
 *              migrations, writeStateAlreadyLocked validation, and report
 *              operations.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readState,
  writeState,
  writeStateAlreadyLocked,
  writeReport,
  readReport,
  stateExists,
  PersistenceError,
} from './persistence.js';
import { makeState, VALIDATION_PASSED } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import type { ReviewReport } from '../state/evidence-review.js';

let tmpDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-persistence-more-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

const FIXED_TIME = '2026-05-15T12:00:00.000Z';

describe('readState failure modes', () => {
  it('returns null when the state file does not exist', async () => {
    const dir = await tmpDir();
    await expect(readState(dir)).resolves.toBeNull();
  });

  it('throws PARSE_FAILED for malformed JSON', async () => {
    const dir = await tmpDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session-state.json'), '{ corrupt', 'utf8');
    await expect(readState(dir)).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('throws LEGACY_ASSURANCE_FORMAT_UNSUPPORTED for non-v2 state JSON', async () => {
    const dir = await tmpDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session-state.json'), '{"not":"a session"}', 'utf8');
    await expect(readState(dir)).rejects.toMatchObject({
      code: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
    });
  });

  it('throws READ_FAILED when the file cannot be read', async () => {
    const dir = await tmpDir();
    await fs.mkdir(dir, { recursive: true });
    const stateFile = path.join(dir, 'session-state.json');
    await fs.writeFile(stateFile, '{}', 'utf8');
    await fs.chmod(stateFile, 0o000);
    try {
      await expect(readState(dir)).rejects.toMatchObject({ code: 'READ_FAILED' });
    } finally {
      await fs.chmod(stateFile, 0o600);
    }
  });
});

describe('readState legacy migrations', () => {
  it('rejects a legacy selfReview approve verdict state (no read migration)', async () => {
    const dir = await tmpDir();
    await fs.mkdir(dir, { recursive: true });
    const state = makeState('PLAN', {
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest',
        revisionDelta: 'major',
        verdict: 'accept',
      },
    });
    const json = {
      ...(state as unknown as Record<string, unknown>),
      selfReview: { ...state.selfReview, verdict: 'approve' },
    };
    await fs.writeFile(path.join(dir, 'session-state.json'), JSON.stringify(json), 'utf8');

    await expect(readState(dir)).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('rejects legacy review-assurance v3 states (no shape migration)', async () => {
    const dir = await tmpDir();
    await fs.mkdir(dir, { recursive: true });
    const state = makeState('PLAN', {
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v3' as never,
        obligations: [],
        invocations: [],
        attempts: [],
      },
    });
    await fs.writeFile(
      path.join(dir, 'session-state.json'),
      JSON.stringify(state as unknown as Record<string, unknown>),
      'utf8',
    );

    await expect(readState(dir)).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('rejects legacy validation outcomes without the explicit outcome field', async () => {
    const dir = await tmpDir();
    await fs.mkdir(dir, { recursive: true });
    const legacyEntry = { ...VALIDATION_PASSED[0]!, outcome: undefined };
    delete (legacyEntry as Record<string, unknown>).outcome;
    const state = makeState('PLAN');
    const json = {
      ...(state as unknown as Record<string, unknown>),
      validation: [legacyEntry],
    };
    await fs.writeFile(path.join(dir, 'session-state.json'), JSON.stringify(json), 'utf8');

    await expect(readState(dir)).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('rejects a failing legacy validation outcome instead of migrating it', async () => {
    const dir = await tmpDir();
    await fs.mkdir(dir, { recursive: true });
    const legacyEntry = { ...VALIDATION_PASSED[0]!, passed: false, outcome: undefined };
    delete (legacyEntry as Record<string, unknown>).outcome;
    const state = makeState('PLAN');
    const json = {
      ...(state as unknown as Record<string, unknown>),
      validation: [legacyEntry],
    };
    await fs.writeFile(path.join(dir, 'session-state.json'), JSON.stringify(json), 'utf8');

    await expect(readState(dir)).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('reads current-generation states unchanged', async () => {
    const dir = await tmpDir();
    await fs.mkdir(dir, { recursive: true });
    await writeState(dir, makeState('PLAN'));
    const loaded = await readState(dir);
    expect(loaded?.phase).toBe('PLAN');
  });
});

describe('writeStateAlreadyLocked validation', () => {
  it('throws SCHEMA_VALIDATION_FAILED for invalid state', async () => {
    const dir = await tmpDir();
    await expect(
      writeStateAlreadyLocked(dir, { not: 'a state' } as unknown as SessionState),
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' });
  });

  it('refuses an IMPLEMENTATION state without a frozen base authority', async () => {
    const dir = await tmpDir();
    const state = makeState('IMPLEMENTATION');
    await expect(writeStateAlreadyLocked(dir, state)).rejects.toMatchObject({
      code: 'REVIEW_IMPLEMENTATION_BASE_FREEZE_FAILED',
    });
  });
});

describe('report operations', () => {
  it('throws SCHEMA_VALIDATION_FAILED for invalid reports', async () => {
    const dir = await tmpDir();
    await expect(writeReport(dir, { bad: true } as unknown as ReviewReport)).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('returns null for a missing report', async () => {
    const dir = await tmpDir();
    await expect(readReport(dir)).resolves.toBeNull();
  });
});

describe('stateExists', () => {
  it('returns true for an existing state file', async () => {
    const dir = await tmpDir();
    await writeState(dir, makeState('PLAN'));
    await expect(stateExists(dir)).resolves.toBe(true);
  });

  it('returns false for a missing state file', async () => {
    const dir = await tmpDir();
    await expect(stateExists(dir)).resolves.toBe(false);
  });
});

describe('writeState already locked writes', () => {
  it('persists the pretty-printed state', async () => {
    const dir = await tmpDir();
    await writeStateAlreadyLocked(dir, makeState('PLAN'));
    const raw = await fs.readFile(path.join(dir, 'session-state.json'), 'utf8');
    expect(raw.startsWith('{\n')).toBe(true);
  });
});

describe('persistence error typing', () => {
  it('exposes typed codes', () => {
    const err = new PersistenceError('READ_FAILED', 'boom');
    expect(err.code).toBe('READ_FAILED');
    expect(err.name).toBe('PersistenceError');
  });
});
