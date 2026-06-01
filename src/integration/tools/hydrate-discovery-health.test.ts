/**
 * @file hydrate-discovery-health.test.ts
 * @description Lifecycle tests for the hydrate-side Discovery-health reconcile (#399).
 *
 * `reconcileHydrateDiscoveryHealthGate` is the ONLY authority that may clear a
 * blocked gate. These tests assert: pass-through on non-ok results, drift IO is
 * skipped unless enforcement is 'required', and the reconciled gate is attached
 * to the returned state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoadContext, mockBuildDrift } = vi.hoisted(() => ({
  mockLoadContext: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockBuildDrift: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('../../discovery/discovery-health.js', async () => {
  const actual = await vi.importActual<typeof import('../../discovery/discovery-health.js')>(
    '../../discovery/discovery-health.js',
  );
  return { ...actual, loadDiscoveryHealthContext: mockLoadContext };
});

vi.mock('../discovery-drift-status.js', () => ({
  buildDiscoveryDriftStatus: mockBuildDrift,
}));

import { reconcileHydrateDiscoveryHealthGate } from './hydrate.js';
import {
  unavailableDiscoveryHealth,
  extractDiscoveryHealth,
} from '../../discovery/discovery-health.js';
import type { RailResult } from '../../rails/types.js';
import type { SessionState } from '../../state/schema.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import { makeState } from '../../__fixtures__.js';

const NOW = '2026-01-01T00:00:00.000Z';

function healthyProjection() {
  const result = {
    schemaVersion: 'v1',
    collectedAt: NOW,
    diagnostics: [{ name: 'git', status: 'complete' }],
  } as unknown as DiscoveryResult;
  return extractDiscoveryHealth(result);
}

function okResult(discoveryHealth: SessionState['policySnapshot']['discoveryHealth']): RailResult {
  const base = makeState('READY');
  const state = makeState('READY', {
    policySnapshot: { ...base.policySnapshot, discoveryHealth },
  });
  return { kind: 'ok', state, evalResult: {} as never, transitions: [] };
}

const ctx = {
  workspaceDir: '/tmp/ws',
  worktree: '/tmp/repo',
  fingerprint: 'fp-1',
  now: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadContext.mockResolvedValue({ discoveryHealth: healthyProjection() });
  mockBuildDrift.mockResolvedValue({ status: 'clean' });
});

describe('reconcileHydrateDiscoveryHealthGate', () => {
  it('passes blocked rail results through unchanged (no IO)', async () => {
    const blocked: RailResult = { kind: 'blocked', code: 'X', reason: 'nope' };
    const out = await reconcileHydrateDiscoveryHealthGate(blocked, ctx);
    expect(out).toBe(blocked);
    expect(mockLoadContext).not.toHaveBeenCalled();
    expect(mockBuildDrift).not.toHaveBeenCalled();
  });

  it('skips the bounded drift IO when enforcement is not required', async () => {
    const result = okResult({ enforcement: 'off', onDegraded: 'allow', onDrift: 'allow' });
    const out = await reconcileHydrateDiscoveryHealthGate(result, ctx);
    expect(mockBuildDrift).not.toHaveBeenCalled();
    if (out.kind === 'ok') expect(out.state.discoveryHealthGate?.status).toBe('clear');
  });

  it('runs the drift check and clears the gate when required + healthy + clean', async () => {
    const result = okResult({ enforcement: 'required', onDegraded: 'warn', onDrift: 'block' });
    const out = await reconcileHydrateDiscoveryHealthGate(result, ctx);
    expect(mockBuildDrift).toHaveBeenCalledTimes(1);
    if (out.kind === 'ok') {
      expect(out.state.discoveryHealthGate?.status).toBe('clear');
      expect(out.state.discoveryHealthGate?.lastDriftAssessment).toBe('clean');
    }
  });

  it('blocks the gate when required and Discovery is unavailable', async () => {
    mockLoadContext.mockResolvedValue({ discoveryHealth: unavailableDiscoveryHealth('missing') });
    mockBuildDrift.mockResolvedValue({ status: 'unavailable' });
    const result = okResult({ enforcement: 'required', onDegraded: 'warn', onDrift: 'block' });
    const out = await reconcileHydrateDiscoveryHealthGate(result, ctx);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.state.discoveryHealthGate?.status).toBe('blocked');
    }
  });

  it('blocks the gate when required, healthy, but drift is not clean', async () => {
    mockBuildDrift.mockResolvedValue({ status: 'drifted' });
    const result = okResult({ enforcement: 'required', onDegraded: 'warn', onDrift: 'block' });
    const out = await reconcileHydrateDiscoveryHealthGate(result, ctx);
    if (out.kind === 'ok') {
      expect(out.state.discoveryHealthGate?.status).toBe('blocked');
      expect(out.state.discoveryHealthGate?.lastDriftAssessment).toBe('drifted');
    }
  });
});
