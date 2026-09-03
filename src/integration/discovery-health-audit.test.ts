/**
 * @file discovery-health-audit.test.ts
 * @description Tests for the single Discovery-health gate-transition audit authority (#399).
 *
 * For a HIGH-RISK fail-closed gate, both blocking AND recovery must be auditable.
 * These tests assert the no-op contract (no audit on `none` transitions) and the
 * deterministic detail shape for block and clear (recovery) transitions.
 */

import { describe, it, expect } from 'vitest';

import { buildDiscoveryHealthGateTransitionDetail } from './discovery-health-audit.js';
import type { SessionState, DiscoveryHealthGate } from '../state/schema.js';
import { makeState } from '../fixtures.js';

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

describe('buildDiscoveryHealthGateTransitionDetail', () => {
  it('returns nothing when there is no auditable transition (clear -> clear)', () => {
    expect(buildDiscoveryHealthGateTransitionDetail(requiredState(), clear, clear)).toBeUndefined();
  });

  it('returns nothing on a repeated identical block', () => {
    expect(
      buildDiscoveryHealthGateTransitionDetail(requiredState(), blocked, blocked),
    ).toBeUndefined();
  });

  it('builds a blocked transition with the deterministic detail shape', () => {
    const detail = buildDiscoveryHealthGateTransitionDetail(requiredState(), undefined, blocked);
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

  it('builds a clear (recovery) transition so unblocks are auditable', () => {
    const detail = buildDiscoveryHealthGateTransitionDetail(requiredState(), blocked, clear);
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

  it('builds an event when a blocked reason changes', () => {
    const reblocked: DiscoveryHealthGate = {
      status: 'blocked',
      code: 'DISCOVERY_DRIFT_BLOCKED',
      message: 'drifted',
      blockedAt: NOW,
      lastDriftAssessment: 'drifted',
    };
    const detail = buildDiscoveryHealthGateTransitionDetail(requiredState(), blocked, reblocked);
    expect(detail).toMatchObject({
      transition: 'block_reason_changed',
      decision: 'blocked',
      reasonCode: 'DISCOVERY_DRIFT_BLOCKED',
      previousReasonCode: 'DISCOVERY_HEALTH_UNAVAILABLE',
    });
  });
});
