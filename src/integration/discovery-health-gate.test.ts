/**
 * Tests for the pure Discovery-health gate authority (#399).
 *
 * These are deterministic, IO-free unit tests covering the escalate-only seam
 * decision and the sole clear authority at hydrate, with emphasis on
 * fail-closed (negative) paths.
 */

import { describe, it, expect } from 'vitest';

import {
  isDiscoveryHealthAllowed,
  reconcileDiscoveryHealthGate,
  classifyGateTransition,
  evaluateDiscoveryEvidenceGate,
} from './discovery-health-gate.js';
import {
  extractDiscoveryHealth,
  unavailableDiscoveryHealth,
  type DiscoveryHealthProjection,
} from '../discovery/discovery-health.js';
import type { DiscoveryHealthPolicy } from '../config/policy-types.js';
import type { DiscoveryHealthGate } from '../state/schema.js';
import type { DiscoveryResult } from '../discovery/types.js';

const NOW = '2026-01-01T00:00:00.000Z';

const REQUIRED_BLOCK: DiscoveryHealthPolicy = {
  enforcement: 'required',
  onDegraded: 'block',
  onDrift: 'block',
};

function healthy(): DiscoveryHealthProjection {
  const result = {
    schemaVersion: 'v1',
    collectedAt: NOW,
    diagnostics: [{ name: 'git', status: 'complete' }],
  } as unknown as DiscoveryResult;
  return extractDiscoveryHealth(result);
}

function degraded(): DiscoveryHealthProjection {
  const result = {
    schemaVersion: 'v1',
    collectedAt: NOW,
    diagnostics: [{ name: 'git', status: 'failed' }],
  } as unknown as DiscoveryResult;
  return extractDiscoveryHealth(result);
}

