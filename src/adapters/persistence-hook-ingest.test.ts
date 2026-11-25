/**
 * @module adapters/persistence-hook-ingest.test
 * @description D2 (#1032): the transport ingestion-failure ledger is bounded,
 * lock-protected with a short bounded wait, metadata-only (never raw payloads),
 * and never hangs the caller.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withTestEnv } from '../integration/test-helpers.js';
import { hashBuffer } from '../shared/hashing.js';
import { hookIngestFailureLogPath } from './persistence.js';
import {
  appendHookIngestFailure,
  HOOK_INGEST_FAILURE_MAX_BYTES,
  HOOK_INGEST_FAILURE_SCHEMA_VERSION,
  type HookIngestFailureInput,
} from './persistence-hook-ingest.js';

function failureInput(overrides: Partial<HookIngestFailureInput> = {}): HookIngestFailureInput {
  return {
    transport: 'http_hook',
    event: 'PostToolUse',
    reasonCode: 'HOOK_STDIN_INVALID',
    observedBytes: 42,
    observedPrefix: Buffer.from('SECRET-PAYLOAD'),
    ...overrides,
  };
}

describe('hook ingest failure ledger', () => {
  let configDir: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'fg-ingest-'));
    restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  });

  afterEach(async () => {
    restoreEnv();
    await rm(configDir, { recursive: true, force: true });
  });

  it('HAPPY: appends metadata + observed-prefix digest and never stores raw bytes', async () => {
    const result = await appendHookIngestFailure(failureInput());

    expect(result).toEqual({ recorded: true });
    const raw = await readFile(hookIngestFailureLogPath(), 'utf8');
    expect(raw).not.toContain('SECRET-PAYLOAD');
    expect(JSON.parse(raw.trim())).toMatchObject({
      schemaVersion: HOOK_INGEST_FAILURE_SCHEMA_VERSION,
      transport: 'http_hook',
      event: 'PostToolUse',
      reasonCode: 'HOOK_STDIN_INVALID',
      observedBytes: 42,
      digestScope: 'observed_prefix',
      observedPrefixDigest: hashBuffer(Buffer.from('SECRET-PAYLOAD')),
    });
  });

  it('BAD: marks the digest unavailable when no bytes were observed', async () => {
    await appendHookIngestFailure(failureInput({ observedBytes: null, observedPrefix: null }));

    expect(JSON.parse((await readFile(hookIngestFailureLogPath(), 'utf8')).trim())).toMatchObject({
      observedBytes: null,
      observedPrefixDigest: null,
      digestScope: 'unavailable',
    });
  });

  it('HAPPY: hashes the raw observed bytes binary-exactly for invalid UTF-8', async () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    await appendHookIngestFailure(
      failureInput({ observedBytes: invalidUtf8.byteLength, observedPrefix: invalidUtf8 }),
    );

    const record = JSON.parse((await readFile(hookIngestFailureLogPath(), 'utf8')).trim()) as {
      observedPrefixDigest: string;
    };
    expect(record.observedPrefixDigest).toBe(hashBuffer(invalidUtf8));
    // A text round-trip would replace the invalid sequences and change the
    // digest; the stored digest must cover the original bytes.
    const replacementForm = Buffer.from(invalidUtf8.toString('utf-8'));
    expect(record.observedPrefixDigest).not.toBe(hashBuffer(replacementForm));
  });

  it('EDGE: rotates to a single bounded generation', async () => {
    await mkdir(configDir, { recursive: true });
    const oversized = 'x'.repeat(HOOK_INGEST_FAILURE_MAX_BYTES + 1);
    await writeFile(hookIngestFailureLogPath(), oversized, 'utf8');

    const result = await appendHookIngestFailure(failureInput());

    expect(result).toEqual({ recorded: true });
    expect(await readFile(`${hookIngestFailureLogPath()}.1`, 'utf8')).toBe(oversized);
    const lines = (await readFile(hookIngestFailureLogPath(), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('EDGE: serializes concurrent appends without losing or corrupting records', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendHookIngestFailure(failureInput({ observedBytes: index })),
      ),
    );

    expect(results.every((result) => result.recorded)).toBe(true);
    const lines = (await readFile(hookIngestFailureLogPath(), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(8);
    const observed = lines.map(
      (line) => (JSON.parse(line) as { observedBytes: number }).observedBytes,
    );
    expect(new Set(observed)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
  });

  it('BAD: fails fast without hanging while the ledger lock is held', async () => {
    await mkdir(configDir, { recursive: true });
    const { acquireNamedWriteLock } = await import('./persistence-lock.js');
    const held = await acquireNamedWriteLock(
      configDir,
      'flowguard-hook-ingest-failures.lock',
      'test-holder',
      1_000,
    );
    try {
      const startedAt = performance.now();
      const result = await appendHookIngestFailure(failureInput());
      const elapsed = performance.now() - startedAt;

      expect(result).toMatchObject({ recorded: false, reason: 'LOCK_UNAVAILABLE' });
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      await held.release();
    }
  });
});
