import { describe, expect, it } from 'vitest';
import { TEAM_POLICY } from '../../config/policy.js';
import { makeProgressedState, makeState } from '../../fixtures.js';
import { buildHelpResult, finishToReadiness } from './help-projection.js';
import { buildFinishCard } from '../status.js';
import type { ReviewReport } from '../../state/evidence.js';
import { evaluateCompleteness } from '../../audit/completeness.js';

function makeReviewReport(
  state: ReturnType<typeof makeProgressedState>,
  overallStatus: ReviewReport['overallStatus'],
): ReviewReport {
  return {
    schemaVersion: 'flowguard-review-report.v1',
    sessionId: state.id,
    generatedAt: '2026-01-01T00:00:00.000Z',
    phase: state.phase,
    planDigest: state.plan?.current.digest ?? null,
    implDigest: state.implementation?.digest ?? null,
    validationSummary: [],
    findings: [],
    overallStatus,
    completeness: evaluateCompleteness(state),
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
    expect(exportCommand?.preflight.status).toBe('available');
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
          expect(command.preflight.status, command.invocation).toBe('available');
        }
      }
    }
  });

  it('evidenceCompleteness does not overclaim', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.evidenceCompleteness.status).toBe('complete');
    expect(result.archiveVerification.status).toBe('not_created');
  });

  it('blocks export for aborted sessions', () => {
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
    const ef = result.commands.find((command) => command.invocation === '/export')?.preflight;
    expect(ef?.status).toBe('blocked');
  });

  it('no-session help shows only hydrate and status', () => {
    const result = buildHelpResult(null, null, { view: 'context' });
    expect(result.nextAction?.invocation).toBe('/hydrate');
    expect(result.commands.map((command) => command.invocation)).toEqual(['/hydrate', '/status']);
  });

  it('/commands --all has a formal interface identity', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
    });
    const id = result.commands.find((command) => command.id === 'operational.help.commands-all');
    expect(id?.invocation).toBe('/commands --all');
  });

  it('/help context limits to one recommendation and ≤2 recoverable', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.commands.filter((command) => command.visibility === 'recommended')).toHaveLength(
      result.nextAction ? 1 : 0,
    );
    expect(
      result.commands.filter((command) => command.visibility === 'blocked_recoverable').length,
    ).toBeLessThanOrEqual(2);
  });

  it('CHANGES_REQUIRED current review report yields ready_with_warnings via help projection', () => {
    const state = makeProgressedState('COMPLETE');
    const reviewReport = makeReviewReport(state, 'issues');

    const finish = buildFinishCard(state, TEAM_POLICY, reviewReport);
    expect(finish.overallStatus).toBe('CHANGES_REQUIRED');

    const result = buildHelpResult(state, TEAM_POLICY, { view: 'context', reviewReport });
    expect(result.readiness).toBe('ready_with_warnings');
    expect(result.recommendationQuality.quality).toBe('issues');
    expect(result.recommendationQuality.advisoryStatus).toBe('changes_required');
    expect(result.nextAction?.invocation).toBe('/export');
    const exportCmd = result.commands.find((command) => command.invocation === '/export');
    expect(exportCmd?.preflight.status).toBe('available');
  });

  it('ignores a review report from another session', () => {
    const state = makeProgressedState('COMPLETE');
    const foreignReport = {
      ...makeReviewReport(state, 'issues'),
      sessionId: '00000000-0000-4000-8000-000000000099',
    };
    const result = buildHelpResult(state, TEAM_POLICY, {
      view: 'context',
      reviewReport: foreignReport,
    });
    expect(result.readiness).toBe('ready');
    expect(result.recommendationQuality.quality).toBe('clean');
  });

  it('ignores a review report with stale implementation digest', () => {
    const state = makeProgressedState('COMPLETE');
    const staleReport = {
      ...makeReviewReport(state, 'issues'),
      implDigest: 'stale-digest',
    };
    const result = buildHelpResult(state, TEAM_POLICY, {
      view: 'context',
      reviewReport: staleReport,
    });
    expect(result.readiness).toBe('ready');
  });

  it('ignores a review report from a different phase', () => {
    const state = makeProgressedState('COMPLETE');
    const mismatchedReport = {
      ...makeReviewReport(state, 'issues'),
      phase: 'IMPLEMENTATION' as const,
    };
    const result = buildHelpResult(state, TEAM_POLICY, {
      view: 'context',
      reviewReport: mismatchedReport,
    });
    expect(result.readiness).toBe('ready');
  });

  it('/help <command> never claims the requested command as nextAction', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'command',
      requestedInvocation: '/export',
    });
    expect(result.nextAction).toBeNull();
    expect(result.commands).toHaveLength(1);
  });

  it('structured axes are present in all results', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.readiness).toBeDefined();
    expect(result.recommendationQuality.quality).toBeDefined();
    expect(result.nextActionSummary).toBeDefined();
    expect(result.evidenceCompleteness.status).toBeDefined();
    expect(result.archiveVerification.status).toBeDefined();
  });
});
