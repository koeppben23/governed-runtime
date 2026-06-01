/**
 * @file status-discovery-health.test.ts
 * @description Read-only surface tests for the Discovery-health gate in status (#399).
 *
 * Status MUST surface the persisted gate without ever mutating or clearing it.
 * These tests assert the projection shape and that the input state is untouched.
 */

import { describe, it, expect } from 'vitest';

import { buildDiscoveryHealthGateStatus } from './status-tool.js';
import type { SessionState } from '../../state/schema.js';
import { makeState } from '../../__fixtures__.js';

describe('buildDiscoveryHealthGateStatus (read-only)', () => {
  it('returns null when no gate is persisted', () => {
    const state = makeState('READY');
    expect(buildDiscoveryHealthGateStatus(state)).toBeNull();
  });

  it('projects a blocked gate without mutating the input state', () => {
    const gate: SessionState['discoveryHealthGate'] = {
      status: 'blocked',
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
      message: 'Discovery unavailable',
      blockedAt: '2026-01-01T00:00:00.000Z',
      lastDriftAssessment: 'unavailable',
    };
    const state = makeState('IMPLEMENTATION', { discoveryHealthGate: gate });
    const before = structuredClone(state.discoveryHealthGate);

    const projection = buildDiscoveryHealthGateStatus(state);

    expect(projection).toEqual({
      status: 'blocked',
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
      message: 'Discovery unavailable',
      blockedAt: '2026-01-01T00:00:00.000Z',
      lastDriftAssessment: 'unavailable',
    });
    // Read-only guarantee: the persisted gate is untouched.
    expect(state.discoveryHealthGate).toEqual(before);
  });

  it('projects a clear gate with null defaults for absent fields', () => {
    const gate: SessionState['discoveryHealthGate'] = { status: 'clear' };
    const state = makeState('READY', { discoveryHealthGate: gate });

    const projection = buildDiscoveryHealthGateStatus(state);

    expect(projection).toEqual({
      status: 'clear',
      clearedAt: null,
      lastDriftAssessment: null,
    });
    expect(state.discoveryHealthGate).toEqual({ status: 'clear' });
  });
});
