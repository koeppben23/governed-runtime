/**
 * @module documentation/demo-run-lease.test
 * @description The demo run lease must be exclusive, reclaim stale owners, and
 * be released on every exit path so two wrappers never build concurrently.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLease, demoLeasePath, releaseLease } from '../../../demos/lib/run-lease.mjs';

const roots: string[] = [];

function fakeRepo(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowguard-lease-test-${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    releaseLease(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('demo run lease', () => {
  describe('HAPPY — exclusive acquire and release', () => {
    it('acquires, blocks a second acquire, and allows re-acquire after release', () => {
      const repo = fakeRepo('happy');
      const lease = acquireLease(repo);
      expect(lease.leaseDir).toBe(demoLeasePath(repo));
      expect(() => acquireLease(repo)).toThrow(/another demo run is active/);
      lease.release();
      const second = acquireLease(repo);
      second.release();
    });
  });

  describe('BAD — a live owner is never displaced', () => {
    it('rejects a lease owned by this live process', () => {
      const repo = fakeRepo('bad');
      const lease = acquireLease(repo);
      try {
        expect(() => acquireLease(repo, { pid: process.pid })).toThrow(/active/);
      } finally {
        lease.release();
      }
    });
  });

  describe('CORNER — stale owners are reclaimed', () => {
    it('reclaims a lease whose owner process is gone', () => {
      const repo = fakeRepo('stale');
      const leaseDir = demoLeasePath(repo);
      acquireLease(repo, { pid: 999_999 }).release();
      // Simulate a crashed owner: recreate the lease directory with a dead PID.
      acquireLease(repo, { pid: 999_999 });
      writeFileSync(
        join(leaseDir, 'owner.json'),
        JSON.stringify({ pid: 999_999, repo, startedAt: '2026-01-01T00:00:00.000Z' }),
      );
      const reclaimed = acquireLease(repo);
      reclaimed.release();
    });
  });

  describe('EDGE — lease identity is per checkout', () => {
    it('is deterministic for one repo and distinct for another', () => {
      const first = fakeRepo('edge-a');
      const second = fakeRepo('edge-b');
      expect(demoLeasePath(first)).toBe(demoLeasePath(first));
      expect(demoLeasePath(first)).not.toBe(demoLeasePath(second));
    });
  });
});
