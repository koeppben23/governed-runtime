import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { getPolicyPreset, TEAM_POLICY } from '../../config/policy.js';
import * as crypto from 'node:crypto';
import { makeProgressedState, makeState, PLAN_EVIDENCE, TICKET } from '../../fixtures.js';
import { buildHelpResult, finishToReadiness } from './help-projection.js';
import { buildFinishCard } from '../status/status-finish.js';
import { resolveCurrentReviewReport } from '../review/evidence/report-coherence.js';
import type { ReviewReport } from '../../state/evidence.js';
import { help } from '../tools/simple/help-tool.js';
import {
  canonicalBinding,
  createToolContext,
  createTestWorkspace,
  withTestEnv,
  type TestWorkspace,
  type TestToolContext,
} from '../test-helpers.js';
import { hydrate } from '../tools/hydrate/hydrate.js';
import { ticket } from '../tools/simple/ticket-tool.js';
import { plan } from '../tools/plan/plan.js';
import { computeFingerprint, sessionDir } from '../../adapters/workspace/index.js';
import { readState, writeState } from '../../adapters/persistence.js';
import { writeRepoConfig } from '../../adapters/persistence-config.js';
import { createPolicySnapshot } from '../../config/policy-snapshot.js';
import { hashText } from '../../shared/hashing.js';
import { DEFAULT_CONFIG } from '../../config/flowguard-config.js';

vi.mock('../../adapters/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../adapters/git.js')>();
  return {
    ...actual,
    listRepoSignals: vi.fn().mockResolvedValue({
      files: [],
      packageFilePaths: [],
      configFilePaths: [],
    }),
  };
});

function makeReviewReport(
  state: ReturnType<typeof makeProgressedState>,
  overallStatus: ReviewReport['overallStatus'],
  overrides?: Partial<Extract<ReviewReport, { readonly reviewKind: 'lifecycle_review' }>>,
): ReviewReport {
  return {
    reviewKind: 'lifecycle_review',
    schemaVersion: 'flowguard-review-report.v1',
    sessionId: state.id,
    generatedAt: '2026-01-01T00:00:00.000Z',
    phase: state.phase,
    planDigest: state.plan?.current.digest ?? null,
    implDigest: state.implementation?.digest ?? null,
    validationSummary: [],
    findings: [],
    overallStatus,
    peerReviewCoverage: {
      targetResolved: false,
      targetFrozen: false,
      repositoryIdentityVerified: null,
      baseSha: null,
      headSha: null,
      changedPathCount: 0,
      objectivesCovered: 0,
      objectivesTotal: 0,
      reviewAssurance: null,
      missingVerification: [],
    },
    ...overrides,
  };
}

