/**
 * @module continue-tool.test
 * @description Runtime tests for P8 three-flow hardening.
 *
 * Covers:
 * - ARCHITECTURE → guidance with /architecture command
 * - REVIEW phase → guidance
 * - READY → CONTINUE_AMBIGUOUS block
 * - User-gate phases (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW) → manual_decision
 * - Terminal phases (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) → terminal
 * - Unknown phase → CONTINUE_UNKNOWN_PHASE
 * - Empty implementation → IMPLEMENTATION_EVIDENCE_EMPTY
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Shared mock handle ──────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  readOnlySession: null as unknown,
  changedFilesResult: [] as string[],
  state: null as unknown,
  // helpers
  resolveWorkspacePaths: vi.fn(async () => ({
    sessDir: '/tmp/sess',
    worktree: '/tmp/worktree',
  })),
  requireStateForMutation: vi.fn(async () => mocks.state),
  resolvePolicyFromState: vi.fn(() => ({ maxSelfReviewIterations: 3 })),
  createPolicyContext: vi.fn(() => ({
    policy: { maxSelfReviewIterations: 3 },
    now: () => '2026-01-01T00:00:00.000Z',
    digest: (s: string) => `digest:${s}`,
  })),
  formatBlocked: vi.fn((code: string) => JSON.stringify({ error: true, code })),
  formatError: vi.fn((err: unknown) =>
    JSON.stringify({ error: true, code: 'INTERNAL_ERROR', message: String(err) }),
  ),
  appendNextAction: vi.fn((p: string) => p),
  writeStateWithArtifacts: vi.fn(async () => undefined),
  formatEval: vi.fn(() => 'next'),
  // commands
  isCommandAllowed: vi.fn(() => true),
  Command: { IMPLEMENT: 'IMPLEMENT' as const },
  // git
  changedFiles: vi.fn(async () => mocks.changedFilesResult),
  // evaluate
  evaluate: vi.fn(() => ({ kind: 'pending' as const })),
}));

vi.mock('./helpers.js', () => ({
  withReadOnlySession: vi.fn(async () => mocks.readOnlySession),
  resolveWorkspacePaths: mocks.resolveWorkspacePaths,
  requireStateForMutation: mocks.requireStateForMutation,
  resolvePolicyFromState: mocks.resolvePolicyFromState,
  createPolicyContext: mocks.createPolicyContext,
  formatBlocked: mocks.formatBlocked,
  formatError: mocks.formatError,
  appendNextAction: mocks.appendNextAction,
  writeStateWithArtifacts: mocks.writeStateWithArtifacts,
  formatEval: mocks.formatEval,
}));

vi.mock('../../machine/commands.js', () => ({
  isCommandAllowed: mocks.isCommandAllowed,
  Command: mocks.Command,
}));

vi.mock('../../adapters/git.js', () => ({
  changedFiles: mocks.changedFiles,
}));

vi.mock('../../machine/evaluate.js', () => ({
  evaluate: mocks.evaluate,
}));

// ── Continue tool ───────────────────────────────────────────────────────────

function setPhase(phase: string) {
  mocks.readOnlySession = { state: { phase }, policy: null };
}

describe('flowguard_continue (runtime)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPhase('READY');
  });

  // ── HAPPY: deterministic guidance ─────────────────────────────────────────

  it('ARCHITECTURE phase returns guidance with /architecture', async () => {
    setPhase('ARCHITECTURE');
    mocks.appendNextAction.mockImplementation((p: string) => p);
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('ARCHITECTURE');
    expect(parsed.next).toBe('/architecture');
    expect(parsed._continue.action).toBe('deterministic');
  });

  it('REVIEW phase returns guidance with /review', async () => {
    setPhase('REVIEW');
    mocks.appendNextAction.mockImplementation((p: string) => p);
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('REVIEW');
    expect(parsed.next).toBe('/review');
    expect(parsed._continue.action).toBe('deterministic');
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
    mocks.appendNextAction.mockImplementation((p: string) => p);
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('PLAN_REVIEW');
    expect(parsed._continue.action).toBe('manual_decision');
    expect(parsed.next).toContain('/approve');
    expect(parsed.next).toContain('/request-changes');
    expect(parsed.next).toContain('/reject');
  });

  it('EVIDENCE_REVIEW returns user-gate manual_decision', async () => {
    setPhase('EVIDENCE_REVIEW');
    mocks.appendNextAction.mockImplementation((p: string) => p);
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('EVIDENCE_REVIEW');
    expect(parsed._continue.action).toBe('manual_decision');
  });

  it('ARCH_REVIEW returns user-gate manual_decision', async () => {
    setPhase('ARCH_REVIEW');
    mocks.appendNextAction.mockImplementation((p: string) => p);
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('ARCH_REVIEW');
    expect(parsed._continue.action).toBe('manual_decision');
  });

  // ── TERMINAL: workflow complete ───────────────────────────────────────────

  it('COMPLETE returns terminal action', async () => {
    setPhase('COMPLETE');
    mocks.appendNextAction.mockImplementation((p: string) => p);
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('COMPLETE');
    expect(parsed._continue.action).toBe('terminal');
    expect(parsed.next).toBe('/export');
  });

  it('ARCH_COMPLETE returns terminal action', async () => {
    setPhase('ARCH_COMPLETE');
    mocks.appendNextAction.mockImplementation((p: string) => p);
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('ARCH_COMPLETE');
    expect(parsed._continue.action).toBe('terminal');
    expect(parsed.next).toBe('/export');
  });

  it('REVIEW_COMPLETE returns terminal action', async () => {
    setPhase('REVIEW_COMPLETE');
    mocks.appendNextAction.mockImplementation((p: string) => p);
    const { continue_cmd } = await import('./continue-tool.js');
    const res = await continue_cmd.execute({}, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('REVIEW_COMPLETE');
    expect(parsed._continue.action).toBe('terminal');
    expect(parsed.next).toBe('/export');
  });

  // ── ERROR: catch handler ──────────────────────────────────────────────────

  it('returns INTERNAL_ERROR when dependency throws', async () => {
    setPhase('TICKET');
    const { continue_cmd } = await import('./continue-tool.js');
    mocks.appendNextAction.mockImplementation(() => {
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
