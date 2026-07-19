import { describe, expect, it } from 'vitest';
import { TEAM_POLICY } from '../../config/policy.js';
import { makeProgressedState, makeState, TICKET } from '../../fixtures.js';
import { buildHelpResult, finishToReadiness } from './help-projection.js';
import { buildFinishCard } from '../status.js';
import { resolveCurrentReviewReport } from '../review/report-coherence.js';
import type { ReviewReport } from '../../state/evidence.js';
import { evaluateCompleteness } from '../../audit/completeness.js';

function makeReviewReport(
  state: ReturnType<typeof makeProgressedState>,
  overallStatus: ReviewReport['overallStatus'],
  overrides?: Partial<ReviewReport>,
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
    ...overrides,
  };
}

describe('buildHelpResult', () => {
  it('recommends /export after a clean terminal completion', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
    });
    expect(result.nextAction?.invocation).toBe('/export');
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

  it('no-session help recommends /start, not /hydrate', () => {
    const result = buildHelpResult(null, null, { view: 'context' });
    expect(result.nextAction?.invocation).toBe('/start');
    expect(result.commands.map((command) => command.invocation)).toEqual(['/start', '/status']);
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

  it('CHANGES_REQUIRED review report yields ready_with_warnings and issues quality', () => {
    const state = makeProgressedState('REVIEW_COMPLETE');
    const reviewReport = makeReviewReport(state, 'issues');

    const resolution = resolveCurrentReviewReport(state, reviewReport);
    expect(resolution.status).toBe('current');

    const finish = buildFinishCard(state, TEAM_POLICY, reviewReport);
    expect(finish.overallStatus).toBe('CHANGES_REQUIRED');

    const result = buildHelpResult(state, TEAM_POLICY, { view: 'context', reviewReport });
    expect(result.lifecycle).toBe('Review complete');
    expect(result.readiness).toBe('ready_with_warnings');
    expect(result.recommendationQuality.quality).toBe('issues');
    expect(result.recommendationQuality.advisoryStatus).toBe('changes_required');
    expect(result.reviewReportStatus).toBe('current');
    expect(result.nextAction?.invocation).toBe('/export');
    const exportCmd = result.commands.find((command) => command.invocation === '/export');
    expect(exportCmd?.preflight.status).toBe('available');
  });

  it('recommendationQuality derives from review report, not finish status', () => {
    // A clean state with no review report has not_applicable recommendation quality
    // even though the finish status is READY.
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.readiness).toBe('ready');
    expect(result.recommendationQuality.quality).toBe('not_applicable');
    expect(result.reviewReportStatus).toBe('not_available');
  });

  it('ignores a review report from another session', () => {
    const state = makeProgressedState('COMPLETE');
    const foreignReport = makeReviewReport(state, 'issues', {
      sessionId: '00000000-0000-4000-8000-000000000099',
    });
    const resolution = resolveCurrentReviewReport(state, foreignReport);
    expect(resolution.status).toBe('foreign');

    const result = buildHelpResult(state, TEAM_POLICY, {
      view: 'context',
      reviewReport: foreignReport,
    });
    expect(result.readiness).toBe('ready');
    expect(result.recommendationQuality.quality).toBe('not_applicable');
    expect(result.reviewReportStatus).toBe('foreign');
  });

  it('ignores a review report with stale implementation digest', () => {
    const state = makeProgressedState('COMPLETE');
    const staleReport = makeReviewReport(state, 'issues', { implDigest: 'stale-digest' });
    expect(resolveCurrentReviewReport(state, staleReport).status).toBe('stale');

    const result = buildHelpResult(state, TEAM_POLICY, {
      view: 'context',
      reviewReport: staleReport,
    });
    expect(result.readiness).toBe('ready');
    expect(result.reviewReportStatus).toBe('stale');
  });

  it('ignores a review report from a different phase', () => {
    const state = makeProgressedState('COMPLETE');
    const mismatchedReport = makeReviewReport(state, 'issues', { phase: 'IMPLEMENTATION' });
    expect(resolveCurrentReviewReport(state, mismatchedReport).status).toBe('incoherent');

    const result = buildHelpResult(state, TEAM_POLICY, {
      view: 'context',
      reviewReport: mismatchedReport,
    });
    expect(result.readiness).toBe('ready');
    expect(result.reviewReportStatus).toBe('incoherent');
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
    expect(result.reviewReportStatus).toBeDefined();
    expect(result.nextActionSummary).toBeDefined();
    expect(result.evidenceCompleteness.status).toBeDefined();
    expect(result.archiveVerification.status).toBeDefined();
  });

  it('READY is orientation, not blocked', () => {
    const result = buildHelpResult(makeProgressedState('READY'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.readiness).toBe('none');
    expect(result.nextAction?.invocation).toBe('/task');
  });

  it('non-terminal phases with complete evidence report readiness=none via IN_PROGRESS', () => {
    for (const phase of ['PLAN', 'IMPLEMENTATION'] as const) {
      const result = buildHelpResult(makeProgressedState(phase), TEAM_POLICY, {
        view: 'context',
      });
      expect(result.readiness, `${phase} must be none`).toBe('none');
      expect(result.nextAction).not.toBeNull();
    }
  });

  it('/start is primary, /hydrate is compatibility', () => {
    const result = buildHelpResult(makeProgressedState('READY'), TEAM_POLICY, {
      view: 'commands',
    });
    const invocations = result.commands.map((command) => command.invocation);
    expect(invocations).toContain('/start');
    expect(invocations).not.toContain('/hydrate');
  });

  it('/continue is blocked at READY with canonical CONTINUE_AMBIGUOUS code', () => {
    const all = buildHelpResult(makeProgressedState('READY'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
    });
    const allContinue = all.commands.find((command) => command.invocation === '/continue');
    expect(allContinue?.preflight.status).toBe('blocked');
    expect(allContinue?.visibility).toBe('blocked_recoverable');
    if (allContinue?.preflight.status === 'blocked') {
      expect(allContinue.preflight.reasonCode).toBe('CONTINUE_AMBIGUOUS');
    }
  });
});

// ── Artifacts ─────────────────────────────────────────────────────────

describe('HelpResult artifacts', () => {
  it('ticket available when state has ticket', () => {
    const result = buildHelpResult(makeState('TICKET', { ticket: TICKET }), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.artifacts.ticket.status).toBe('available');
    expect(result.artifacts.ticket.digest).toBe('digest-of-ticket');
    expect(result.artifacts.ticket.preview).toBe('Fix the auth bug in login.ts');
    expect(result.artifacts.ticket.content).toBeNull();
  });

  it('ticket content populated with includeArtifactContent', () => {
    const result = buildHelpResult(makeState('TICKET', { ticket: TICKET }), TEAM_POLICY, {
      view: 'context',
      includeArtifactContent: true,
    });
    expect(result.artifacts.ticket.content).toBe('Fix the auth bug in login.ts');
  });

  it('ticket not_verified when state has no ticket', () => {
    const result = buildHelpResult(makeState('READY'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.artifacts.ticket.status).toBe('not_verified');
    expect(result.artifacts.ticket.workflowNextAction).toBeTruthy();
  });

  it('currentPlan available with version = history.length + 1', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.artifacts.currentPlan.status).toBe('available');
    expect(result.artifacts.currentPlan.digest).toBe('digest-of-plan');
    expect(result.artifacts.currentPlanVersion).toBe(1); // history: [] → 0 + 1
  });

  it('artifacts partial when only ticket exists', () => {
    const result = buildHelpResult(makeState('TICKET', { ticket: TICKET }), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.artifacts.ticket.status).toBe('available');
    expect(result.artifacts.currentPlan.status).toBe('not_verified');
    expect(result.artifacts.status).toBe('partial');
  });

  it('no session → all not_verified', () => {
    const result = buildHelpResult(null, null, { view: 'context' });
    expect(result.artifacts.ticket.status).toBe('not_verified');
    expect(result.artifacts.currentPlan.status).toBe('not_verified');
    expect(result.artifacts.status).toBe('not_verified');
  });
});

describe('HelpResult blocker', () => {
  it('blocker null when no status blocker', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.blocker).toBeNull();
  });
});