describe('buildHelpResult', () => {
  it('directs /export at EXPORT_READY and is terminal at COMPLETE', () => {
    const exportReady = buildHelpResult(makeProgressedState('EXPORT_READY'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
    });
    expect(exportReady.directive?.invocation).toBe('/export');

    const complete = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
    });
    expect(complete.directive).toBeNull();
  });

  it('all commands marked recommended have available preflight', () => {
    for (const state of [
      makeProgressedState('EXPORT_READY'),
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
    expect(result.archiveVerification).toMatchObject({
      packagePurpose: null,
      integrityCapability: null,
      verificationStatus: null,
    });
  });

  it('surfaces a redacted archive as not verifiable rather than failed', () => {
    const result = buildHelpResult(
      {
        ...makeProgressedState('COMPLETE'),
        lastExportPackagePurpose: 'sharing',
        lastExportIntegrityCapability: 'not_verifiable',
        lastExportVerificationStatus: 'not_run',
      },
      TEAM_POLICY,
      { view: 'context' },
    );
    expect(result.archiveVerification).toMatchObject({
      packagePurpose: 'sharing',
      integrityCapability: 'not_verifiable',
      verificationStatus: 'not_run',
    });
    expect(result.archiveVerification.summary).toContain('intentionally excludes raw evidence');
  });

  it('blocks export for aborted sessions', () => {
    const result = buildHelpResult(
      makeState('ABORTED', {
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
    expect(result.directive).toBeNull();
  });

  it('terminal help keeps read-only routing/recovery available while mutating flow commands stay blocked', () => {
    for (const phase of ['COMPLETE', 'ABORTED'] as const) {
      const state =
        phase === 'ABORTED'
          ? makeState('ABORTED', {
              error: {
                code: 'ABORTED',
                message: 'Stopped',
                recoveryHint: 'Inspect status',
                occurredAt: '2026-01-01T00:00:00.000Z',
              },
            })
          : makeProgressedState('COMPLETE');
      const result = buildHelpResult(state, TEAM_POLICY, { view: 'commands', scope: 'all' });
      const statusFor = (invocation: string) =>
        result.commands.find((command) => command.invocation === invocation)?.preflight.status;

      expect(statusFor('/start'), phase).toBe('available');
      expect(statusFor('/hydrate'), phase).toBe('available');
      expect(statusFor('/abort'), phase).toBe('available');
      expect(statusFor('/continue'), phase).toBe('available');
      expect(
        result.commands.find((command) => command.invocation === '/continue')?.preflight,
      ).toEqual({ status: 'available', guarantee: 'read_only_available' });
      expect(statusFor('/ticket'), phase).toBe('blocked');
    }
  });

  it('no-session help recommends /start on a verified native host, not /hydrate', () => {
    const result = buildHelpResult(null, null, {
      view: 'context',
      capabilities: {
        portable: 'supported',
        native: 'supported',
        tui: 'not_verified',
        desktop: 'not_verified',
      },
    });
    expect(result.directive?.invocation).toBe('/start');
    expect(result.commands.map((command) => command.invocation)).toEqual(['/start', '/status']);
    expect(result.commands.find((command) => command.invocation === '/start')).toMatchObject({
      availability: 'available',
      visibility: 'recommended',
    });
    expect(result.commandScope).toBe('available');
  });

  it('does not claim native /start on a host without native capability evidence', () => {
    const result = buildHelpResult(null, null, { view: 'context' });
    expect(result.directive).toBeNull();
    expect(result.nextActionSummary).toContain('Start');
    expect(result.commands.find((command) => command.invocation === '/start')).toMatchObject({
      surfaces: ['native'],
      availability: 'not_verified',
      visibility: 'not_verified',
    });
  });

  it('no-session /commands --all exposes the complete capability-aware catalog', () => {
    const result = buildHelpResult(null, null, { view: 'commands', scope: 'all' });
    expect(result.commandScope).toBe('all');
    expect(result.capabilitySource).toBe('default');
    expect(result.capabilities.native).toBe('not_verified');
    const byInvocation = new Map(result.commands.map((command) => [command.invocation, command]));
    expect(byInvocation.get('/start')).toMatchObject({
      surfaces: ['native'],
      availability: 'not_verified',
      visibility: 'not_verified',
    });
    expect(byInvocation.get('/status')).toMatchObject({
      surfaces: ['portable'],
      availability: 'available',
      visibility: 'available',
    });
    expect(byInvocation.get('/diagnostics')).toMatchObject({
      surfaces: ['native'],
      availability: 'not_verified',
      visibility: 'not_verified',
    });
    expect(byInvocation.get('/recover-capacity')).toMatchObject({
      surfaces: ['native'],
      availability: 'not_verified',
    });
    expect(byInvocation.get('/choose-workflow')).toMatchObject({
      surfaces: ['tui', 'desktop'],
      availability: 'not_verified',
    });
    expect(byInvocation.get('/flowguard-ui-probe')).toMatchObject({
      surfaces: ['desktop'],
      maturity: 'experimental',
      availability: 'not_verified',
      visibility: 'not_verified',
    });
    expect(byInvocation.get('/flowguard-inline')).toMatchObject({
      surfaces: ['desktop'],
      maturity: 'experimental',
      availability: 'not_verified',
      visibility: 'not_verified',
    });
    expect(byInvocation.get('/debug-export')).toBeDefined();
    expect(byInvocation.get('/end-governance')).toBeDefined();
  });

  it('native capabilities expose native-only commands without inventing session state', () => {
    const capabilities = {
      portable: 'supported' as const,
      native: 'supported' as const,
      tui: 'not_verified' as const,
      desktop: 'not_verified' as const,
    };
    const result = buildHelpResult(null, null, {
      view: 'commands',
      scope: 'all',
      capabilities,
    });
    expect(result.capabilitySource).toBe('host');
    expect(result.capabilities).toEqual(capabilities);
    expect(result.commands.find((command) => command.invocation === '/diagnostics')).toMatchObject({
      availability: 'available',
      visibility: 'available',
      preflight: { status: 'available', guarantee: 'read_only_available' },
    });
    expect(result.commands.find((command) => command.invocation === '/debug-export')).toMatchObject(
      {
        availability: 'available',
        visibility: 'available',
        preflight: { status: 'available', guarantee: 'eligible_to_attempt' },
      },
    );
    expect(
      result.commands.find((command) => command.invocation === '/recover-capacity'),
    ).toMatchObject({
      availability: 'available',
      visibility: 'blocked_recoverable',
      preflight: { status: 'blocked', reasonCode: 'SESSION_REQUIRED' },
    });
    expect(result.commands.find((command) => command.invocation === '/start')).toMatchObject({
      availability: 'available',
      visibility: 'recommended',
    });
    expect(result.directive?.invocation).toBe('/start');
    expect(
      result.commands.find((command) => command.invocation === '/choose-workflow')?.availability,
    ).toBe('not_verified');
    for (const invocation of ['/flowguard-ui-probe', '/flowguard-inline']) {
      expect(result.commands.find((command) => command.invocation === invocation)).toMatchObject({
        availability: 'not_verified',
        visibility: 'not_verified',
        surfaces: ['desktop'],
      });
    }
  });

  it('desktop capabilities expose Desktop commands without a FlowGuard session', () => {
    // Hypothetical trusted host snapshot. This proves projection behavior only;
    // it does not prove the GUI bundle or its optional APIs are registered.
    const capabilities = {
      portable: 'supported' as const,
      native: 'not_verified' as const,
      tui: 'not_verified' as const,
      desktop: 'supported' as const,
    };
    const result = buildHelpResult(null, null, {
      view: 'commands',
      scope: 'all',
      capabilities,
    });
    expect(result.capabilitySource).toBe('host');
    expect(
      result.commands.find((command) => command.invocation === '/flowguard-ui-probe'),
    ).toMatchObject({
      availability: 'available',
      visibility: 'available',
      preflight: { status: 'available', guarantee: 'read_only_available' },
    });
    expect(
      result.commands.find((command) => command.invocation === '/flowguard-inline'),
    ).toMatchObject({
      availability: 'available',
      visibility: 'available',
      preflight: { status: 'available', guarantee: 'read_only_available' },
    });
    expect(
      result.commands.find((command) => command.invocation === '/choose-workflow'),
    ).toMatchObject({
      availability: 'available',
      visibility: 'available',
      preflight: { status: 'available', guarantee: 'eligible_to_attempt' },
    });
  });

  it('marks Desktop commands host-unavailable when the Desktop surface is unsupported', () => {
    const result = buildHelpResult(null, null, {
      view: 'commands',
      scope: 'all',
      capabilities: {
        portable: 'supported',
        native: 'not_verified',
        tui: 'not_verified',
        desktop: 'unsupported',
      },
    });
    for (const invocation of ['/flowguard-ui-probe', '/flowguard-inline']) {
      expect(result.commands.find((command) => command.invocation === invocation)).toMatchObject({
        availability: 'host_unavailable',
        visibility: 'host_unavailable',
      });
    }
    // TUI is still not_verified, so the shared chooser is not host-unavailable.
    expect(
      result.commands.find((command) => command.invocation === '/choose-workflow'),
    ).toMatchObject({
      availability: 'not_verified',
      visibility: 'not_verified',
    });
  });

  it('keeps no-session /commands minimal even with Desktop capability evidence', () => {
    const result = buildHelpResult(null, null, {
      view: 'context',
      capabilities: {
        portable: 'supported',
        native: 'not_verified',
        tui: 'not_verified',
        desktop: 'supported',
      },
    });
    expect(result.commands.map((command) => command.invocation)).toEqual(['/start', '/status']);
    expect(result.commands.some((command) => command.surfaces.includes('desktop'))).toBe(false);
  });

  it('shows Desktop commands in an active /commands view when Desktop is supported', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'commands',
      capabilities: {
        portable: 'supported',
        native: 'supported',
        tui: 'not_verified',
        desktop: 'supported',
      },
    });
    const invocations = result.commands.map((command) => command.invocation);
    expect(invocations).toContain('/flowguard-ui-probe');
    expect(invocations).toContain('/flowguard-inline');
    expect(invocations).toContain('/choose-workflow');
  });

  it('resolves Desktop command detail without a session', () => {
    const result = buildHelpResult(null, null, {
      view: 'command',
      requestedInvocation: '/flowguard-inline',
      capabilities: {
        portable: 'supported',
        native: 'not_verified',
        tui: 'not_verified',
        desktop: 'supported',
      },
    });
    expect(result.commands).toHaveLength(1);
    expect(result.commandScope).toBe('detail');
    expect(result.commands[0]).toMatchObject({
      invocation: '/flowguard-inline',
      surfaces: ['desktop'],
      maturity: 'experimental',
      availability: 'available',
    });
  });

  it('active /commands --all includes native metadata without claiming host support', () => {
    const capabilities = {
      portable: 'supported' as const,
      native: 'supported' as const,
      tui: 'not_verified' as const,
      desktop: 'not_verified' as const,
    };
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
      capabilities,
    });
    const diagnostics = result.commands.find((command) => command.invocation === '/diagnostics');
    expect(diagnostics).toMatchObject({
      availability: 'available',
      visibility: 'available',
      surfaces: ['native'],
    });
    expect(
      result.commands.find((command) => command.invocation === '/choose-workflow')?.visibility,
    ).toBe('not_verified');
    for (const invocation of ['/flowguard-ui-probe', '/flowguard-inline']) {
      expect(result.commands.find((command) => command.invocation === invocation)).toMatchObject({
        visibility: 'not_verified',
        availability: 'not_verified',
      });
    }
    expect(result.commands.some((command) => command.invocation === '/recover-capacity')).toBe(
      true,
    );
  });

  it('resolves native command detail without a session', () => {
    const result = buildHelpResult(null, null, {
      view: 'command',
      requestedInvocation: '/diagnostics',
    });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({
      invocation: '/diagnostics',
      availability: 'not_verified',
    });
  });

  it('does not claim an unknown command is available', () => {
    const result = buildHelpResult(null, null, {
      view: 'command',
      requestedInvocation: '/not-a-command',
    });
    expect(result.commands).toEqual([]);
    expect(result.directive).toBeNull();
    expect(result.nextActionSummary).toBe('Unknown FlowGuard command.');
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
      result.directive ? 1 : 0,
    );
    expect(
      result.commands.filter((command) => command.visibility === 'blocked_recoverable').length,
    ).toBeLessThanOrEqual(2);
  });

  it('CHANGES_REQUIRED review report yields ready_with_warnings and issues quality', () => {
    const state = makeProgressedState('PEER_REVIEW_COMPLETE');
    const reviewReport = makeReviewReport(state, 'issues');

    const resolution = resolveCurrentReviewReport(state, reviewReport);
    expect(resolution.status).toBe('current');

    const finish = buildFinishCard(state, TEAM_POLICY, reviewReport);
    expect(finish.overallStatus).toBe('CHANGES_REQUIRED');

    const result = buildHelpResult(state, TEAM_POLICY, {
      view: 'commands',
      scope: 'all',
      reviewReport,
    });
    expect(result.lifecycle).toBe('Peer review complete');
    expect(result.readiness).toBe('ready_with_warnings');
    expect(result.recommendationQuality.quality).toBe('issues');
    expect(result.recommendationQuality.advisoryStatus).toBe('changes_required');
    expect(result.reviewReportStatus).toBe('current');
    // Peer review completion is terminal: no user directive, and /export
    // is only admissible at EXPORT_READY.
    expect(result.directive).toBeNull();
    const exportCmd = result.commands.find((command) => command.invocation === '/export');
    expect(exportCmd?.preflight.status).toBe('blocked');
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

  it('/help <command> never claims the requested command as directive', () => {
    const result = buildHelpResult(makeProgressedState('COMPLETE'), TEAM_POLICY, {
      view: 'command',
      requestedInvocation: '/export',
    });
    expect(result.directive).toBeNull();
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
    expect(result.archiveVerification).toHaveProperty('verificationStatus');
  });

  it('READY is orientation, not blocked', () => {
    const result = buildHelpResult(makeProgressedState('READY'), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.readiness).toBe('none');
    expect(result.directive).toBeNull();
    expect(result.nextActionSummary).toContain('/task');
    expect(result.nextActionSummary).toContain('/architecture');
    expect(result.nextActionSummary).toContain('/review');
    expect(result.commands.find((command) => command.invocation === '/task')?.visibility).toBe(
      'recommended',
    );
  });

  it('non-terminal phases with complete evidence report readiness=none via IN_PROGRESS', () => {
    for (const phase of ['PLAN', 'IMPLEMENTATION'] as const) {
      const result = buildHelpResult(makeProgressedState(phase), TEAM_POLICY, {
        view: 'context',
      });
      expect(result.readiness, `${phase} must be none`).toBe('none');
      expect(
        result.nextActionSummary,
        `${phase} must expose a canonical directive code`,
      ).toBeTruthy();
      if (phase === 'IMPLEMENTATION') {
        expect(result.directive?.invocation).toBe('/implement');
      } else {
        // PLAN is canonical system work: no user command is directed.
        expect(result.directive).toBeNull();
      }
    }
  });

  it('/start is primary, /hydrate is compatibility', () => {
    const result = buildHelpResult(makeProgressedState('READY'), TEAM_POLICY, {
      view: 'commands',
      capabilities: {
        portable: 'supported',
        native: 'supported',
        tui: 'not_verified',
        desktop: 'not_verified',
      },
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

  it.each(['PLAN', 'VALIDATION', 'PLAN_REVIEW', 'IMPL_REVIEW', 'COMPLETE', 'ABORTED'] as const)(
    '/continue at %s projects read-only routing, never mutating CONTINUE admissibility',
    (phase) => {
      const state = makeProgressedState(phase);
      const before = JSON.stringify(state);
      const result = buildHelpResult(state, TEAM_POLICY, {
        view: 'command',
        requestedInvocation: '/continue',
      });
      expect(result.commands[0]?.description).toContain(
        'without executing checks, reviews or transitions',
      );
      expect(result.commands[0]?.preflight).toEqual({
        status: 'available',
        guarantee: 'read_only_available',
      });
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it.each(['READY', 'VALIDATION', 'IMPL_VALIDATION', 'IMPL_REVIEW'] as const)(
    '/check at %s projects native eligibility, not machine VALIDATE authorization',
    (phase) => {
      const result = buildHelpResult(makeProgressedState(phase), TEAM_POLICY, {
        view: 'command',
        requestedInvocation: '/check',
      });
      expect(result.commands[0]?.id).toBe('operational.check');
      expect(result.commands[0]?.description).toContain('verification checks and review loop');
      expect(result.commands[0]?.preflight).toEqual({
        status: 'available',
        guarantee: 'eligible_to_attempt',
      });
      expect(result.directive).toBeNull();
    },
  );

  it.each(['/check', '/continue'])(
    '%s still requires a session and never authorizes itself through help',
    (invocation) => {
      const result = buildHelpResult(null, null, {
        view: 'command',
        requestedInvocation: invocation,
      });
      expect(result.commands[0]?.preflight).toMatchObject({
        status: 'blocked',
        reasonCode: 'SESSION_REQUIRED',
      });
      expect(result.directive).toBeNull();
    },
  );
});

// ── Artifacts ─────────────────────────────────────────────────────────

describe('HelpResult artifacts', () => {
  it('ticket available when state has ticket', () => {
    const result = buildHelpResult(makeState('TICKET', { ticket: TICKET }), TEAM_POLICY, {
      view: 'context',
    });
    expect(result.artifacts.ticket.status).toBe('available');
    expect(result.artifacts.ticket.digest).toBe(TICKET.digest);
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
    expect(result.artifacts.currentPlan.digest).toBe(PLAN_EVIDENCE.digest);
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
    expect(out).toContain('## Available commands');
  });

  it('uses trusted native capabilities from the tool context', async () => {
    const ctx = createToolContext({
      helpCapabilities: {
        portable: 'supported',
        native: 'supported',
        tui: 'not_verified',
        desktop: 'not_verified',
      },
    });
    const out = await help.execute({ view: 'commands', scope: 'all' }, ctx);
    expect(out).toContain('/diagnostics');
    expect(out).toContain('/flowguard-ui-probe');
    expect(out).toContain('/flowguard-inline');
    expect(out).toContain('SESSION_REQUIRED');
    expect(out).toContain('not verified on this host');
    expect(out).not.toContain('/desktop-only');
  });

  it('resolves native diagnostic detail without a session or activation', async () => {
    const ctx = createToolContext({
      helpCapabilities: {
        portable: 'supported',
        native: 'supported',
        tui: 'not_verified',
        desktop: 'not_verified',
      },
    });
    const out = await help.execute({ view: 'command', command: 'diagnostics' }, ctx);
    expect(out).toContain('`/diagnostics`');
    expect(out).toContain('Render bounded, read-only Explorer');
    expect(out).not.toContain('SESSION_REQUIRED');
  });

  it('resolves Desktop command detail through the tool without a session', async () => {
    const ctx = createToolContext({
      helpCapabilities: {
        portable: 'supported',
        native: 'not_verified',
        tui: 'not_verified',
        desktop: 'supported',
      },
    });
    const out = await help.execute({ view: 'command', command: 'flowguard-inline' }, ctx);
    expect(out).toContain('`/flowguard-inline`');
    expect(out).toContain('Refresh the read-only Desktop composer status');
    expect(out).toContain('## Command detail');
    expect(out).toContain('desktop=supported');
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
    await plan.execute(
      { planText: '## Plan\n1. Fix auth\n2. Add tests', targetPaths: ['docs/test.md'] },
      ctx,
    );

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

  it('uses the reachable OpenCode glyph configuration for Markdown help', async () => {
    await writeRepoConfig(ws.tmpDir, {
      ...DEFAULT_CONFIG,
      schemaVersion: 'v1',
      presentation: { glyphProfile: 'ascii' },
    });
    const fingerprint = await computeFingerprint(ws.tmpDir);
    await writeState(sessionDir(fingerprint.fingerprint, ctx.sessionID), {
      ...makeProgressedState('PLAN_REVIEW'),
      binding: await canonicalBinding(ws.tmpDir, ctx.sessionID),
      policySnapshot: createPolicySnapshot(
        getPolicyPreset('team'),
        '2026-01-01T00:00:00.000Z',
        hashText,
      ),
      activeChecks: [],
      verificationCandidates: [],
      actorInfo: undefined,
    });

    const out = await help.execute({ view: 'context' }, ctx);

    expect(out).toContain('[WARN] **Why blocked:**');
    expect(out).not.toContain('⚠ **Why blocked:**');
  });

  it('rejects helpCapabilities supplied through tool arguments', async () => {
    const out = await help.execute(
      {
        view: 'commands',
        scope: 'all',
        helpCapabilities: {
          portable: 'supported',
          native: 'supported',
          tui: 'supported',
          desktop: 'supported',
        },
      },
      ctx,
    );
    const parsed = JSON.parse(out as string);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('HELP_ARGUMENTS_INVALID');
  });

  it('command view rejects includeArtifactContent via strict schema', async () => {
    const out = await help.execute(
      {
        view: 'command',
        command: 'start',
        includeArtifactContent: true,
      },
      ctx,
    );
    const parsed = JSON.parse(out as string);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('HELP_ARGUMENTS_INVALID');
    expect(parsed.recovery).toBeDefined();
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
