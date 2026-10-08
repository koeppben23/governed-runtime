/**
 * @module hooks/post-tool-use.ingest-e2e.test
 * @description D2 (#1032) end-to-end: the real PostToolUse command hook records
 * an unattributable oversized-payload failure in the real bounded ledger, with
 * observed-prefix metadata and no raw payload bytes, and stays non-blocking.
 *
 * Only stdin is mocked; the ledger and its lock/file I/O are real.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTestEnv } from '../integration/test-helpers.js';
import { hashBuffer } from '../shared/hashing.js';
import { hookIngestFailureLogPath } from '../adapters/persistence.js';

const mockReadStdin = vi.hoisted(() => vi.fn());

vi.mock('./shared/stdin-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared/stdin-reader.js')>();
  return {
    ...actual,
    readStdin: (...args: unknown[]) => mockReadStdin(...args),
    readStdinRaw: async (...args: unknown[]) => {
      const payload = (await mockReadStdin(...args)) as Record<string, unknown>;
      return { payload, raw: '' };
    },
  };
});

import { StdinReadError } from './shared/stdin-reader.js';

const originalStderrWrite = process.stderr.write;

describe('post-tool-use ingestion failure ledger (real persistence)', () => {
  let configDir: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    configDir = await mkdtemp(join(tmpdir(), 'fg-posttool-ingest-'));
    restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    process.exitCode = undefined;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    restoreEnv();
    await rm(configDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('persists observed bytes + digest without raw payload bytes and exits non-blocking', async () => {
    const observedPrefixText = 'x'.repeat(1_100_000);
    const observedPrefix = Buffer.from(observedPrefixText);
    mockReadStdin.mockRejectedValue(
      new StdinReadError('STDIN_TOO_LARGE', 'stdin exceeds 1048576 bytes', {
        bytes: 1_100_000,
        prefix: observedPrefix,
      }),
    );

    await import('./post-tool-use.js');

    // The hook's top-level `main().catch()` is not awaited by the import; wait
    // for the real ledger append to settle.
    await vi.waitFor(async () => {
      const observed = await readFile(hookIngestFailureLogPath(), 'utf8').catch(() => '');
      expect(observed.trim()).not.toBe('');
    });
    const raw = await readFile(hookIngestFailureLogPath(), 'utf8');
    const record = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(record).toMatchObject({
      transport: 'command_hook',
      event: 'PostToolUse',
      reasonCode: 'STDIN_TOO_LARGE',
      observedBytes: 1_100_000,
      digestScope: 'observed_prefix',
      observedPrefixDigest: hashBuffer(observedPrefix),
    });
    // Metadata only: the raw payload must never land in the ledger.
    expect(raw).not.toContain(observedPrefixText);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
