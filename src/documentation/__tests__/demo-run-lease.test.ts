/**
 * @module documentation/demo-run-lease.test
 * @description The demo run lease must be exclusive across PROCESSES, identify
 * its owner by the long-lived wrapper PID, release only against the matching
 * token, and reclaim stale owners.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v2
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLease, demoLeasePath, releaseLease } from '../../../demos/lib/run-lease.mjs';

const CLI = join(process.cwd(), 'demos', 'lib', 'run-lease.mjs');
const roots: string[] = [];

function fakeRepo(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowguard-lease-test-${label}-`));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('lease wait timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    releaseLease(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('demo run lease', () => {
  describe('HAPPY — token-checked release', () => {
    it('blocks a second acquire and allows re-acquire after the owner releases', () => {
      const repo = fakeRepo('happy');
      const lease = acquireLease(repo);
      expect(lease.leaseFile).toBe(demoLeasePath(repo));
      expect(() => acquireLease(repo)).toThrow(/another demo run is active/);
      expect(lease.release()).toBe(true);
      const second = acquireLease(repo);
      second.release();
    });
  });

  describe('BAD — a live owner and foreign tokens are never displaced', () => {
    it('rejects a lease owned by this live process', () => {
      const repo = fakeRepo('bad');
      const lease = acquireLease(repo);
      try {
        expect(() => acquireLease(repo, { pid: process.pid })).toThrow(/active/);
      } finally {
        lease.release();
      }
    });

    it('never releases a lease with a foreign token', () => {
      const repo = fakeRepo('foreign');
      const lease = acquireLease(repo);
      expect(releaseLease(repo, 'not-the-token')).toBe(false);
      expect(existsSync(lease.leaseFile)).toBe(true);
      lease.release();
    });
  });

  describe('CORNER — stale owners are reclaimed', () => {
    it('reclaims a lease whose owner process is gone', () => {
      const repo = fakeRepo('stale');
      acquireLease(repo, { pid: 999_999 });
      const reclaimed = acquireLease(repo, { pid: process.pid });
      expect(reclaimed.token).toBeDefined();
      reclaimed.release();
    });
  });

  describe('EDGE — real two-process exclusivity across the CLI boundary', () => {
    it('keeps a concurrent acquire out while the holder process is alive', async () => {
      const repo = fakeRepo('two-process');
      const holder = spawn(process.execPath, [CLI, 'hold', '--repo', repo, '--hold-ms', '4000'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        await waitFor(() => existsSync(demoLeasePath(repo)));
        const second = spawnSync(process.execPath, [CLI, 'acquire', '--repo', repo], {
          encoding: 'utf8',
        });
        expect(second.status).not.toBe(0);
        expect(second.stderr).toMatch(/another demo run is active/);
      } finally {
        holder.kill('SIGTERM');
        await new Promise((resolve) => holder.once('exit', resolve));
      }
      // After the holder exits, the lease is released and acquirable again.
      await waitFor(() => !existsSync(demoLeasePath(repo)));
      const lease = acquireLease(repo);
      lease.release();
    });
  });
});
