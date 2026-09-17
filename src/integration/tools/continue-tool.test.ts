/**
 * @module continue-tool.test
 * @description Runtime tests for P8 three-flow hardening.
 *
 * Covers:
 * - ARCHITECTURE → guidance with /architecture command
 * - PEER_REVIEW phase → guidance
 * - READY → CONTINUE_AMBIGUOUS block
 * - User-gate phases (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW) → manual_decision
 * - Terminal phases (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) → terminal
 * - Unknown phase → CONTINUE_UNKNOWN_PHASE
 * - Empty implementation → IMPLEMENTATION_EVIDENCE_EMPTY
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import type { SessionState } from '../../state/schema.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Shared mock handle ──────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const state: unknown = null;
  const readOnlySession: unknown = null;
  return {
    readOnlySession,
    changedFilesResult: [] as string[],
    state,
    // helpers
    resolveWorkspacePaths: vi.fn(async () => ({
      sessDir: '/tmp/sess',
      worktree: '/tmp/worktree',
      fingerprint: 'test',
      wsDir: '/tmp/ws',
    })),
    requireStateForMutation: vi.fn(async () => mocks.state),
    resolvePolicyFromState: vi.fn(() => ({ reviewBudget: { plan: 3, architecture: 3 } })),
    createPolicyContext: vi.fn(() => ({
      policy: { reviewBudget: { plan: 3, architecture: 3 } },
      now: () => '2026-01-01T00:00:00.000Z',
      digest: (s: string) => `digest:${s}`,
    })),
    formatBlocked: vi.fn((code: string) => JSON.stringify({ error: true, code })),
    formatError: vi.fn((err: unknown) =>
      JSON.stringify({ error: true, code: 'INTERNAL_ERROR', message: String(err) }),
    ),
    enrichWithWorkflowDirective: vi.fn((value: Record<string, unknown>) => ({
      ...value,
      directive: {
        code: `DIRECTIVE_${value.phase}`,
        // The canonical command surface for the peer-review flow remains /review
        // (and its terminal label) after the PEER_REVIEW phase rename.
        commands: [
          `/${String(value.phase)
            .toLowerCase()
            .replace(/^peer_/, '')}`,
        ],
      },
    })),
    writeStateWithArtifacts: vi.fn(async (_sessDir: string, state: SessionState) => state),
    // commands
    isCommandAllowed: vi.fn(() => true),
    Command: { IMPLEMENT: 'IMPLEMENT' as const },
    // git
    changedFiles: vi.fn(async () => mocks.changedFilesResult),
    // evaluate
    evaluate: vi.fn(() => ({ kind: 'pending' as const })),
  };
});

vi.mock('./helpers.js', () => ({
  withReadOnlySession: vi.fn(async () => mocks.readOnlySession),
  withMutableSession: vi.fn(async (ctx) => {
    const paths = await mocks.resolveWorkspacePaths();
    const state = await mocks.requireStateForMutation();
    const policy = mocks.resolvePolicyFromState();
    const ctx2 = mocks.createPolicyContext();
    return {
      worktree: paths.worktree ?? '/tmp/test',
      fingerprint: paths.fingerprint ?? 'test',
      sessDir: paths.sessDir,
      wsDir: paths.wsDir ?? '/tmp/ws',
      state,
      policy,
      ctx: ctx2,
    };
  }),
  withMutableSessionTransaction: vi.fn(async (ctx, fn) => {
    const paths = await mocks.resolveWorkspacePaths();
    const state = await mocks.requireStateForMutation();
    const policy = mocks.resolvePolicyFromState();
    const ctx2 = mocks.createPolicyContext();
    return fn({
      worktree: paths.worktree ?? '/tmp/test',
      fingerprint: paths.fingerprint ?? 'test',
      sessDir: paths.sessDir,
      wsDir: paths.wsDir ?? '/tmp/ws',
      state,
      policy,
      ctx: ctx2,
    });
  }),
  resolveWorkspacePaths: mocks.resolveWorkspacePaths,
  requireStateForMutation: mocks.requireStateForMutation,
  resolvePolicyFromState: mocks.resolvePolicyFromState,
  createPolicyContext: mocks.createPolicyContext,
  formatBlocked: mocks.formatBlocked,
  enrichWithWorkflowDirective: mocks.enrichWithWorkflowDirective,
  writeStateWithArtifacts: mocks.writeStateWithArtifacts,
}));

vi.mock('./error-format.js', () => ({
  formatError: mocks.formatError,
}));

vi.mock('../../machine/commands.js', () => ({
  isCommandAllowed: mocks.isCommandAllowed,
  Command: mocks.Command,
}));

vi.mock('../../adapters/git.js', () => ({
  changedFiles: mocks.changedFiles,
  isGitRepo: vi.fn().mockResolvedValue(true),
  isGitRepoStrict: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../machine/evaluate.js', () => ({
  evaluate: mocks.evaluate,
}));

// ── Continue tool ───────────────────────────────────────────────────────────

function setPhase(phase: string) {
  const state = { phase };
  mocks.state = state;
  mocks.readOnlySession = { state, policy: null };
}

describe('flowguard_continue (runtime)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPhase('READY');
  });

  // ── HAPPY: deterministic guidance ─────────────────────────────────────────

  it('ARCHITECTURE phase derives its action from the canonical product projection', async () => {
    setPhase('ARCHITECTURE');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('ARCHITECTURE');
    expect(parsed.directive.commands).toEqual(['/architecture']);
    expect(parsed._continue.action).toBe('deterministic');
  });

  it('PEER_REVIEW phase derives its action from the canonical product projection', async () => {
    setPhase('PEER_REVIEW');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('PEER_REVIEW');
    expect(parsed.directive.commands).toEqual(['/review']);
    expect(parsed._continue.action).toBe('deterministic');
  });

  it('IMPL_REVIEW does not introduce a local reviewer command', async () => {
    setPhase('IMPL_REVIEW');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('IMPL_REVIEW');
    expect(parsed.directive.commands).toEqual(['/impl_review']);
    expect(parsed.status).toBe('Implementation review is pending.');
  });

  it('IMPL_REVIEW with a blocked implement obligation surfaces the blocker instead of claiming a pending review', async () => {
    setPhase('IMPL_REVIEW');
    mocks.state = {
      phase: 'IMPL_REVIEW',
      reviewAssurance: {
        obligations: [
          {
            obligationType: 'implement',
            status: 'blocked',
            blockedCode: 'REVIEW_ATTEMPT_UNAVAILABLE',
          },
        ],
      },
    };
    mocks.readOnlySession = { state: mocks.state, policy: null };
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.status).toContain('blocked (REVIEW_ATTEMPT_UNAVAILABLE)');
    expect(parsed.status).not.toContain('Implementation review is pending.');
  });

  // ── BAD: blocking on ambiguous / unknown ──────────────────────────────────

  it('blocks READY phase with CONTINUE_AMBIGUOUS', async () => {
    setPhase('READY');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    expect(mocks.formatBlocked).toHaveBeenCalledWith('CONTINUE_AMBIGUOUS', expect.anything());
    const parsed = JSON.parse(String(res));
    expect(parsed.code).toBe('CONTINUE_AMBIGUOUS');
  });

  it('VALIDATION phase returns guidance with /check', async () => {
    setPhase('VALIDATION');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('VALIDATION');
    expect(parsed.directive.commands).toEqual(['/validation']);
    expect(parsed._continue.action).toBe('deterministic');
  });

  it('blocks unknown phase with CONTINUE_UNKNOWN_PHASE', async () => {
    setPhase('BOGUS_ZONE');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    expect(mocks.formatBlocked).toHaveBeenCalledWith('CONTINUE_UNKNOWN_PHASE', expect.anything());
    const parsed = JSON.parse(String(res));
    expect(parsed.code).toBe('CONTINUE_UNKNOWN_PHASE');
  });

  // ── USER GATES: manual decisions ──────────────────────────────────────────

  it('PLAN_REVIEW returns user-gate manual_decision', async () => {
    setPhase('PLAN_REVIEW');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('PLAN_REVIEW');
    expect(parsed._continue.action).toBe('manual_decision');
    expect(parsed.directive.commands).toEqual(['/plan_review']);
    expect(parsed.decisionRequired).toBe(true);
  });

  it('EVIDENCE_REVIEW returns user-gate manual_decision', async () => {
    setPhase('EVIDENCE_REVIEW');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('EVIDENCE_REVIEW');
    expect(parsed._continue.action).toBe('manual_decision');
  });

  it('ARCH_REVIEW returns user-gate manual_decision', async () => {
    setPhase('ARCH_REVIEW');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('ARCH_REVIEW');
    expect(parsed._continue.action).toBe('manual_decision');
  });

  // ── TERMINAL: workflow complete ───────────────────────────────────────────

  it('COMPLETE returns terminal action', async () => {
    setPhase('COMPLETE');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('COMPLETE');
    expect(parsed._continue.action).toBe('terminal');
    expect(parsed.directive.commands).toEqual(['/complete']);
  });

  it('ARCH_COMPLETE returns terminal action', async () => {
    setPhase('ARCH_COMPLETE');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('ARCH_COMPLETE');
    expect(parsed._continue.action).toBe('terminal');
    expect(parsed.directive.commands).toEqual(['/arch_complete']);
  });

  it('REVIEW_COMPLETE returns terminal action', async () => {
    setPhase('PEER_REVIEW_COMPLETE');
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('PEER_REVIEW_COMPLETE');
    expect(parsed._continue.action).toBe('terminal');
    expect(parsed.directive.commands).toEqual(['/review_complete']);
  });

  it('COMPLETE aborted → redirects to /status, never /review or /export', async () => {
    // Governance integrity: an aborted terminal session must not be routed to
    // /export as an audit package.
    const state = { phase: 'COMPLETE', error: { code: 'ABORTED', message: 'Operator aborted' } };
    mocks.state = state;
    mocks.readOnlySession = { state, policy: null };
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('COMPLETE');
    expect(parsed._continue.action).toBe('terminal');
    expect(parsed.directive.commands).toEqual(['/complete']);
    expect(String(parsed.status).toLowerCase()).toContain('aborted');
  });

  // ── ERROR: catch handler ──────────────────────────────────────────────────

  it('returns INTERNAL_ERROR when dependency throws', async () => {
    setPhase('TICKET');
    const { continue_cmd } = await import('./continue-tool.js');
    mocks.enrichWithWorkflowDirective.mockImplementation(() => {
      throw new Error('catastrophic');
    });
    const res = await continue_cmd.execute({}, {} as never);
    expect(mocks.formatError).toHaveBeenCalled();
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('INTERNAL_ERROR');
  });
});

// ── Empty implementation block (P8a.1) ──────────────────────────────────────

describe('implement: empty evidence guard (P8a.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enrichWithWorkflowDirective.mockImplementation((value: Record<string, unknown>) => ({
      ...value,
      directive: {
        code: `DIRECTIVE_${value.phase}`,
        commands: [`/${String(value.phase).toLowerCase()}`],
      },
    }));
    mocks.state = {
      phase: 'IMPLEMENTATION',
      ticket: { text: 't', digest: 'd', source: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
      plan: {
        current: {
          body: 'test plan',
          digest: 'pd',
          sections: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        history: [
          { body: 'test plan', digest: 'pd', sections: [], createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
      mutationEpisodes: [],
      mutationEpisodeResolutions: [],
    };
    mocks.isCommandAllowed.mockReturnValue(true);
    mocks.changedFilesResult = [];
  });

  it('blocks when worktree has no changed files (empty implementation)', async () => {
    mocks.changedFilesResult = [];
    const { implement } = await import('./implement.js');
    const res = await implement.execute({}, {} as never);
    expect(mocks.formatBlocked).toHaveBeenCalledWith(
      'IMPLEMENTATION_EVIDENCE_EMPTY',
      expect.anything(),
    );
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
    const parsed = JSON.parse(String(res));
    expect(parsed.code).toBe('IMPLEMENTATION_EVIDENCE_EMPTY');
  });

  it('does NOT block when worktree has changed files', async () => {
    mocks.changedFilesResult = ['src/foo.ts'];
    const { implement } = await import('./implement.js');
    await implement.execute({}, {} as never);
    const blockedCalls = mocks.formatBlocked.mock.calls.filter(
      (c: [string]) => c[0] === 'IMPLEMENTATION_EVIDENCE_EMPTY',
    );
    expect(blockedCalls).toHaveLength(0);
  });
});
