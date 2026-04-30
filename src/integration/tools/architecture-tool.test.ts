import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeState } from '../../__fixtures__.js';

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
        selfReviewVerdict: 'approve',
      },
      {} as never,
    );
    expect(JSON.parse(String(res)).code).toBe('INVALID_ARCHITECTURE_TOOL_SEQUENCE');
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
    expect(JSON.parse(String(res)).code).toBe('INVALID_ARCHITECTURE_TOOL_SEQUENCE');
  });

  it('blocks Mode B when command is not allowed', async () => {
    mocks.state = makeState('TICKET');
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.isCommandAllowed.mockReturnValue(false);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ selfReviewVerdict: 'approve' }, {} as never);
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
    const res = await architecture.execute({ selfReviewVerdict: 'approve' }, {} as never);
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
    const res = await architecture.execute({ selfReviewVerdict: 'approve' }, {} as never);
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
    const res = await architecture.execute({ selfReviewVerdict: 'changes_requested' }, {} as never);
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
      { selfReviewVerdict: 'changes_requested', adrText: '## Context\nOnly' },
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
        selfReviewVerdict: 'changes_requested',
        adrText: '## Context\nA2\n\n## Decision\nB\n\n## Consequences\nC',
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
    const res = await architecture.execute({ selfReviewVerdict: 'approve' }, {} as never);
    expect(JSON.parse(String(res)).status).toContain('converged');
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as {
      architecture?: { status?: string };
    };
    expect(writtenState.architecture?.status).toBe('accepted');
  });

  it('formats error when dependency throws', async () => {
    mocks.resolveWorkspacePaths.mockRejectedValueOnce(new Error('boom'));
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('INTERNAL_ERROR');
  });
});
