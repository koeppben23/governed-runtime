import { describe, expect, it } from 'vitest';
import { TEAM_POLICY } from '../../config/policy.js';
import { makeProgressedState, makeState } from '../../fixtures.js';
import { buildHelpResult } from './help-projection.js';

describe('buildHelpResult', () => {
  it('recommends the product invocation /export after a clean terminal completion', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
    });

    expect(result.nextAction?.invocation).toBe('/export');
    const exportCommand = result.commands.find((command) => command.invocation === '/export');
    const archiveCommand = result.commands.find((command) => command.invocation === '/archive');
    expect(exportCommand?.preflight.status).toBe('available');
    expect(archiveCommand?.alsoAvailableAs).toEqual(['/export']);
  });

  it('projects export preflight without claiming current snapshot freshness', () => {
    const state = makeProgressedState('COMPLETE');
    const stateWithArchive = { ...state, archiveStatus: 'verified' } as typeof state;
    const result = buildHelpResult(stateWithArchive, TEAM_POLICY, {
      view: 'command',
      requestedInvocation: '/export',
    });

    expect(result.technicalVerification.summary).toContain(
      'Current snapshot freshness is not established',
    );
    expect(result.nextAction?.preflight.guarantee).toBe('eligible_to_attempt');
  });

  it('blocks export for aborted sessions while keeping status available', () => {
    const result = buildHelpResult(
      makeState('COMPLETE', {
        error: {
          code: 'ABORTED',
          message: 'Stopped',
          recoveryHint: 'Inspect status',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      TEAM_POLICY,
      { view: 'commands', scope: 'all' },
    );

    const exportPreflight = result.commands.find(
      (command) => command.invocation === '/export',
    )?.preflight;
    expect(exportPreflight?.status).toBe('blocked');
    if (exportPreflight?.status === 'blocked') {
      expect(exportPreflight.reasonCode).toBe('ABORTED_SESSION');
    }
    expect(
      result.commands.find((command) => command.invocation === '/status')?.preflight.status,
    ).toBe('available');
  });

  it('keeps no-session help limited to initialization and read-only orientation', () => {
    const result = buildHelpResult(null, null, { view: 'context', scope: 'available' });

    expect(result.nextAction?.invocation).toBe('/hydrate');
    expect(result.commands.map((command) => command.invocation)).toEqual(['/hydrate', '/status']);
  });

  it('validates recommended action against preflight', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });

    if (result.nextAction) {
      expect(result.nextAction.preflight.status).toBe('available');
    }
  });

  it('/commands --all has a distinct registered interface identity', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
    });
    const allCmd = result.commands.find(
      (command) => command.id === 'operational.help.commands-all',
    );
    expect(allCmd?.invocation).toBe('/commands --all');
  });

  it('/help context shows limited commands (not full list)', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.nextAction).not.toBeNull();
    // Context view should be constrained
    expect(result.commands.length).toBeLessThanOrEqual(10);
  });

  it('alias derivation uses the canonical authority, not hard-coded logic', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
    });
    const exportCmd = result.commands.find((command) => command.invocation === '/export');
    expect(exportCmd?.alsoAvailableAs).toContain('/archive');
    const archiveCmd = result.commands.find((command) => command.invocation === '/archive');
    expect(archiveCmd?.alsoAvailableAs).toContain('/export');
  });

  it('projection includes structured readiness and technicalVerification axes', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.readiness).toBeDefined();
    expect(result.technicalVerification.status).toBeDefined();
  });
});
