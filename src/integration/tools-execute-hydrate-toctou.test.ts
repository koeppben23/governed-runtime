/**
 * @module integration/tools-execute-hydrate-toctou.test
 * @description D4 (#1033): hydrate must re-validate the canonical session
 * authority under the session write lock. A session location OR canonical
 * worktree root that changes between the candidate (pre-lock) resolution and
 * the locked re-resolution fails closed instead of bootstrapping or updating
 * at a stale location.
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

interface ScriptedAuthority {
  readonly sessDir: string;
  readonly worktreeRoot: string;
  readonly fingerprint: string;
}

const scripted = vi.hoisted(() => ({
  calls: 0,
  results: [] as ScriptedAuthority[],
}));

vi.mock('../adapters/session-authority.js', () => ({
  resolveSessionAuthority: vi.fn(async () => {
    scripted.calls += 1;
    const result =
      scripted.results[Math.min(scripted.calls - 1, scripted.results.length - 1)] ??
      scripted.results[0]!;
    return {
      status: 'resolved' as const,
      sessDir: result.sessDir,
      worktreeRoot: result.worktreeRoot,
      fingerprint: result.fingerprint,
      state: {},
    };
  }),
}));

// Isolate the authority re-validation: initWorkspace mirrors the first
// resolution (same fingerprint/session dir), so ONLY an explicit canonical
// worktree-root comparison can detect the drift under test.
vi.mock('../adapters/workspace/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/workspace/index.js')>();
  return {
    ...actual,
    initWorkspace: vi.fn(async (worktree: string) => {
      const first = scripted.results[0]!;
      return {
        worktree,
        fingerprint: first.fingerprint,
        workspaceDir: actual.workspaceDir(first.fingerprint),
        sessionDir: first.sessDir,
      };
    }),
  };
});

describe('hydrate TOCTOU re-validation (D4)', () => {
  let base: string;
  let rootA: string;
  let rootB: string;
  let dirA: string;
  let dirB: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    scripted.calls = 0;
    scripted.results = [];
    base = await mkdtemp(join(tmpdir(), 'fg-hydrate-toctou-'));
    rootA = join(base, 'repo-a');
    rootB = join(base, 'repo-b');
    dirA = join(base, 'sessions', 'A');
    dirB = join(base, 'sessions', 'B');
    for (const directory of [rootA, rootB, dirA, dirB]) {
      await mkdir(directory, { recursive: true });
    }
    restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: join(base, 'config') });
  });

  afterEach(async () => {
    restoreEnv();
    await rm(base, { recursive: true, force: true });
  });

  function runHydrate(): ReturnType<typeof hydrate.execute> {
    const ctx = createToolContext({
      worktree: rootA,
      directory: rootA,
      sessionID: 'sess-toctou',
    });
    return hydrate.execute({ policyMode: 'solo' }, ctx);
  }

  it('BAD: fails closed when the authority session location changes before the lock is held', async () => {
    const fingerprint = 'a'.repeat(24);
    scripted.results = [
      { sessDir: dirA, worktreeRoot: rootA, fingerprint },
      { sessDir: dirB, worktreeRoot: rootA, fingerprint },
    ];

    const result = parseToolResult(await runHydrate());

    expect(scripted.calls).toBeGreaterThanOrEqual(2);
    expect(isBlockedResult(result)).toBe(true);
    expect(result.code).toBe('SESSION_BINDING_MISMATCH');
  });

  it('BAD: fails closed when the canonical worktree root drifts with the same fingerprint and session dir', async () => {
    // Same remote-derived fingerprint and same session directory: only the
    // canonical worktree root changed between the two resolutions.
    const fingerprint = 'a'.repeat(24);
    scripted.results = [
      { sessDir: dirA, worktreeRoot: rootA, fingerprint },
      { sessDir: dirA, worktreeRoot: rootB, fingerprint },
      { sessDir: dirA, worktreeRoot: rootB, fingerprint },
    ];

    const result = parseToolResult(await runHydrate());

    expect(scripted.calls).toBeGreaterThanOrEqual(2);
    expect(isBlockedResult(result)).toBe(true);
    expect(result.code).toBe('SESSION_BINDING_MISMATCH');
  });
});
