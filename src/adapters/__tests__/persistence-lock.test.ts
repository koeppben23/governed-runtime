import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  (globalThis as Record<string, unknown>).__persistenceLockFsActual = actual;
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => actual.writeFile(...args)),
    unlink: vi.fn((...args: Parameters<typeof actual.unlink>) => actual.unlink(...args)),
  };
});

import { PersistenceError } from '../persistence.js';
import {
  acquireSessionWriteLock,
  sessionLockPath,
  withSessionWriteLock,
} from '../persistence-lock.js';

type MockedFs = typeof import('node:fs/promises');

function actualFs(): MockedFs {
  return (globalThis as Record<string, unknown>).__persistenceLockFsActual as MockedFs;
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function restoreFsMocks(): void {
  const actual = actualFs();
  vi.mocked(fs.readFile).mockImplementation(((...args: Parameters<typeof fs.readFile>) =>
    actual.readFile(...args)) as typeof fs.readFile);
  vi.mocked(fs.writeFile).mockImplementation(((...args: Parameters<typeof fs.writeFile>) =>
    actual.writeFile(...args)) as typeof fs.writeFile);
  vi.mocked(fs.unlink).mockImplementation(((...args: Parameters<typeof fs.unlink>) =>
    actual.unlink(...args)) as typeof fs.unlink);
}

function mockProcessKillOnce(code: string, expectedPid: number): void {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (pid === expectedPid) throw errno(code, `${code} for ${expectedPid}`);
    return true;
  }) as typeof process.kill);
}

