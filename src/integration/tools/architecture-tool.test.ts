import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeState } from '../../__fixtures__.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  hashFindings,
} from '../review/assurance.js';

const originalFlowguardHostPlatform = process.env.FLOWGUARD_HOST_PLATFORM;

const mocks = vi.hoisted(() => {
  return {
    state: null as unknown,
    isCommandAllowed: vi.fn(() => true),
    executeArchitecture: vi.fn(),
    autoAdvance: vi.fn(),
    validateAdrSections: vi.fn(() => [] as string[]),
    resolveWorkspacePaths: vi.fn(async () => ({ sessDir: '/tmp/session' })),
    requireStateForMutation: vi.fn(async () => makeState('READY')),
    resolvePolicyFromState: vi.fn(() => ({ maxSelfReviewIterations: 3 })),
    createPolicyContext: vi.fn(() => ({
      policy: { maxSelfReviewIterations: 3 },
      now: () => '2026-01-01T00:00:00.000Z',
      digest: (s: string) => `digest:${s}`,
    })),
    formatEval: vi.fn(() => 'next action'),
    formatBlocked: vi.fn((code: string, extra?: Record<string, unknown>) =>
      JSON.stringify({ error: true, code, ...(extra ?? {}) }),
    ),
    formatError: vi.fn((err: unknown) =>
      JSON.stringify({ error: true, code: 'INTERNAL_ERROR', message: String(err) }),
    ),
    appendNextAction: vi.fn((payload: string) => payload),
    writeStateWithArtifacts: vi.fn(async () => undefined),
  };
});

vi.mock('./helpers.js', () => ({
  resolveWorkspacePaths: mocks.resolveWorkspacePaths,
  requireStateForMutation: mocks.requireStateForMutation,
  resolvePolicyFromState: mocks.resolvePolicyFromState,
  createPolicyContext: mocks.createPolicyContext,
  formatEval: mocks.formatEval,
  formatBlocked: mocks.formatBlocked,
  formatError: mocks.formatError,
  appendNextAction: mocks.appendNextAction,
  writeStateWithArtifacts: mocks.writeStateWithArtifacts,
  withMutableSession: vi.fn(async (ctx) => {
    const paths = await mocks.resolveWorkspacePaths(ctx);
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
}));

vi.mock('../../machine/commands.js', () => ({
  Command: { ARCHITECTURE: 'ARCHITECTURE' },
  isCommandAllowed: mocks.isCommandAllowed,
}));

vi.mock('../../rails/architecture.js', () => ({
  executeArchitecture: mocks.executeArchitecture,
}));

vi.mock('../../rails/types.js', () => ({
  autoAdvance: mocks.autoAdvance,
}));

vi.mock('../../machine/evaluate.js', () => ({
  evaluate: () => ({ kind: 'pending' }),
}));

vi.mock('../../state/evidence.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    validateAdrSections: mocks.validateAdrSections,
  };
});

