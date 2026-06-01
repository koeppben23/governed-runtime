/**
 * @file discovery-health-audit.test.ts
 * @description Tests for the single Discovery-health gate-transition audit authority (#399).
 *
 * For a HIGH-RISK fail-closed gate, both blocking AND recovery must be auditable.
 * These tests assert the no-op contract (no audit on `none` transitions) and the
 * deterministic detail shape emitted for block and clear (recovery) transitions.
 * The underlying `appendReviewAuditEvent` IO is mocked so the detail payload can
 * be asserted directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAppend } = vi.hoisted(() => ({
  mockAppend: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock('./review/audit-events.js', () => ({
  appendReviewAuditEvent: mockAppend,
}));

import { auditDiscoveryHealthGateTransition } from './discovery-health-audit.js';
import type { SessionState, DiscoveryHealthGate } from '../state/schema.js';
import { makeState } from '../__fixtures__.js';

const NOW = '2026-01-01T00:00:00.000Z';

function requiredState(): SessionState {
  const base = makeState('IMPLEMENTATION');
  return makeState('IMPLEMENTATION', {
    policySnapshot: {
      ...base.policySnapshot,
      discoveryHealth: { enforcement: 'required', onDegraded: 'block', onDrift: 'block' },
    },
  });
}

const blocked: DiscoveryHealthGate = {
  status: 'blocked',
  code: 'DISCOVERY_HEALTH_UNAVAILABLE',
  message: 'Discovery unavailable',
  blockedAt: NOW,
  lastDriftAssessment: 'unavailable',
};

const clear: DiscoveryHealthGate = {
  status: 'clear',
  clearedAt: NOW,
  lastDriftAssessment: 'clean',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAppend.mockResolvedValue(undefined);
});

describe('auditDiscoveryHealthGateTransition', () => {
  it('does NOT emit when there is no auditable transition (clear -> clear)', async () => {
    await auditDiscoveryHealthGateTransition('/tmp/sess', requiredState(), clear, clear);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('does NOT emit on a repeated identical block (blocked -> blocked, same reason)', async () => {
    await auditDiscoveryHealthGateTransition('/tmp/sess', requiredState(), blocked, blocked);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('emits a blocked transition with the deterministic detail shape', async () => {
    await auditDiscoveryHealthGateTransition('/tmp/sess', requiredState(), undefined, blocked);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    const [sessDir, , , event, detail] = mockAppend.mock.calls[0]!;
    expect(sessDir).toBe('/tmp/sess');
    expect(event).toBe('discovery_health:gate_changed');
    expect(detail).toMatchObject({
      transition: 'to_blocked',
      decision: 'blocked',
      reasonCode: 'DISCOVERY_HEALTH_UNAVAILABLE',
      message: 'Discovery unavailable',
      driftStatus: 'unavailable',
      previousGateStatus: 'none',
      previousReasonCode: null,
      enforcement: 'required',
    });
  });

  it('emits a clear (recovery) transition so unblocks are auditable', async () => {
    await auditDiscoveryHealthGateTransition('/tmp/sess', requiredState(), blocked, clear);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    const detail = mockAppend.mock.calls[0]![4] as Record<string, unknown>;
    expect(detail).toMatchObject({
      transition: 'to_clear',
      decision: 'cleared',
      reasonCode: null,
      message: null,
      driftStatus: 'clean',
      previousGateStatus: 'blocked',
      previousReasonCode: 'DISCOVERY_HEALTH_UNAVAILABLE',
    });
  });

  it('emits when a blocked reason changes (block_reason_changed)', async () => {
    const reblocked: DiscoveryHealthGate = {
      status: 'blocked',
      code: 'DISCOVERY_DRIFT_BLOCKED',
      message: 'drifted',
      blockedAt: NOW,
      lastDriftAssessment: 'drifted',
    };
    await auditDiscoveryHealthGateTransition('/tmp/sess', requiredState(), blocked, reblocked);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    const detail = mockAppend.mock.calls[0]![4] as Record<string, unknown>;
    expect(detail).toMatchObject({
      transition: 'block_reason_changed',
      decision: 'blocked',
      reasonCode: 'DISCOVERY_DRIFT_BLOCKED',
      previousReasonCode: 'DISCOVERY_HEALTH_UNAVAILABLE',
    });
  });
});