describe('persistence-lock', () => {
  let sessionDir: string;

  beforeEach(async () => {
    restoreFsMocks();
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-persistence-lock-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreFsMocks();
    await fs.rm(sessionDir, { recursive: true, force: true });
  });

  it('HAPPY: sessionLockPath resolves the canonical lockfile path', () => {
    expect(sessionLockPath('/tmp/session-a')).toBe(
      path.join('/tmp/session-a', 'session-state.json.lock'),
    );
  });

  it('HAPPY: acquireSessionWriteLock creates an atomic wx lock and release removes it', async () => {
    const lockPath = sessionLockPath(sessionDir);

    const lock = await acquireSessionWriteLock(sessionDir);
    const raw = await fs.readFile(lockPath, 'utf-8');

    expect(raw).toContain(`pid=${process.pid}\n`);
    expect(raw).toMatch(/^token=.+$/m);
    expect(fs.writeFile).toHaveBeenCalledWith(lockPath, expect.any(String), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });

    await lock.release();

    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('EDGE: release is token-protected and does not delete a foreign lockfile', async () => {
    const lockPath = sessionLockPath(sessionDir);
    const lock = await acquireSessionWriteLock(sessionDir);

    await fs.writeFile(lockPath, `pid=${process.pid}\ntoken=foreign-token\n`);

    await lock.release();

    await expect(fs.access(lockPath)).resolves.toBeUndefined();
    await fs.unlink(lockPath);
  });

  it('EDGE: release ignores an already-missing lockfile', async () => {
    const lockPath = sessionLockPath(sessionDir);
    const lock = await acquireSessionWriteLock(sessionDir);

    await fs.unlink(lockPath);

    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('CORNER: stale lock with dead PID is removed and reacquired', async () => {
    const stalePid = 987_654_321;
    const lockPath = sessionLockPath(sessionDir);
    await fs.writeFile(lockPath, `pid=${stalePid}\ntoken=dead-token\n`);
    mockProcessKillOnce('ESRCH', stalePid);

    const lock = await acquireSessionWriteLock(sessionDir);
    const raw = await fs.readFile(lockPath, 'utf-8');

    expect(raw).toContain(`pid=${process.pid}\n`);
    expect(raw).not.toContain('dead-token');

    await lock.release();
  });

  it('BAD: malformed lockfile is not auto-deleted and times out fail-closed', async () => {
    const lockPath = sessionLockPath(sessionDir);
    await fs.writeFile(lockPath, 'not a valid persistence lock\n');

    await expect(acquireSessionWriteLock(sessionDir, 0)).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
    });

    await expect(fs.readFile(lockPath, 'utf-8')).resolves.toBe('not a valid persistence lock\n');
  });

  it('BAD: live lock timeout reports LOCK_TIMEOUT with blocking PID and lockfile', async () => {
    const lockPath = sessionLockPath(sessionDir);
    const lock = await acquireSessionWriteLock(sessionDir);

    try {
      await expect(acquireSessionWriteLock(sessionDir, 0)).rejects.toMatchObject({
        code: 'LOCK_TIMEOUT',
        message: expect.stringContaining(`Blocking PID: ${process.pid}`),
      });
      await expect(acquireSessionWriteLock(sessionDir, 0)).rejects.toMatchObject({
        message: expect.stringContaining(lockPath),
      });
    } finally {
      await lock.release();
    }
  });

  it('BAD: EPERM process liveness is treated as alive and fails closed', async () => {
    const protectedPid = 246_810;
    const lockPath = sessionLockPath(sessionDir);
    await fs.writeFile(lockPath, `pid=${protectedPid}\ntoken=protected-token\n`);
    mockProcessKillOnce('EPERM', protectedPid);

    await expect(acquireSessionWriteLock(sessionDir, 0)).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
    });

    await expect(fs.readFile(lockPath, 'utf-8')).resolves.toContain('protected-token');
  });

  it('BAD: unreadable lockfile is treated as alive and fails closed', async () => {
    const lockPath = sessionLockPath(sessionDir);
    await fs.writeFile(lockPath, `pid=${process.pid}\ntoken=unreadable-token\n`);
    vi.mocked(fs.readFile).mockImplementation(((
      file: Parameters<typeof fs.readFile>[0],
      ...args: unknown[]
    ) => {
      if (String(file) === lockPath) throw errno('EACCES', 'permission denied');
      return actualFs().readFile(file, ...(args as []));
    }) as typeof fs.readFile);

    await expect(acquireSessionWriteLock(sessionDir, 0)).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
    });

    restoreFsMocks();
    await expect(fs.readFile(lockPath, 'utf-8')).resolves.toContain('unreadable-token');
  });

  it('BAD: stale lock unlink EACCES returns LOCK_TIMEOUT instead of falling back', async () => {
    const stalePid = 135_791;
    const lockPath = sessionLockPath(sessionDir);
    await fs.writeFile(lockPath, `pid=${stalePid}\ntoken=dead-token\n`);
    mockProcessKillOnce('ESRCH', stalePid);
    vi.mocked(fs.unlink).mockImplementation(((file: Parameters<typeof fs.unlink>[0]) => {
      if (String(file) === lockPath) throw errno('EACCES', 'permission denied');
      return actualFs().unlink(file);
    }) as typeof fs.unlink);

    await expect(acquireSessionWriteLock(sessionDir, 0)).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
      message: expect.stringContaining('Cannot remove stale lock file'),
    });

    restoreFsMocks();
    await expect(fs.readFile(lockPath, 'utf-8')).resolves.toContain('dead-token');
  });

  it('CORNER: disappeared lockfile during stale check is treated as stale and retried', async () => {
    const lockPath = sessionLockPath(sessionDir);
    let writeAttempts = 0;

    vi.mocked(fs.writeFile).mockImplementation(((
      file: Parameters<typeof fs.writeFile>[0],
      ...args: unknown[]
    ) => {
      if (String(file) === lockPath && writeAttempts === 0) {
        writeAttempts += 1;
        throw errno('EEXIST', 'lock already exists');
      }
      writeAttempts += 1;
      return actualFs().writeFile(file, ...(args as []));
    }) as typeof fs.writeFile);
    vi.mocked(fs.readFile).mockImplementation(((
      file: Parameters<typeof fs.readFile>[0],
      ...args: unknown[]
    ) => {
      if (String(file) === lockPath) throw errno('ENOENT', 'lock disappeared');
      return actualFs().readFile(file, ...(args as []));
    }) as typeof fs.readFile);

    const lock = await acquireSessionWriteLock(sessionDir, 1000);

    restoreFsMocks();
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
    expect(writeAttempts).toBe(2);

    await lock.release();
  });

  it('EDGE: concurrent acquisition waits until the held lock is released', async () => {
    const firstLock = await acquireSessionWriteLock(sessionDir);
    let secondAcquired = false;

    const second = acquireSessionWriteLock(sessionDir, 2000).then(async (lock) => {
      secondAcquired = true;
      await lock.release();
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondAcquired).toBe(false);

    await firstLock.release();
    await second;

    expect(secondAcquired).toBe(true);
  });

  it('HAPPY: withSessionWriteLock returns the callback result and releases the lock', async () => {
    const result = await withSessionWriteLock(sessionDir, async () => 'locked-result');

    expect(result).toBe('locked-result');
    const lock = await acquireSessionWriteLock(sessionDir, 1000);
    await lock.release();
  });

  it('EDGE: withSessionWriteLock releases the lock when the callback fails', async () => {
    await expect(
      withSessionWriteLock(sessionDir, async () => {
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');

    const lock = await acquireSessionWriteLock(sessionDir, 1000);
    await lock.release();
  });

  it('BAD: lock timeout rejects with PersistenceError', async () => {
    const lock = await acquireSessionWriteLock(sessionDir);

    try {
      await expect(acquireSessionWriteLock(sessionDir, 0)).rejects.toBeInstanceOf(PersistenceError);
    } finally {
      await lock.release();
    }
  });
});
