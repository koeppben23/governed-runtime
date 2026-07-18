import { describe, expect, it } from 'vitest';
import { TEAM_POLICY } from '../../config/policy.js';
import { makeProgressedState, makeState } from '../../fixtures.js';
import { buildHelpResult } from './help-projection.js';

describe('buildHelpResult', () => {
  it('recommends the product invocation /export after a clean terminal completion', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      scope: 'all',
    });

    expect(result.nextAction?.invocation).toBe('/export');
    const exportCommand = result.commands.find((command) => command.invocation === '/export');
    const archiveCommand = result.commands.find((command) => command.invocation === '/archive');
    expect(exportCommand?.preflight.status).toBe('available');
    expect(archiveCommand?.alsoAvailableAs).toEqual(['/export']);
  });

  it('projects export preflight without claiming current snapshot freshness', () => {
    const result = buildHelpResult(
      makeState('COMPLETE', { archiveStatus: 'verified' }),
      TEAM_POLICY,
      { scope: 'available', requestedInvocation: '/export' },
    );

    expect(result.technicalVerification).toContain('Current snapshot freshness is not established');
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
      { scope: 'all' },
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
    const result = buildHelpResult(null, null, { scope: 'available' });

    expect(result.nextAction?.invocation).toBe('/hydrate');
    expect(result.commands.map((command) => command.invocation)).toEqual(['/hydrate', '/status']);
  });
});
