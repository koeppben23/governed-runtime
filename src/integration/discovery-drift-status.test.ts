/**
 * @module integration/discovery-drift-status.test
 * @description Focused tests for read-only discovery drift status projection.
 */

import { describe, expect, it } from 'vitest';

import type { DriftResult } from '../discovery/drift.js';
import {
  buildDiscoveryDriftStatus,
  notCheckedDiscoveryDriftStatus,
} from './discovery/discovery-drift-status.js';

const CLEAN_DRIFT: DriftResult = {
  drifted: false,
  currentDigest: 'current-digest',
  persistedDigest: 'current-digest',
  diagnostics: [{ name: 'repo-metadata', status: 'complete', durationMs: 1, timedOut: false }],
};

describe('buildDiscoveryDriftStatus', () => {
  it('projects clean drift result with explicit clean status', async () => {
    const projection = await buildDiscoveryDriftStatus({
      workspaceDir: '/workspace',
      worktree: '/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      check: async () => CLEAN_DRIFT,
    });

    expect(projection).toMatchObject({
      kind: 'derived_discovery_drift',
      advisory: true,
      runtimeOnly: true,
      source: 'checkDiscoveryDrift',
      status: 'clean',
      drifted: false,
      currentDigest: 'current-digest',
      persistedDigest: 'current-digest',
    });
    expect(projection.diagnostics).toEqual(['repo-metadata:complete']);
  });

  it('projects drifted result with changed collector names', async () => {
    const projection = await buildDiscoveryDriftStatus({
      workspaceDir: '/workspace',
      worktree: '/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      check: async () => ({
        drifted: true,
        currentDigest: 'new-digest',
        persistedDigest: 'old-digest',
        changedContributors: ['stack-detection'],
      }),
    });

    expect(projection.status).toBe('drifted');
    expect(projection.drifted).toBe(true);
    expect(projection.changedContributorNames).toEqual(['stack-detection']);
  });

  it('makes drift with no contributor attribution explicit', async () => {
    const projection = await buildDiscoveryDriftStatus({
      workspaceDir: '/workspace',
      worktree: '/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      check: async () => ({
        drifted: true,
        currentDigest: 'new-digest',
        persistedDigest: 'old-digest',
        attributionStatus: 'unavailable',
      }),
    });

    expect(projection.status).toBe('drifted');
    expect(projection.warnings).toContainEqual(
      expect.objectContaining({ code: 'discovery_drift_attribution_incomplete' }),
    );
    expect(projection.notVerified.join('\n')).toContain('attribution is incomplete');
  });

  it('projects missing persisted discovery explicitly', async () => {
    const projection = await buildDiscoveryDriftStatus({
      workspaceDir: '/workspace',
      worktree: '/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      check: async () => ({ drifted: false, currentDigest: 'new-digest', persistedDigest: null }),
    });

    expect(projection.status).toBe('missing_discovery');
    expect(projection.drifted).toBeNull();
    expect(projection.currentDigest).toBe('new-digest');
    expect(projection.notVerified.join('\n')).toContain('Persisted discovery artifact is missing');
  });

  it('projects drift check failure as unavailable', async () => {
    const projection = await buildDiscoveryDriftStatus({
      workspaceDir: '/workspace',
      worktree: '/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      check: async () => {
        throw new Error('discovery file is corrupt');
      },
    });

    expect(projection.status).toBe('unavailable');
    expect(projection.drifted).toBeNull();
    expect(projection.warnings[0]).toMatchObject({ code: 'discovery_drift_unavailable' });
    expect(projection.notVerified.join('\n')).toContain('discovery file is corrupt');
  });

  it('projects timeout explicitly without pretending underlying work was cancelled', async () => {
    const projection = await buildDiscoveryDriftStatus({
      workspaceDir: '/workspace-timeout',
      worktree: '/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      timeoutMs: 1,
      check: () => new Promise<DriftResult>(() => {}),
    });

    expect(projection.status).toBe('timeout');
    expect(projection.warnings[0]?.message).toContain('status budget');
    expect(projection.warnings[0]?.message).toContain('Cancellation was requested');
  });

  it('BAD: requests cancellation on timeout and observes cooperative teardown', async () => {
    let observedSignal: AbortSignal | undefined;
    let active = 0;
    const projection = await buildDiscoveryDriftStatus({
      workspaceDir: '/workspace-cooperative-timeout',
      worktree: '/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      timeoutMs: 1,
      check: async (_ws, _wt, _fp, signal) => {
        observedSignal = signal;
        active += 1;
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return CLEAN_DRIFT;
        } finally {
          active -= 1;
        }
      },
    });
    expect(projection.status).toBe('timeout');
    expect(observedSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(active).toBe(0);
  });

  it('CORNER: parallel status requests share exactly one in-flight discovery', async () => {
    let finish!: (result: DriftResult) => void;
    let starts = 0;
    const check = async (): Promise<DriftResult> => {
      starts += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const input = {
      workspaceDir: '/workspace-singleflight',
      worktree: '/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      check,
    };
    const one = buildDiscoveryDriftStatus(input);
    const two = buildDiscoveryDriftStatus(input);
    await Promise.resolve();
    expect(starts).toBe(1);
    finish(CLEAN_DRIFT);
    const results = await Promise.all([one, two]);
    expect(results.map((result) => result.status)).toEqual(['clean', 'clean']);
  });

  it('EDGE: a non-cooperative timed-out check blocks new overlapping work', async () => {
    let starts = 0;
    const input = {
      workspaceDir: '/workspace-stuck',
      worktree: '/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      timeoutMs: 1,
      check: async (): Promise<DriftResult> => {
        starts += 1;
        return new Promise<DriftResult>(() => {});
      },
    };
    const timedOut = await buildDiscoveryDriftStatus(input);
    const later = await buildDiscoveryDriftStatus(input);
    expect(timedOut.status).toBe('timeout');
    expect(later.status).toBe('not_checked');
    expect(starts).toBe(1);
  });

  it('supports explicit not_checked status for skipped contexts', () => {
    const projection = notCheckedDiscoveryDriftStatus(
      'Focused status projections skip drift checks.',
    );

    expect(projection.status).toBe('not_checked');
    expect(projection.notVerified.join('\n')).toContain(
      'Focused status projections skip drift checks.',
    );
  });
});
