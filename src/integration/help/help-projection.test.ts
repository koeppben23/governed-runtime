import { describe, expect, it } from 'vitest';
import { TEAM_POLICY } from '../../config/policy.js';
import { makeProgressedState, makeState } from '../../fixtures.js';
import { buildHelpResult, finishToReadiness } from './help-projection.js';
import { buildFinishCard } from '../status.js';
import type { ReviewReport } from '../../state/evidence.js';
import { evaluateCompleteness } from '../../audit/completeness.js';

function makeReviewReport(overallStatus: ReviewReport['overallStatus']): ReviewReport {
  return {
    schemaVersion: 'flowguard-review-report.v1',
    sessionId: '00000000-0000-4000-8000-000000000001',
    generatedAt: '2026-01-01T00:00:00.000Z',
    phase: 'REVIEW_COMPLETE',
    planDigest: null,
    implDigest: null,
    validationSummary: [],
    findings: [],
    overallStatus,
    completeness: evaluateCompleteness(makeProgressedState('REVIEW_COMPLETE')),
  };
}

describe('buildHelpResult', () => {
  it('recommends /export after a clean terminal completion', () => {
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

  it('all commands marked recommended have available preflight', () => {
    for (const state of [
      makeProgressedState('COMPLETE'),
      makeProgressedState('PLAN_REVIEW'),
      makeProgressedState('IMPLEMENTATION'),
      makeProgressedState('ARCH_REVIEW'),
    ]) {
      const result = buildHelpResult(state, TEAM_POLICY, { view: 'context' });
      for (const command of result.commands) {
        if (command.visibility === 'recommended') {
          expect(
            command.preflight.status,
            `${command.invocation} marked recommended but preflight=${command.preflight.status}`,
          ).toBe('available');
        }
      }
    }
  });

  it('projects export preflight without claiming current snapshot freshness', () => {
    const state = makeProgressedState('COMPLETE');
    const stateWithArchive = { ...state, archiveStatus: 'verified' } as typeof state;
    const result = buildHelpResult(stateWithArchive, TEAM_POLICY, {
      view: 'command',
      requestedInvocation: '/export',
    });

    expect(result.archiveVerification.status).toBe('previously_verified');
    expect(result.archiveVerification.currentSnapshotVerified).toBe(false);
    expect(result.archiveVerification.summary).toContain('snapshot freshness');
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
  });

  it('keeps no-session help limited to initialization and read-only orientation', () => {
    const result = buildHelpResult(null, null, { view: 'context', scope: 'available' });

    expect(result.nextAction?.invocation).toBe('/hydrate');
    expect(result.commands.map((command) => command.invocation)).toEqual(['/hydrate', '/status']);
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

  it('/help context shows limited commands with one recommendation', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.nextAction).not.toBeNull();
    expect(result.commands.filter((command) => command.visibility === 'recommended')).toHaveLength(
      result.nextAction ? 1 : 0,
    );
    const recoverable = result.commands.filter(
      (command) => command.visibility === 'blocked_recoverable',
    );
    expect(recoverable.length).toBeLessThanOrEqual(2);
    expect(result.commands.length).toBeLessThanOrEqual(10);
  });

  it('alias derivation uses the canonical authority', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
    });
    const exportCmd = result.commands.find((command) => command.invocation === '/export');
    expect(exportCmd?.alsoAvailableAs).toContain('/archive');
    const archiveCmd = result.commands.find((command) => command.invocation === '/archive');
    expect(archiveCmd?.alsoAvailableAs).toContain('/export');
  });

  it('projection includes structured readiness, evidenceCompleteness, and archiveVerification', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.readiness).toBeDefined();
    expect(result.evidenceCompleteness.status).toBeDefined();
    expect(result.archiveVerification.status).toBeDefined();
  });

  it('evidenceCompleteness does not overclaim technical verification', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.evidenceCompleteness.status).toBe('complete');
    expect(result.archiveVerification.status).toBe('not_created');
    expect(result.evidenceCompleteness.summary).toContain('Required evidence');
  });

  it('CHANGES_REQUIRED review report yields ready_with_warnings readiness via help projection', () => {
    const state = makeProgressedState('COMPLETE');
    const reviewReport = makeReviewReport('issues');

    const finish = buildFinishCard(state, TEAM_POLICY, reviewReport);
    expect(finish.overallStatus).toBe('CHANGES_REQUIRED');
    expect(finishToReadiness(finish.overallStatus)).toBe('ready_with_warnings');

    const result = buildHelpResult(state, TEAM_POLICY, {
      view: 'context',
      reviewReport,
    });
    expect(result.readiness).toBe('ready_with_warnings');
    expect(result.nextAction?.invocation).toBe('/export');
    const exportCmd = result.commands.find((command) => command.invocation === '/export');
    expect(exportCmd?.preflight.status).toBe('available');
  });

  it('/help <command> never claims the requested command as the recommended next action', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'command',
      requestedInvocation: '/export',
    });
    expect(result.nextAction).toBeNull();
    expect(result.commands).toHaveLength(1);
  });

  it('/help <command> shows the command even when it is currently blocked', () => {
    const result = buildHelpResult(makeProgressedState('IMPLEMENTATION'), TEAM_POLICY, {
      view: 'command',
      requestedInvocation: '/export',
    });
    expect(result.nextAction).toBeNull();
    expect(result.commands).toHaveLength(1);
  });
});
