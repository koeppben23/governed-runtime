/**
 * @module integration/tools-execute-hydrate-toctou.test
 * @description D4 (#1033): hydrate must re-validate the canonical session
 * authority under the session write lock. A location that changes between the
 * candidate (pre-lock) resolution and the locked re-resolution fails closed
 * instead of bootstrapping or updating at a stale location.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrate } from './tools/index.js';
import {
  createToolContext,
  isBlockedResult,
  parseToolResult,
  withTestEnv,
} from './test-helpers.js';

const scripted = vi.hoisted(() => ({
  calls: 0,
  dirA: '',
  dirB: '',
  root: '',
}));

vi.mock('../adapters/session-authority.js', () => ({
  resolveSessionAuthority: vi.fn(async () => {
    scripted.calls += 1;
    return {
      status: 'resolved' as const,
      sessDir: scripted.calls === 1 ? scripted.dirA : scripted.dirB,
      worktreeRoot: scripted.root,
      fingerprint: 'a'.repeat(24),
      state: {},
    };
  }),
}));

describe('hydrate TOCTOU re-validation (D4)', () => {
  let base: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    scripted.calls = 0;
    base = await mkdtemp(join(tmpdir(), 'fg-hydrate-toctou-'));
    scripted.root = join(base, 'repo');
    scripted.dirA = join(base, 'sessions', 'A');
    scripted.dirB = join(base, 'sessions', 'B');
    await mkdir(scripted.root, { recursive: true });
    await mkdir(scripted.dirA, { recursive: true });
    await mkdir(scripted.dirB, { recursive: true });
    restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: join(base, 'config') });
  });

  afterEach(async () => {
    restoreEnv();
    await rm(base, { recursive: true, force: true });
  });

  it('BAD: fails closed when the authority location changes before the lock is held', async () => {
    const ctx = createToolContext({
      worktree: scripted.root,
      directory: scripted.root,
      sessionID: 'sess-toctou',
    });

    const result = parseToolResult(await hydrate.execute({ policyMode: 'solo' }, ctx));

    // Candidate resolution + locked re-resolution both ran, and the mismatch
    // was rejected instead of mutating the stale candidate location.
    expect(scripted.calls).toBeGreaterThanOrEqual(2);
    expect(isBlockedResult(result)).toBe(true);
    expect(result.code).toBe('SESSION_BINDING_MISMATCH');
  });
});
