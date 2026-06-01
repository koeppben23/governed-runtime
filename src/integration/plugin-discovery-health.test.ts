/**
 * @file plugin-discovery-health.test.ts
 * @description Negative-path tests for the Discovery health enforcement seam (#399).
 *
 * Mirrors plugin-risk.test.ts: external module deps are mocked via vi.hoisted()
 * refs so the seam's persist/audit/block behavior can be asserted deterministically.
 * The pure decision authority isDiscoveryHealthAllowed is mocked here; its own
 * logic is covered in discovery-health-gate.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockWriteState,
  mockReadState,
  mockLoadContext,
  mockBuildEnforcementError,
  mockStrictBlockedOutput,
  mockIsAllowed,
  mockAppendReviewAuditEvent,
} = vi.hoisted(() => ({
  mockWriteState: vi.fn<(...args: unknown[]) => Promise<void>>(),
  mockReadState: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockLoadContext: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockBuildEnforcementError:
    vi.fn<(code: string, reason: string, detail?: Record<string, unknown>) => Error>(),
  mockStrictBlockedOutput: vi.fn<(code: string, detail: Record<string, string>) => string>(),
  mockIsAllowed: vi.fn<(input: unknown) => unknown>(),
  mockAppendReviewAuditEvent: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock('../adapters/persistence.js', () => ({
  writeState: mockWriteState,
  readState: mockReadState,
}));

vi.mock('../discovery/discovery-health.js', async () => {
  const actual = await vi.importActual<typeof import('../discovery/discovery-health.js')>(
    '../discovery/discovery-health.js',
  );
  return {
    ...actual,
    loadDiscoveryHealthContext: mockLoadContext,
  };
});

vi.mock('./plugin-helpers.js', () => ({
  buildEnforcementError: mockBuildEnforcementError,
  strictBlockedOutput: mockStrictBlockedOutput,
}));

vi.mock('./discovery-health-gate.js', () => ({
  isDiscoveryHealthAllowed: mockIsAllowed,
}));

vi.mock('./review/audit-events.js', () => ({
  appendReviewAuditEvent: mockAppendReviewAuditEvent,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
});

import {
  enforceDiscoveryHealthBefore,
  enforceDiscoveryHealthAfterBash,
  type DiscoveryHealthEnforcementDeps,
} from './plugin-discovery-health.js';
import type { SessionState } from '../state/schema.js';
import { makeState } from '../__fixtures__.js';

function requiredState(overrides: Partial<SessionState> = {}): SessionState {
  const base = makeState('IMPLEMENTATION');
  return makeState('IMPLEMENTATION', {
    policySnapshot: {
      ...base.policySnapshot,
      discoveryHealth: { enforcement: 'required', onDegraded: 'block', onDrift: 'block' },
    },
    ...overrides,
  });
}

function mockDeps(
  overrides: Partial<DiscoveryHealthEnforcementDeps> = {},
): DiscoveryHealthEnforcementDeps {
  return {
    getSessionDir: vi.fn().mockReturnValue('/tmp/sess'),
    getWorkspaceDir: vi.fn().mockReturnValue('/tmp/ws'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteState.mockResolvedValue(undefined);
  mockReadState.mockResolvedValue(undefined);
  mockLoadContext.mockResolvedValue({
    discoveryHealth: { available: true, status: 'complete' },
  });
  mockBuildEnforcementError.mockImplementation((code, reason) => {
    const err = new Error(`${code}: ${reason}`);
    err.name = code;
    return err;
  });
  mockStrictBlockedOutput.mockImplementation(
    (code, detail) => `BLOCKED: ${code} (${JSON.stringify(detail)})`,
  );
  mockIsAllowed.mockReturnValue({ allowed: true });
  mockAppendReviewAuditEvent.mockResolvedValue(undefined);
});

describe('enforceDiscoveryHealthBefore', () => {
  const sessDir = '/tmp/sess';

  it('skips entirely when enforcement is not required', async () => {
    const state = makeState('IMPLEMENTATION'); // default discoveryHealth.enforcement = off
    await enforceDiscoveryHealthBefore(mockDeps(), sessDir, state, 'write');
    expect(mockLoadContext).not.toHaveBeenCalled();
    expect(mockIsAllowed).not.toHaveBeenCalled();
  });

  it('returns without throwing when the decision allows', async () => {
    await enforceDiscoveryHealthBefore(mockDeps(), sessDir, requiredState(), 'write');
    expect(mockIsAllowed).toHaveBeenCalledTimes(1);
    expect(mockWriteState).not.toHaveBeenCalled();
  });

  it('fails closed with unavailable projection when workspace dir is null', async () => {
    const deps = mockDeps({ getWorkspaceDir: () => null });
    await enforceDiscoveryHealthBefore(deps, sessDir, requiredState(), 'write');
    expect(mockLoadContext).not.toHaveBeenCalled();
    // the unavailable projection is fed to the decision authority
    const arg = mockIsAllowed.mock.calls[0]![0] as { health: { status: string } };
    expect(arg.health.status).toBe('unavailable');
  });

  it('persists a blocked gate + audit and throws on first block transition', async () => {
    mockIsAllowed.mockReturnValue({
      allowed: false,
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
      message: 'Discovery unavailable',
      driftStatus: 'unavailable',
    });
    await expect(
      enforceDiscoveryHealthBefore(mockDeps(), sessDir, requiredState(), 'write'),
    ).rejects.toThrow('DISCOVERY_HEALTH_UNAVAILABLE');

    expect(mockWriteState).toHaveBeenCalledTimes(1);
    const written = mockWriteState.mock.calls[0]![1] as SessionState;
    expect(written.discoveryHealthGate).toMatchObject({
      status: 'blocked',
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
    });
    expect(mockAppendReviewAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockAppendReviewAuditEvent.mock.calls[0]![3]).toBe('discovery_health:gate_changed');
  });

  it('does NOT re-persist when the gate is already blocked (idempotent)', async () => {
    mockIsAllowed.mockReturnValue({
      allowed: false,
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
      message: 'still blocked',
    });
    const state = requiredState({
      discoveryHealthGate: {
        status: 'blocked',
        code: 'DISCOVERY_HEALTH_UNAVAILABLE',
        message: 'prior',
        blockedAt: 'now',
      } as SessionState['discoveryHealthGate'],
    });
    await expect(enforceDiscoveryHealthBefore(mockDeps(), sessDir, state, 'write')).rejects.toThrow(
      'DISCOVERY_HEALTH_UNAVAILABLE',
    );
    expect(mockWriteState).not.toHaveBeenCalled();
    expect(mockAppendReviewAuditEvent).not.toHaveBeenCalled();
  });

  it('surfaces AUDIT_PERSISTENCE_FAILED when persisting the block fails', async () => {
    mockIsAllowed.mockReturnValue({
      allowed: false,
      code: 'DISCOVERY_DRIFT_BLOCKED',
      message: 'drift',
    });
    mockWriteState.mockRejectedValue(new Error('disk full'));
    await expect(
      enforceDiscoveryHealthBefore(mockDeps(), sessDir, requiredState(), 'write'),
    ).rejects.toThrow('AUDIT_PERSISTENCE_FAILED');
  });
});

describe('enforceDiscoveryHealthAfterBash', () => {
  const sessionId = 's1';

  it('returns early when sessDir is null', async () => {
    const deps = mockDeps({ getSessionDir: () => null });
    const output: { output?: unknown } = {};
    await enforceDiscoveryHealthAfterBash(deps, sessionId, output);
    expect(mockReadState).not.toHaveBeenCalled();
    expect(output.output).toBeUndefined();
  });

  it('writes a blocked output (does not throw) when the decision blocks', async () => {
    mockReadState.mockResolvedValue(requiredState());
    mockIsAllowed.mockReturnValue({
      allowed: false,
      code: 'DISCOVERY_HEALTH_DEGRADED',
      message: 'degraded after bash',
      driftStatus: 'clean',
    });
    const output: { output?: unknown } = {};
    await enforceDiscoveryHealthAfterBash(mockDeps(), sessionId, output);
    expect(output.output).toBeDefined();
    expect(mockStrictBlockedOutput).toHaveBeenCalledWith(
      'DISCOVERY_HEALTH_DEGRADED',
      expect.objectContaining({ sessionId }),
    );
  });

  it('writes blocked output on readState failure (fail-closed)', async () => {
    mockReadState.mockRejectedValue(new Error('read error'));
    const output: { output?: unknown } = {};
    await enforceDiscoveryHealthAfterBash(mockDeps(), sessionId, output);
    expect(mockStrictBlockedOutput).toHaveBeenCalledWith(
      'DISCOVERY_HEALTH_UNAVAILABLE',
      expect.objectContaining({ reason: 'read error' }),
    );
  });

  it('skips when enforcement is not required', async () => {
    mockReadState.mockResolvedValue(makeState('IMPLEMENTATION'));
    const output: { output?: unknown } = {};
    await enforceDiscoveryHealthAfterBash(mockDeps(), sessionId, output);
    expect(mockIsAllowed).not.toHaveBeenCalled();
    expect(output.output).toBeUndefined();
  });
});