describe('isDiscoveryHealthAllowed — escalate-only seam', () => {
  it('allows when enforcement is off regardless of evidence', () => {
    const decision = isDiscoveryHealthAllowed({
      policy: { enforcement: 'off', onDegraded: 'block', onDrift: 'block' },
      health: unavailableDiscoveryHealth('missing'),
    });
    expect(decision.allowed).toBe(true);
  });

  it('allows when enforcement is advisory even with unavailable evidence', () => {
    const decision = isDiscoveryHealthAllowed({
      policy: { enforcement: 'advisory', onDegraded: 'block', onDrift: 'block' },
      health: unavailableDiscoveryHealth('corrupt'),
    });
    expect(decision.allowed).toBe(true);
  });

  it('blocks UNAVAILABLE when required and Discovery is unavailable', () => {
    const decision = isDiscoveryHealthAllowed({
      policy: REQUIRED_BLOCK,
      health: unavailableDiscoveryHealth('missing'),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('DISCOVERY_HEALTH_UNAVAILABLE');
  });

  it('blocks DEGRADED when required, available-but-degraded, onDegraded=block', () => {
    const decision = isDiscoveryHealthAllowed({
      policy: REQUIRED_BLOCK,
      health: degraded(),
      cachedDrift: 'clean',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('DISCOVERY_HEALTH_DEGRADED');
  });

  it('allows degraded when onDegraded=warn', () => {
    const decision = isDiscoveryHealthAllowed({
      policy: { enforcement: 'required', onDegraded: 'warn', onDrift: 'block' },
      health: degraded(),
      cachedDrift: 'clean',
    });
    expect(decision.allowed).toBe(true);
  });

  it('blocks DRIFT when cached drift is not clean and onDrift=block', () => {
    const decision = isDiscoveryHealthAllowed({
      policy: REQUIRED_BLOCK,
      health: healthy(),
      cachedDrift: 'drifted',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('DISCOVERY_DRIFT_BLOCKED');
    expect(decision.driftStatus).toBe('drifted');
  });

  it('fails closed treating absent cached drift as not_checked under onDrift=block', () => {
    const decision = isDiscoveryHealthAllowed({
      policy: REQUIRED_BLOCK,
      health: healthy(),
      // cachedDrift omitted
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('DISCOVERY_DRIFT_BLOCKED');
    expect(decision.driftStatus).toBe('not_checked');
  });

  it('allows healthy + clean drift under required', () => {
    const decision = isDiscoveryHealthAllowed({
      policy: REQUIRED_BLOCK,
      health: healthy(),
      cachedDrift: 'clean',
    });
    expect(decision.allowed).toBe(true);
  });

  it('keeps an existing blocked gate blocked (never clears at the seam)', () => {
    const existingGate: DiscoveryHealthGate = {
      status: 'blocked',
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
      message: 'prior block',
      blockedAt: NOW,
      lastDriftAssessment: 'unavailable',
    };
    const decision = isDiscoveryHealthAllowed({
      policy: REQUIRED_BLOCK,
      health: healthy(),
      cachedDrift: 'clean',
      existingGate,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('DISCOVERY_HEALTH_UNAVAILABLE');
    expect(decision.message).toBe('prior block');
  });
});

describe('reconcileDiscoveryHealthGate — sole clear authority', () => {
  it('clears (no drift IO needed) when enforcement is not required', () => {
    const gate = reconcileDiscoveryHealthGate({
      policy: { enforcement: 'off', onDegraded: 'block', onDrift: 'block' },
      health: unavailableDiscoveryHealth('missing'),
      driftAssessment: 'not_checked',
      now: NOW,
    });
    expect(gate.status).toBe('clear');
  });

  it('clears when required and Discovery is healthy with clean drift', () => {
    const gate = reconcileDiscoveryHealthGate({
      policy: REQUIRED_BLOCK,
      health: healthy(),
      driftAssessment: 'clean',
      now: NOW,
    });
    expect(gate.status).toBe('clear');
    expect(gate.lastDriftAssessment).toBe('clean');
  });

  it('blocks UNAVAILABLE when required and Discovery unavailable', () => {
    const gate = reconcileDiscoveryHealthGate({
      policy: REQUIRED_BLOCK,
      health: unavailableDiscoveryHealth('schema_invalid'),
      driftAssessment: 'unavailable',
      now: NOW,
    });
    expect(gate.status).toBe('blocked');
    if (gate.status === 'blocked') expect(gate.code).toBe('DISCOVERY_HEALTH_UNAVAILABLE');
  });

  it('blocks DRIFT when required, healthy, but drift not clean and onDrift=block', () => {
    const gate = reconcileDiscoveryHealthGate({
      policy: REQUIRED_BLOCK,
      health: healthy(),
      driftAssessment: 'drifted',
      now: NOW,
    });
    expect(gate.status).toBe('blocked');
    if (gate.status === 'blocked') {
      expect(gate.code).toBe('DISCOVERY_DRIFT_BLOCKED');
      expect(gate.lastDriftAssessment).toBe('drifted');
    }
  });

  it('clears a previously-blocked gate once evidence is healthy and clean', () => {
    const gate = reconcileDiscoveryHealthGate({
      policy: REQUIRED_BLOCK,
      health: healthy(),
      driftAssessment: 'clean',
      now: NOW,
    });
    expect(gate.status).toBe('clear');
  });
});

describe('classifyGateTransition — auditable transitions only', () => {
  const blocked = (over: Partial<Extract<DiscoveryHealthGate, { status: 'blocked' }>> = {}) =>
    ({
      status: 'blocked',
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
      message: 'm',
      blockedAt: NOW,
      lastDriftAssessment: 'unavailable',
      ...over,
    }) as DiscoveryHealthGate;
  const clear = (): DiscoveryHealthGate => ({ status: 'clear', clearedAt: NOW });

  it('undefined -> blocked is to_blocked', () => {
    expect(classifyGateTransition(undefined, blocked())).toBe('to_blocked');
  });

  it('clear -> blocked is to_blocked', () => {
    expect(classifyGateTransition(clear(), blocked())).toBe('to_blocked');
  });

  it('blocked -> clear is to_clear (recovery is auditable)', () => {
    expect(classifyGateTransition(blocked(), clear())).toBe('to_clear');
  });

  it('blocked -> blocked with same reason is none (no duplicate audit)', () => {
    expect(classifyGateTransition(blocked(), blocked())).toBe('none');
  });

  it('blocked -> blocked with changed code is block_reason_changed', () => {
    expect(classifyGateTransition(blocked(), blocked({ code: 'DISCOVERY_DRIFT_BLOCKED' }))).toBe(
      'block_reason_changed',
    );
  });

  it('undefined -> clear is none', () => {
    expect(classifyGateTransition(undefined, clear())).toBe('none');
  });

  it('clear -> clear is none', () => {
    expect(classifyGateTransition(clear(), clear())).toBe('none');
  });
});

describe('evaluateDiscoveryEvidenceGate — read-only computed projection', () => {
  it('passes when enforcement is off regardless of unhealthy evidence', () => {
    const p = evaluateDiscoveryEvidenceGate(
      { enforcement: 'off', onDegraded: 'block', onDrift: 'block' },
      unavailableDiscoveryHealth('missing'),
      'drifted',
    );
    expect(p.action).toBe('pass');
    expect(p.code).toBeNull();
    expect(p.source).toBe('computed_from_current_status_projection');
  });

  it('blocks UNAVAILABLE when required and Discovery unavailable', () => {
    const p = evaluateDiscoveryEvidenceGate(
      REQUIRED_BLOCK,
      unavailableDiscoveryHealth('missing'),
      'clean',
    );
    expect(p.action).toBe('block');
    expect(p.code).toBe('DISCOVERY_HEALTH_UNAVAILABLE');
  });

  it('downgrades block to warn under advisory enforcement (never blocks)', () => {
    const p = evaluateDiscoveryEvidenceGate(
      { enforcement: 'advisory', onDegraded: 'block', onDrift: 'block' },
      unavailableDiscoveryHealth('missing'),
      'drifted',
    );
    expect(p.action).toBe('warn');
  });

  it('precedence: unavailable block wins over drift', () => {
    const p = evaluateDiscoveryEvidenceGate(
      REQUIRED_BLOCK,
      unavailableDiscoveryHealth('missing'),
      'drifted',
    );
    expect(p.code).toBe('DISCOVERY_HEALTH_UNAVAILABLE');
  });

  it('blocks DRIFT when healthy but drift not clean and onDrift=block', () => {
    const p = evaluateDiscoveryEvidenceGate(REQUIRED_BLOCK, healthy(), 'drifted');
    expect(p.action).toBe('block');
    expect(p.code).toBe('DISCOVERY_DRIFT_BLOCKED');
  });

  it('passes when healthy and drift clean under required', () => {
    const p = evaluateDiscoveryEvidenceGate(REQUIRED_BLOCK, healthy(), 'clean');
    expect(p.action).toBe('pass');
    expect(p.code).toBeNull();
  });

  it('warns degraded when onDegraded=warn', () => {
    const p = evaluateDiscoveryEvidenceGate(
      { enforcement: 'required', onDegraded: 'warn', onDrift: 'block' },
      degraded(),
      'clean',
    );
    expect(p.action).toBe('warn');
    expect(p.code).toBe('DISCOVERY_HEALTH_DEGRADED');
  });
});
