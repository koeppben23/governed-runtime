/**
 * @module persistence-observation-ledger.test
 * @description Unit tests for the capability-namespaced observation ledger.
 *
 * @test-policy HAPPY, BAD
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendObservationCapture,
  observationCapabilityDigest,
  observationLedgerPath,
  readObservationCaptures,
} from './persistence-observation-ledger.js';
import type { RepositoryObservationCapture } from '../state/evidence.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-ledger-'));
});

afterAll(() => {});

function capture(
  overrides: Partial<RepositoryObservationCapture> = {},
): RepositoryObservationCapture {
  return {
    capabilityDigest: 'a'.repeat(64),
    capturedSessionId: 'child-session',
    path: 'src/foo.ts',
    revision: 'head',
    resolvedObjectSha: 'b'.repeat(40),
    repositoryIdentityDigest: 'sha256:' + 'c'.repeat(64),
    contentDigest: 'sha256:' + 'd'.repeat(64),
    byteLength: 12,
    representation: 'utf8_text',
    acquisitionKind: 'local_git_object',
    responseDigest: 'sha256:' + 'e'.repeat(64),
    capturedAt: '2026-08-13T10:00:00.000Z',
    ...overrides,
  };
}

describe('observation ledger', () => {
  it('HAPPY: appends and reads captures namespaced by capability digest', async () => {
    const digest = observationCapabilityDigest('fgc_test');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await appendObservationCapture(root, digest, capture());
    await appendObservationCapture(root, digest, capture({ path: 'src/bar.ts' }));
    const read = await readObservationCaptures(root, digest);
    expect(read.captures.map((c) => c.path)).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(read.skipped).toBe(0);
  });

  it('HAPPY: capabilities never bleed across ledgers', async () => {
    await appendObservationCapture(root, 'a'.repeat(64), capture());
    const other = await readObservationCaptures(root, 'f'.repeat(64));
    expect(other.captures).toEqual([]);
  });

  it('BAD: invalid capture payloads are rejected before append', async () => {
    await expect(
      appendObservationCapture(root, 'a'.repeat(64), {
        capabilityDigest: 'a'.repeat(64),
        path: '/absolute/escape',
      } as unknown as RepositoryObservationCapture),
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' });
  });

  it('BAD: corrupt lines are skipped with best-effort tolerance', async () => {
    const digest = 'a'.repeat(64);
    const file = observationLedgerPath(root, digest);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-json\n{"capabilityDigest":"zzz"}\n');
    const read = await readObservationCaptures(root, digest);
    expect(read.captures).toEqual([]);
    expect(read.skipped).toBe(2);
  });
});
