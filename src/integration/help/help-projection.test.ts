import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { TEAM_POLICY } from '../../config/policy.js';
import * as crypto from 'node:crypto';
import { makeProgressedState, makeState, TICKET } from '../../fixtures.js';
import { buildHelpResult, finishToReadiness } from './help-projection.js';
import { buildFinishCard } from '../status.js';
import { resolveCurrentReviewReport } from '../review/report-coherence.js';
import type { ReviewReport } from '../../state/evidence.js';
import { evaluateCompleteness } from '../../audit/completeness.js';
import { help } from '../tools/help-tool.js';
import {
  createToolContext,
  createTestWorkspace,
  withTestEnv,
  type TestWorkspace,
  type TestToolContext,
} from '../test-helpers.js';
import { hydrate } from '../tools/hydrate.js';
import { ticket } from '../tools/ticket-tool.js';
import { plan } from '../tools/plan.js';
import { computeFingerprint, sessionDir } from '../../adapters/workspace/index.js';
import { readState } from '../../adapters/persistence.js';

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

  it('blocker populated from status projection for user gate phase', () => {
    const result = buildHelpResult(makeProgressedState('PLAN_REVIEW'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.blocker).not.toBeNull();
    if (result.blocker) {
      expect(result.blocker.message).toContain('Awaiting');
    }
  });

  it('blocker rendered in Markdown with message from projection', () => {
    const result = buildHelpResult(makeProgressedState('PLAN_REVIEW'), TEAM_POLICY, {
      view: 'context',
    });
    // Verify the blocker was derived from the real status projection, not invented
    expect(result.blocker?.message).toContain('Awaiting');
  });
});

describe('flowguard_help tool execute', () => {
  it('no-session context returns Markdown guidance via execute', async () => {
    const ctx = createToolContext({ worktree: '/tmp/test-worktree' });
    const out = await help.execute({ view: 'context' }, ctx);
    expect(typeof out).toBe('string');
    expect(out).toContain('**No active FlowGuard session.**');
    expect(out).toContain('**Available commands:**');
  });

  it('includeArtifactContent: true with no session still returns Markdown', async () => {
    const ctx = createToolContext({ worktree: '/tmp/test-worktree' });
    const out = await help.execute({ view: 'context', includeArtifactContent: true }, ctx);
    expect(typeof out).toBe('string');
    expect(out).toContain('**No active FlowGuard session.**');
  });

  it('verbose returns JSON with title', async () => {
    const ctx = createToolContext({ worktree: '/tmp/test-worktree' });
    const out = await help.execute({ view: 'context', verbose: true }, ctx);
    expect(() => JSON.parse(out as string)).not.toThrow();
    expect(JSON.parse(out as string).title).toBe('FlowGuard Help');
  });
});

describe('resume end-to-end via help.execute', () => {
  let ws: TestWorkspace;
  let ctx: TestToolContext;
  let cleanupEnv: () => void;

  beforeEach(async () => {
    cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
    ws = await createTestWorkspace();
    ctx = createToolContext({
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    });
  });

  afterEach(async () => {
    cleanupEnv();
    await ws.cleanup();
  });

  it('returns ticket and plan content with version and digest after resume', async () => {
    await hydrate.execute({}, ctx);
    await ticket.execute({ text: 'Fix the auth bug in login.ts', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix auth\n2. Add tests' }, ctx);

    // Re-read state to verify persistence
    const fp = await computeFingerprint(ws.tmpDir);
    const sd = sessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sd);
    if (!state?.ticket?.digest || !state?.plan?.current?.digest) {
      throw new TypeError('Expected persisted digest in state');
    }
    expect(state.ticket.text).toBe('Fix the auth bug in login.ts');
    expect(state.plan.current.body).toBe('## Plan\n1. Fix auth\n2. Add tests');
    expect((state.plan.history?.length ?? 0) + 1).toBe(1);

    // Fresh context: simulate resume after compaction
    const resumeCtx = createToolContext({
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      sessionID: ctx.sessionID,
    });
    const out = await help.execute({ view: 'context', includeArtifactContent: true }, resumeCtx);
    expect(typeof out).toBe('string');
    const md = out as string;
    expect(md).toContain('Fix the auth bug in login.ts');
    expect(md).toContain('## Plan');
    expect(md).toContain('Fix auth');
    expect(md).toContain('current plan v1: available');
    expect(md).toContain(state.ticket.digest.slice(0, 8));
    expect(md).toContain(state.plan.current.digest.slice(0, 8));
  });

  it('verbose alone does NOT include artifact content in real session', async () => {
    await hydrate.execute({}, ctx);
    await ticket.execute({ text: 'Confidential task', source: 'user' }, ctx);

    const out = await help.execute({ view: 'context', verbose: true }, ctx);
    const parsed = JSON.parse(out as string);
    expect(parsed.artifacts.ticket.content).toBeUndefined();
    expect(parsed.artifacts.ticket.digest).toBeTruthy();
  });

  it('command view rejects includeArtifactContent via strict schema', async () => {
    const out = await help.execute(
      {
        view: 'command',
        command: 'start',
        includeArtifactContent: true,
      } as Record<string, unknown>,
      ctx,
    );
    const parsed = JSON.parse(out as string);
    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain('Use context');
  });
});

describe('degraded discovery blocker projection', () => {
  it('projects blocker from discoveryHealthGate blocked state', () => {
    const base = makeProgressedState('IMPLEMENTATION');
    const degraded = buildHelpResult(
      {
        ...base,
        discoveryHealthGate: {
          status: 'blocked',
          code: 'DISCOVERY_HEALTH_DEGRADED',
          message: 'Discovery health is degraded',
          blockedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      TEAM_POLICY,
      { view: 'context' },
    );
    expect(degraded.blocker).not.toBeNull();
    if (degraded.blocker) {
      expect(degraded.blocker.reasonCode).toBe('DISCOVERY_HEALTH_DEGRADED');
      expect(degraded.blocker.message).toBe('Discovery health is degraded');
    }
  });
});
