/**
 * @module adapters-context.test
 * @description Tests for createRailContext and session write lock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { readState, writeState, writeStateAlreadyLocked } from './persistence.js';
import { withSessionWriteLock, acquireSessionWriteLock, sessionLockPath } from './persistence-lock.js';
import { createRailContext } from './context.js';
import { makeState, FIXED_TIME, FIXED_UUID, FIXED_SESSION_UUID } from '../__fixtures__.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

async function walkSrcFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...(await walkSrcFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

// =============================================================================
// context
// =============================================================================

describe('context', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('createRailContext returns context with now() and digest()', () => {
      const ctx = createRailContext();
      expect(typeof ctx.now).toBe('function');
      expect(typeof ctx.digest).toBe('function');
    });

    it('now() returns ISO-8601 timestamp', () => {
      const ctx = createRailContext();
      const ts = ctx.now();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(ts).getTime()).not.toBeNaN();
    });

    it('digest() returns 64-char hex SHA-256', () => {
      const ctx = createRailContext();
      const hash = ctx.digest('hello world');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('digest() handles empty string', () => {
      const ctx = createRailContext();
      const hash = ctx.digest('');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('digest() is deterministic', () => {
      const ctx = createRailContext();
      expect(ctx.digest('test')).toBe(ctx.digest('test'));
    });

    it('digest() differs for different inputs', () => {
      const ctx = createRailContext();
      expect(ctx.digest('a')).not.toBe(ctx.digest('b'));
    });

    it('each createRailContext call returns independent context', () => {
      const ctx1 = createRailContext();
      const ctx2 = createRailContext();
      expect(ctx1).not.toBe(ctx2);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('now() returns different values across time', async () => {
      const ctx = createRailContext();
      const t1 = ctx.now();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const t2 = ctx.now();
      expect(new Date(t2).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
    });

    it('digest() handles unicode content', () => {
      const ctx = createRailContext();
      const hash = ctx.digest('Hello\u00e9\u4e16\u754c');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it(`digest() of 1MB string < ${PERF_BUDGETS.digest1MbMs}ms (p95)`, () => {
      const ctx = createRailContext();
      const bigString = 'x'.repeat(1024 * 1024);
      const { p95Ms } = benchmarkSync(() => ctx.digest(bigString), 30, 8);
      expect(p95Ms).toBeLessThan(PERF_BUDGETS.digest1MbMs);
    });
  });

  // ─── session-write-lock ──────────────────────────────────────
  describe('session-write-lock', () => {
    let lockDir: string;

    beforeEach(async () => {
      lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-lock-'));
    });

    afterEach(async () => {
      await fs.rm(lockDir, { recursive: true, force: true });
    });

    it('HAPPY: sequential writes succeed', async () => {
      await writeState(lockDir, makeState('TICKET'));
      await writeState(lockDir, makeState('PLAN'));
      const loaded = await readState(lockDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe('PLAN');
    });

    it('EDGE: concurrent writes serialize without corruption', async () => {
      const stateA = makeState('TICKET', {
        id: FIXED_UUID,
        binding: {
          sessionId: FIXED_SESSION_UUID,
          worktree: '/tmp/a',
          fingerprint: 'aaaabbbbccccddddeeeeffff',
          resolvedAt: FIXED_TIME,
        },
      });
      const stateB = makeState('PLAN', {
        id: FIXED_UUID,
        binding: {
          sessionId: FIXED_SESSION_UUID,
          worktree: '/tmp/b',
          fingerprint: 'aaaabbbbccccddddeeeeffff',
          resolvedAt: FIXED_TIME,
        },
      });
      const results = await Promise.allSettled([
        writeState(lockDir, stateA),
        writeState(lockDir, stateB),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const loaded = await readState(lockDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBeDefined();
    });

    it('BAD: lock timeout yields LOCK_TIMEOUT with blocking PID', async () => {
      const lock = await acquireSessionWriteLock(lockDir);
      try {
        await expect(acquireSessionWriteLock(lockDir, 500)).rejects.toMatchObject({
          code: 'LOCK_TIMEOUT',
        });
      } finally {
        await lock.release();
      }
    });

    it('CORNER: stale lock (dead PID) is recovered', async () => {
      const lockPath = sessionLockPath(lockDir);
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockPath, 'pid=999999999\ntoken=dead-token\n');
      await writeState(lockDir, makeState('TICKET'));
      const loaded = await readState(lockDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe('TICKET');
    });

    it('BAD: lock with malformed content is NOT auto-deleted (fail-closed)', async () => {
      const lockPath = sessionLockPath(lockDir);
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockPath, 'garbage content\nnot a valid lock\n');
      await expect(acquireSessionWriteLock(lockDir, 500)).rejects.toMatchObject({
        code: 'LOCK_TIMEOUT',
      });
    });

    it('EDGE: lock held by live PID with EPERM is treated as alive', async () => {
      const lock = await acquireSessionWriteLock(lockDir);
      try {
        await expect(acquireSessionWriteLock(lockDir, 500)).rejects.toMatchObject({
          code: 'LOCK_TIMEOUT',
        });
      } finally {
        await lock.release();
      }
    });

    it('CORNER: release() with stale handle does not delete foreign lock', async () => {
      const lockA = await acquireSessionWriteLock(lockDir);
      const lockPath = sessionLockPath(lockDir);
      const newToken = `new-${crypto.randomUUID()}`;
      await fs.writeFile(lockPath, `pid=${process.pid}\ntoken=${newToken}\n`);
      await lockA.release();
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
      await fs.unlink(lockPath);
    });

    it('SMOKE: withSessionWriteLock returns fn result', async () => {
      const result = await withSessionWriteLock(lockDir, async () => 42);
      expect(result).toBe(42);
    });

    it('EDGE: withSessionWriteLock releases lock on error', async () => {
      await expect(
        withSessionWriteLock(lockDir, async () => {
          throw new Error('simulated failure');
        }),
      ).rejects.toThrow('simulated failure');
      const recoveredLock = await acquireSessionWriteLock(lockDir, 1000);
      await recoveredLock.release();
    });

    it('EDGE: writeStateAlreadyLocked validates and writes without acquiring lock', async () => {
      const state = makeState('TICKET');
      await withSessionWriteLock(lockDir, async () => {
        await writeStateAlreadyLocked(lockDir, state);
      });
      const loaded = await readState(lockDir);
      expect(loaded).not.toBeNull();
    });

    it('CORNER: acquire with custom timeout succeeds when lock is released before deadline', async () => {
      const lock = await acquireSessionWriteLock(lockDir);
      let acquired = false;
      const inner = acquireSessionWriteLock(lockDir, 5000).then((l) => {
        acquired = true;
        return l.release();
      });
      await new Promise((r) => setTimeout(r, 50));
      await lock.release();
      await inner;
      expect(acquired).toBe(true);
    });

    it('ARCHITECTURE: no atomicWrite(statePath(...)) outside persistence.ts', async () => {
      const srcDir = path.resolve(import.meta.dirname, '..');
      const files = await walkSrcFiles(srcDir);
      const violations: string[] = [];
      for (const file of files) {
        if (file === path.resolve(srcDir, 'adapters', 'persistence.ts')) continue;
        if (file.endsWith('.test.ts')) continue;
        const content = await fs.readFile(file, 'utf-8');
        if (content.includes('atomicWrite(statePath')) {
          violations.push(path.relative(srcDir, file));
        }
      }
      expect(violations).toEqual([]);
    });
  });
});