describe('integration/tools/architecture (wrapper)', () => {
  // F13 slice 7c: Mode B now requires reviewFindings (parity with plan/implement).
  // This helper builds a minimal valid ReviewFindings object for tests that
  // exercise the verdict-submission path. Tests for the missing-findings
  // BLOCKED path explicitly omit it.
  const makeFindings = (
    overrides: Partial<{
      iteration: number;
      planVersion: number;
      overallVerdict: 'approve' | 'changes_requested';
    }> = {},
  ) => ({
    iteration: overrides.iteration ?? 1,
    planVersion: overrides.planVersion ?? 1,
    reviewMode: 'subagent' as const,
    overallVerdict: overrides.overallVerdict ?? 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'sess-test' },
    reviewedAt: '2026-01-01T00:00:00.000Z',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = makeState('READY');
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.isCommandAllowed.mockReturnValue(true);
    mocks.validateAdrSections.mockReturnValue([]);
    mocks.executeArchitecture.mockReturnValue({
      kind: 'ok',
      state: makeState('ARCHITECTURE', {
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      transitions: [],
    });
    mocks.autoAdvance.mockReturnValue({
      state: makeState('ARCHITECTURE', {
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      evalResult: { kind: 'pending' },
      transitions: [],
    });
  });

  afterEach(() => {
    if (originalFlowguardHostPlatform === undefined) {
      delete process.env.FLOWGUARD_HOST_PLATFORM;
    } else {
      process.env.FLOWGUARD_HOST_PLATFORM = originalFlowguardHostPlatform;
    }
  });

  it('blocks Mode A without title', async () => {
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ adrText: 'x' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('EMPTY_ADR_TITLE');
  });

  it('blocks Mode A without adrText', async () => {
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ title: 'x' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('EMPTY_ADR_TEXT');
  });

  it('surfaces blocked result from executeArchitecture', async () => {
    mocks.executeArchitecture.mockReturnValue({
      kind: 'blocked',
      code: 'MISSING_ADR_SECTIONS',
      reason: 'missing',
      recovery: ['fix'],
      quickFix: ['fix'],
    });
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('MISSING_ADR_SECTIONS');
  });

  it('writes state and returns payload on Mode A success', async () => {
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.phase).toBe('ARCHITECTURE');
    expect(mocks.writeStateWithArtifacts).toHaveBeenCalledTimes(1);
  });

  it('blocks mixed ADR submission and review verdict', async () => {
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        reviewVerdict: 'approve',
      },
      {} as never,
    );
    expect(JSON.parse(String(res)).code).toBe('ADR_SUBMISSION_MIXED_INPUTS');
  });

  it('blocks ADR resubmission during active review loop', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      { title: 'ADR 2', adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC' },
      {} as never,
    );
    expect(JSON.parse(String(res)).code).toBe('ADR_REVIEW_IN_PROGRESS');
  });

  it('blocks Mode B when command is not allowed', async () => {
    mocks.state = makeState('TICKET');
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.isCommandAllowed.mockReturnValue(false);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'approve' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('blocks Mode B when selfReview is missing', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: null,
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'approve' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('ARCHITECTURE_REVIEW_LOOP_REQUIRED');
  });

  it('blocks Mode B when architecture is missing', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'approve' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('NO_ARCHITECTURE');
  });

  it('blocks changes_requested without revised text', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        reviewVerdict: 'changes_requested',
        reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'changes_requested' }),
      },
      {} as never,
    );
    expect(JSON.parse(String(res)).code).toBe('EMPTY_ADR_TEXT');
  });

  it('blocks changes_requested when revised ADR sections are invalid', async () => {
    mocks.validateAdrSections.mockReturnValue(['## Decision']);
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        reviewVerdict: 'changes_requested',
        adrText: '## Context\nOnly',
        reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'changes_requested' }),
      },
      {} as never,
    );
    expect(JSON.parse(String(res)).code).toBe('MISSING_ADR_SECTIONS');
  });

  it('returns non-converged status for changes_requested with valid revision', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        reviewVerdict: 'changes_requested',
        adrText: '## Context\nA2\n\n## Decision\nB\n\n## Consequences\nC',
        reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'changes_requested' }),
      },
      {} as never,
    );
    expect(JSON.parse(String(res)).status).toContain('iteration 1/3');
  });

  it('returns converged status and finalizes accepted architecture', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.autoAdvance.mockReturnValue({
      state: makeState('ARCH_COMPLETE', {
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      evalResult: { kind: 'ready' },
      transitions: [],
    });
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        reviewVerdict: 'approve',
        reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'approve' }),
      },
      {} as never,
    );
    expect(JSON.parse(String(res)).status).toContain('converged');
    const parsed = JSON.parse(String(res));
    expect(parsed.reviewCard).toBeDefined();
    expect(typeof parsed.reviewCard).toBe('string');
    expect(parsed.reviewCard).toContain('# FlowGuard Architecture Review');
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as {
      architecture?: { status?: string };
    };
    expect(writtenState.architecture?.status).toBe('accepted');
  });

  it('accepts the F13 reviewFindings arg (slice 7a additive surface)', async () => {
    // F13 slice 7a adds reviewFindings as an optional arg on the architecture
    // tool, mirroring plan/implement. In slice 7a the arg is wired into the
    // zod schema but not yet consumed by the runtime — the tool MUST accept
    // a well-formed reviewFindings payload without new error codes, and MUST
    // behave byte-identically to a call that omits the arg. Slice 7c will
    // start consuming the arg.
    const { architecture } = await import('./architecture.js');
    const findings = {
      iteration: 1,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'approve' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'sess-test' },
      reviewedAt: '2026-01-01T00:00:00.000Z',
    };
    const res = await architecture.execute(
      { title: 'x', adrText: 'y', reviewFindings: findings },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    // Same Mode-A success outcome as the baseline test above, regardless of
    // whether reviewFindings was supplied.
    expect(parsed.phase).toBe('ARCHITECTURE');
    expect(mocks.writeStateWithArtifacts).toHaveBeenCalledTimes(1);
  });

  it('formats error when dependency throws', async () => {
    mocks.resolveWorkspacePaths.mockRejectedValueOnce(new Error('boom'));
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('INTERNAL_ERROR');
  });

  // ── F13 slice 7b: Mode-A INDEPENDENT_REVIEW_REQUIRED + reviewObligation ──

  it('emits INDEPENDENT_REVIEW_REQUIRED next-action when subagentEnabled=true (Mode A)', async () => {
    // Slice 7b: when policy.selfReview.subagentEnabled=true, the architecture
    // tool MUST emit a next-action that instructs the primary agent to call
    // the flowguard-reviewer subagent before submitting a verdict. Mirrors
    // plan.ts and implement.ts behavior. The orchestrator (slice 6) detects
    // this marker to dispatch the subagent automatically.
    mocks.resolvePolicyFromState.mockReturnValueOnce({
      maxSelfReviewIterations: 3,
      selfReview: { subagentEnabled: true },
    } as never);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.next).toContain('INDEPENDENT_REVIEW_REQUIRED');
    expect(parsed.next).toContain('flowguard-reviewer');
    expect(parsed.next).toContain('Task tool');
    expect(parsed.next).toContain('full ADR text');
    expect(parsed.next).toContain('ticket text');
    expect(parsed.reviewMode).toBe('subagent');
  });

  it('attaches an architecture review obligation when subagentEnabled=true (Mode A)', async () => {
    // Slice 7b: the response and the persisted state must carry a fresh
    // ReviewObligation with obligationType='architecture' so:
    //  (a) the orchestrator can identify the subagent dispatch target, and
    //  (b) Mode B verdict submission can be cross-checked via
    //      validateReviewFindings (slice 7c).
    mocks.resolvePolicyFromState.mockReturnValueOnce({
      maxSelfReviewIterations: 3,
      selfReview: { subagentEnabled: true },
    } as never);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.reviewObligation).toBeDefined();
    expect(parsed.reviewObligation.obligationType).toBe('architecture');
    expect(parsed.reviewObligation.iteration).toBe(0);
    expect(parsed.reviewObligation.planVersion).toBe(1);
    expect(parsed.reviewObligation.obligationId).toBeDefined();
    // Backward-compat flat fields parity with plan.ts
    expect(parsed.reviewObligationId).toBe(parsed.reviewObligation.obligationId);
    expect(parsed.reviewObligationIteration).toBe(0);
    // Persisted state carries the obligation
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as {
      reviewAssurance?: { obligations?: Array<{ obligationType?: string }> };
    };
    expect(writtenState.reviewAssurance?.obligations).toHaveLength(1);
    expect(writtenState.reviewAssurance?.obligations?.[0]?.obligationType).toBe('architecture');
  });

  it('keeps legacy self-review next-action when subagentEnabled=false (Mode A)', async () => {
    // Slice 7b backwards-compat guarantee: with the legacy default
    // (subagentEnabled absent or false), the Mode-A response MUST NOT
    // mention INDEPENDENT_REVIEW_REQUIRED, MUST set reviewMode='self',
    // and MUST NOT attach a reviewObligation. This pin protects the
    // backwards-compat fallback path against accidental coupling.
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.next).not.toContain('INDEPENDENT_REVIEW_REQUIRED');
    expect(parsed.next).toContain('Self-review needed');
    expect(parsed.reviewMode).toBe('self');
    expect(parsed.reviewObligation).toBeUndefined();
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as {
      reviewAssurance?: { obligations?: unknown[] };
    };
    expect(writtenState.reviewAssurance?.obligations ?? []).toHaveLength(0);
  });

  // ── F13 slice 7c: Mode-B reviewFindings ingestion + persistence ─────

  it('blocks Mode B when reviewFindings is missing (slice 7c)', async () => {
    // Slice 7c parity with plan/implement: Mode B MUST require reviewFindings.
    // Returns REVIEW_FINDINGS_REQUIRED before any verdict-specific check
    // (e.g. EMPTY_ADR_TEXT) is reached.
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'approve' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('persists reviewFindings append-only on the architecture record (slice 7c)', async () => {
    // Slice 7c: parallel storage to plan.reviewFindings — each Mode-B
    // submission appends one entry to architecture.reviewFindings, never
    // overwrites or replaces. Mirrors plan.ts:392-395 invariant.
    const existingFinding = {
      iteration: 1,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'changes_requested' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'sess-prev' },
      reviewedAt: '2025-12-31T00:00:00.000Z',
    };
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
        reviewFindings: [existingFinding],
      },
      selfReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: 'digest-prev',
        currDigest: 'digest-adr',
        revisionDelta: 'minor',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    // autoAdvance mock must echo the input state for this persistence test
    // (the default mock returns a fresh state without reviewFindings, which
    // would mask the field on writeStateWithArtifacts).
    mocks.autoAdvance.mockImplementation((s: unknown) => ({
      state: s,
      evalResult: { kind: 'pending' },
      transitions: [],
    }));
    const newFinding = makeFindings({ iteration: 1, overallVerdict: 'approve' });
    const { architecture } = await import('./architecture.js');
    await architecture.execute(
      { reviewVerdict: 'approve', reviewFindings: newFinding },
      {} as never,
    );
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as {
      architecture?: { reviewFindings?: Array<{ overallVerdict?: string }> };
    };
    expect(writtenState.architecture?.reviewFindings).toHaveLength(2);
    expect(writtenState.architecture?.reviewFindings?.[0]?.overallVerdict).toBe(
      'changes_requested',
    );
    expect(writtenState.architecture?.reviewFindings?.[1]?.overallVerdict).toBe('approve');
  });

  it('routes overallVerdict=unable_to_review to BLOCKED in Mode B (slice 7c, P1.3 parity)', async () => {
    // Slice 7c hooks into validateReviewFindings, which (per P1.3 slice 4e)
    // fail-closes any unable_to_review findings at the tool layer with
    // SUBAGENT_UNABLE_TO_REVIEW. This pin defends defense-in-depth for
    // architecture, parity with plan/implement.
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const findings = {
      ...makeFindings({ iteration: 0 }),
      overallVerdict: 'unable_to_review' as const,
      reasonCode: 'INSUFFICIENT_CONTEXT' as const,
      reasonDetail: 'no ticket text',
    };
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      { reviewVerdict: 'approve', reviewFindings: findings },
      {} as never,
    );
    expect(JSON.parse(String(res)).code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
  });

  it('emits INDEPENDENT_REVIEW_REQUIRED next-action on non-converged Mode B (slice 7c)', async () => {
    // Slice 7c: when subagentEnabled=true and the loop has not converged,
    // the response must instruct the primary agent to call the subagent
    // again for the next iteration, mirroring plan.ts:543-551.
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      selfReview: { subagentEnabled: true },
    } as never);
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        reviewVerdict: 'changes_requested',
        adrText: '## Context\nA2\n\n## Decision\nB\n\n## Consequences\nC',
        reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'changes_requested' }),
      },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.next).toContain('INDEPENDENT_REVIEW_REQUIRED');
    expect(parsed.next).toContain('flowguard-reviewer');
    expect(parsed.next).toContain('iteration=1');
    expect(parsed.reviewMode).toBe('subagent');
    expect(parsed.reviewObligation?.obligationType).toBe('architecture');
    expect(parsed.reviewObligation?.iteration).toBe(1);
  });

  it('blocks Mode B when reviewVerdict does not match reviewFindings.overallVerdict', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'd2',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        reviewVerdict: 'approve',
        reviewFindings: {
          iteration: 1,
          planVersion: 1,
          reviewMode: 'subagent',
          overallVerdict: 'changes_requested',
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          reviewedBy: { sessionId: 's1' },
          reviewedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('SUBAGENT_FINDINGS_VERDICT_MISMATCH');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // BUG-15 Stufe 2: evidence-based findings resolution in tool layer
  // ═════════════════════════════════════════════════════════════════════════

  describe('BUG-15 Stufe 2: evidence-resolve in architecture tool', () => {
    const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
    const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
    const now = '2026-01-01T00:00:00.000Z';

    const validRawFindings: Record<string, unknown> = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_child' },
      reviewedAt: now,
    };

    function stateWithEvidence(verdict: 'approve' | 'changes_requested' = 'approve') {
      const rawFindings = { ...validRawFindings, overallVerdict: verdict };
      return makeState('ARCHITECTURE', {
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          createdAt: now,
        },
        selfReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'digest-adr',
          revisionDelta: 'major',
          verdict: 'changes_requested',
        },
        reviewAssurance: {
          obligations: [
            {
              obligationId: OBLIGATION_ID,
              obligationType: 'architecture',
              iteration: 0,
              planVersion: 1,
              criteriaVersion: REVIEW_CRITERIA_VERSION,
              mandateDigest: REVIEW_MANDATE_DIGEST,
              createdAt: now,
              pluginHandshakeAt: now,
              status: 'fulfilled',
              invocationId: INVOCATION_ID,
              blockedCode: null,
              fulfilledAt: now,
              consumedAt: null,
            },
          ],
          invocations: [
            {
              invocationId: INVOCATION_ID,
              obligationId: OBLIGATION_ID,
              obligationType: 'architecture',
              parentSessionId: 'ses_parent',
              childSessionId: 'ses_child',
              agentType: 'flowguard-reviewer',
              invocationMode: 'host_subagent_task',
              hostVisible: true,
              promptHash: 'abc',
              mandateDigest: REVIEW_MANDATE_DIGEST,
              criteriaVersion: REVIEW_CRITERIA_VERSION,
              findingsHash: hashFindings(rawFindings),
              invokedAt: now,
              fulfilledAt: now,
              consumedByObligationId: null,
              capturedVerdict: verdict,
              capturedRawFindings: rawFindings,
            },
          ],
        },
      });
    }

    function strictArchitectureFindings(overallVerdict: 'approve' | 'changes_requested' = 'approve') {
      return {
        ...validRawFindings,
        overallVerdict,
        attestation: {
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          toolObligationId: OBLIGATION_ID,
          iteration: 0,
          planVersion: 1,
          reviewedBy: 'flowguard-reviewer' as const,
        },
      };
    }

    function stateWithManualAttestedEvidence() {
      const findings = strictArchitectureFindings('approve');
      return makeState('ARCHITECTURE', {
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          createdAt: now,
        },
        selfReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'digest-adr',
          revisionDelta: 'major',
          verdict: 'changes_requested',
        },
        reviewAssurance: {
          obligations: [
            {
              obligationId: OBLIGATION_ID,
              obligationType: 'architecture',
              iteration: 0,
              planVersion: 1,
              criteriaVersion: REVIEW_CRITERIA_VERSION,
              mandateDigest: REVIEW_MANDATE_DIGEST,
              createdAt: now,
              pluginHandshakeAt: null,
              status: 'fulfilled',
              invocationId: INVOCATION_ID,
              blockedCode: null,
              fulfilledAt: now,
              consumedAt: null,
            },
          ],
          invocations: [
            {
              invocationId: INVOCATION_ID,
              obligationId: OBLIGATION_ID,
              obligationType: 'architecture',
              parentSessionId: 'ses_parent',
              childSessionId: 'ses_child',
              agentType: 'flowguard-reviewer',
              invocationMode: 'manual_attested',
              hostVisible: false,
              promptHash: 'abc',
              mandateDigest: REVIEW_MANDATE_DIGEST,
              criteriaVersion: REVIEW_CRITERIA_VERSION,
              findingsHash: hashFindings(findings),
              invokedAt: now,
              fulfilledAt: now,
              consumedByObligationId: null,
              source: 'agent-submitted-attested',
            },
          ],
        },
      });
    }

    it('HAPPY: host_task_required + no reviewFindings + evidence available → succeeds', async () => {
      mocks.state = stateWithEvidence('approve');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      mocks.autoAdvance.mockReturnValue({
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute({ reviewVerdict: 'approve' }, {} as never);
      const parsed = JSON.parse(String(res));
      // Should NOT be blocked — evidence-resolved findings used
      expect(parsed.error).toBeUndefined();
    });

    it('BAD: host_task_required + no reviewFindings + no evidence → BLOCKED', async () => {
      // State WITHOUT evidence (empty invocations)
      const stateNoEvidence = makeState('ARCHITECTURE', {
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          createdAt: now,
        },
        selfReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'digest-adr',
          revisionDelta: 'major',
          verdict: 'changes_requested',
        },
        reviewAssurance: {
          obligations: [],
          invocations: [],
        },
      });
      mocks.state = stateNoEvidence;
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute({ reviewVerdict: 'approve' }, {} as never);
      const parsed = JSON.parse(String(res));
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
    });

    it('BAD: host_task_required + evidence verdict != reviewVerdict → BLOCKED', async () => {
      // Evidence says changes_requested, agent says approve
      mocks.state = stateWithEvidence('changes_requested');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        { reviewVerdict: 'approve' }, // mismatch
        {} as never,
      );
      const parsed = JSON.parse(String(res));
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('SUBAGENT_FINDINGS_VERDICT_MISMATCH');
    });

    it('EDGE: non-host_task + no reviewFindings → BLOCKED (unchanged behavior)', async () => {
      mocks.state = stateWithEvidence('approve');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'sdk_allowed', // NOT host_task_required
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute({ reviewVerdict: 'approve' }, {} as never);
      const parsed = JSON.parse(String(res));
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
    });

    it('EDGE: host_task_required + agent submits reviewFindings → ignored, evidence used (BUG-17)', async () => {
      mocks.state = stateWithEvidence('approve');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      mocks.autoAdvance.mockReturnValue({
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        {
          reviewVerdict: 'approve',
          reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'approve' }),
        },
        {} as never,
      );
      const parsed = JSON.parse(String(res));
      // BUG-17: Should succeed via evidence (agent reviewFindings ignored)
      expect(parsed.error).toBeUndefined();
    });

    it('EDGE: host_task_required + agent submits INVALID reviewFindings → still succeeds (ignored)', async () => {
      // BUG-17: In host_task_required mode, agent-submitted reviewFindings are
      // completely ignored. Even invalid/mismatched findings don't cause a BLOCKED
      // because evidence is resolved from plugin instead.
      mocks.state = stateWithEvidence('approve');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      mocks.autoAdvance.mockReturnValue({
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        {
          reviewVerdict: 'approve',
          // Agent submits WRONG iteration — would normally be blocked, but BUG-17 ignores it
          reviewFindings: makeFindings({ iteration: 999, overallVerdict: 'changes_requested' }),
        },
        {} as never,
      );
      const parsed = JSON.parse(String(res));
      // Still succeeds — evidence 'approve' matches reviewVerdict 'approve'
      expect(parsed.error).toBeUndefined();
    });

    it('REGRESSION: sdk_allowed + agent submits reviewFindings → validates (non-host_task path)', async () => {
      // BUG-17 regression guard: non-host_task modes still validate agent findings
      mocks.state = stateWithEvidence('approve');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'sdk_allowed',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      mocks.autoAdvance.mockReturnValue({
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        {
          reviewVerdict: 'approve',
          reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'approve' }),
        },
        {} as never,
      );
      const parsed = JSON.parse(String(res));
      // SDK path succeeds with valid findings
      expect(parsed.error).toBeUndefined();
    });

    it('HAPPY: sdk_allowed + Claude manual_attested reviewFindings converge without pluginHandshakeAt', async () => {
      process.env.FLOWGUARD_HOST_PLATFORM = 'claude-code';
      mocks.state = stateWithManualAttestedEvidence();
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'sdk_allowed',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: true },
      });
      mocks.autoAdvance.mockReturnValue({
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        { reviewVerdict: 'approve', reviewFindings: strictArchitectureFindings('approve') },
        {} as never,
      );
      const parsed = JSON.parse(String(res));
      expect(parsed.error).toBeUndefined();
    });

    it('CORNER: host_task_required + changes_requested verdict + evidence → proceeds to revision', async () => {
      mocks.state = stateWithEvidence('changes_requested');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      mocks.autoAdvance.mockReturnValue({
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        {
          reviewVerdict: 'changes_requested',
          adrText: '## Context\nRevised\n\n## Decision\nB\n\n## Consequences\nC',
        },
        {} as never,
      );
      const parsed = JSON.parse(String(res));
      // Should proceed with changes_requested — no BLOCKED
      expect(parsed.error).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // BUG-21: Null-tolerant mode detection (defense-in-depth for Fix F)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('BUG-21: null-tolerant mode detection (architecture tool)', () => {
    it('HAPPY: reviewVerdict=null + title + adrText → Mode A (initial submission)', async () => {
      mocks.requireStateForMutation.mockResolvedValue(
        makeState('ARCHITECTURE', { ticket: { text: 'x', digest: 'd', source: 'user' } }),
      );
      const { architecture } = await import('./architecture.js');
      const raw = await architecture.execute(
        {
          title: 'ADR-001',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          reviewVerdict: null,
        } as any,
        {} as never,
      );
      const parsed = JSON.parse(String(raw));
      // Should NOT be blocked with ADR_SUBMISSION_MIXED_INPUTS
      // because null is not treated as "has verdict"
      expect(parsed.code).not.toBe('ADR_SUBMISSION_MIXED_INPUTS');
    });

    it('HAPPY: reviewVerdict="" + title + adrText → Mode A (empty string treated as absent)', async () => {
      mocks.requireStateForMutation.mockResolvedValue(
        makeState('ARCHITECTURE', { ticket: { text: 'x', digest: 'd', source: 'user' } }),
      );
      const { architecture } = await import('./architecture.js');
      const raw = await architecture.execute(
        {
          title: 'ADR-001',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          reviewVerdict: '',
        } as any,
        {} as never,
      );
      const parsed = JSON.parse(String(raw));
      expect(parsed.code).not.toBe('ADR_SUBMISSION_MIXED_INPUTS');
    });

    it('CORNER: reviewVerdict=null → isInitialSubmission=true (consistent with hasVerdict=false)', async () => {
      mocks.requireStateForMutation.mockResolvedValue(
        makeState('ARCHITECTURE', { ticket: { text: 'x', digest: 'd', source: 'user' } }),
      );
      const { architecture } = await import('./architecture.js');
      // With null verdict AND title → isInitialSubmission should be true
      // The ADR_SUBMISSION_MIXED_INPUTS guard: if (hasTitle && hasVerdict) → blocked
      // With hasVerdict=false (null), this guard doesn't fire
      const raw = await architecture.execute(
        {
          title: 'ADR-001',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          reviewVerdict: null,
        } as any,
        {} as never,
      );
      const parsed = JSON.parse(String(raw));
      expect(parsed.code).not.toBe('ADR_SUBMISSION_MIXED_INPUTS');
      expect(parsed.error).toBeUndefined();
    });
  });
});
