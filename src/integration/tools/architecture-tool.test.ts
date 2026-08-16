import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeState } from '../../fixtures.js';
import { TEAM_POLICY } from '../../config/policy-presets.js';
import { CHALLENGE_POLICY_V1 } from '../../config/policy-types.js';
import type { SessionState } from '../../state/schema.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import { discoveryRiskPaths } from '../discovery-risk-paths.js';
import { assessMinimumTaskClass, maxTaskClass } from '../phase-tool-gate.js';

const originalFlowguardHostPlatform = process.env.FLOWGUARD_HOST_PLATFORM;

const mocks = vi.hoisted(() => {
  return {
    state: null as SessionState | null,
    isCommandAllowed: vi.fn(() => true),
    executeArchitecture: vi.fn(),
    autoAdvance: vi.fn(),
    validateAdrSections: vi.fn(() => [] as string[]),
    resolveWorkspacePaths: vi.fn(async () => ({
      worktree: '/tmp/test',
      fingerprint: 'test',
      sessDir: '/tmp/session',
      wsDir: '/tmp/ws',
    })),
    requireStateForMutation: vi.fn(async () => makeState('READY')),
    resolvePolicyFromState: vi.fn(() => ({
      ...TEAM_POLICY,
      reviewInvocationPolicy: 'self',
      selfReview: {
        ...TEAM_POLICY.selfReview,
        subagentEnabled: false,
        strictEnforcement: false,
      },
    })),
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
    writeStateWithArtifacts: vi.fn<(sessDir: string, state: SessionState) => Promise<SessionState>>(
      async (_sessDir: string, state: SessionState) => state,
    ),
    changedFiles: vi.fn(async () => [] as string[]),
    readDiscovery: vi.fn(async () => null as DiscoveryResult | null),
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

vi.mock('../../adapters/git.js', () => ({
  changedFiles: mocks.changedFiles,
  headCommitFull: vi.fn().mockResolvedValue('a'.repeat(40)),
}));

vi.mock('../../adapters/persistence-discovery.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, readDiscovery: mocks.readDiscovery };
});

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
      overallVerdict: 'accept' | 'changes_requested';
    }> = {},
  ) => ({
    iteration: overrides.iteration ?? 1,
    planVersion: overrides.planVersion ?? 1,
    reviewMode: 'subagent' as const,
    overallVerdict: overrides.overallVerdict ?? 'accept',
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
    mocks.changedFiles.mockResolvedValue([]);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      reviewInvocationPolicy: 'self',
      selfReview: {
        ...TEAM_POLICY.selfReview,
        subagentEnabled: false,
        strictEnforcement: false,
      },
    });
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
          reviewCompletion: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      transitions: [],
    });
    mocks.autoAdvance.mockReturnValue({
      kind: 'advanced',
      state: makeState('ARCH_COMPLETE', {
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          reviewCompletion: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          claimDeclarations: {
            flow: 'architecture',
            claims: [
              {
                claimId: 'a1111111-1111-1111-1111-111111111111',
                statement: 'The decision uses a safe approach.',
                critical: true,
                authoritySectionId: 'sec-1',
                requiredReviewEvidence: ['review-evid-1'],
              },
            ],
          },
        },
      }),
      evalResult: { kind: 'ready' },
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

  it('creates the Mode A obligation without a git diff (ADR carries no diff; no dead-end)', async () => {
    // Regression (live SHA 5891eec): an ADR submission under an active
    // challengePolicy used to hard-block with RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE
    // because it has no branch/PR/targetPaths diff. Challenge classification now
    // derives from persisted discovery evidence and the claimed task class, so a
    // pure ADR with no detected risk surface succeeds with a TRIVIAL (count 0)
    // obligation instead of dead-ending.
    const policySnapshot = {
      ...makeState('READY').policySnapshot,
      challengePolicy: TEAM_POLICY.challengePolicy,
    };
    mocks.state = makeState('READY', { policySnapshot });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.executeArchitecture.mockReturnValue({
      kind: 'ok',
      state: makeState('ARCHITECTURE', {
        policySnapshot,
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          reviewCompletion: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      transitions: [],
    });
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      selfReview: { ...TEAM_POLICY.selfReview, subagentEnabled: true },
    });
    // Discovery absent → no detected risk surface. Git is irrelevant to an ADR:
    // even a rejecting git diff must not change the outcome.
    mocks.readDiscovery.mockResolvedValueOnce(null);
    mocks.changedFiles.mockRejectedValueOnce(new Error('git unavailable'));

    const { architecture } = await import('./architecture.js');
    const parsed = JSON.parse(
      String(await architecture.execute({ title: 'x', adrText: 'y' }, {} as never)),
    );

    expect(parsed.phase).toBe('ARCHITECTURE');
    expect(mocks.writeStateWithArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.readDiscovery).toHaveBeenCalledTimes(1);
    expect(parsed._audit).toEqual({ transitions: [] });
    const savedState = mocks.writeStateWithArtifacts.mock.calls.at(-1)?.[1] as SessionState;
    const obligation = savedState.reviewAssurance?.obligations.at(-1);
    expect(obligation?.obligationType).toBe('architecture');
    expect(obligation?.requiredChallengeCount).toBe(0);
    expect(obligation?.metadata?.targetPaths).toBeUndefined();
    // The ADR artifact is the review SUBJECT — never the repository diff or
    // discovery risk surfaces (regression: review_finding_out_of_scope on
    // artifact-anchored findings because the scope was repository_change).
    expect(obligation?.reviewSubjectScope?.kind).toBe('artifact');
    if (obligation?.reviewSubjectScope?.kind === 'artifact') {
      expect(obligation.reviewSubjectScope.artifact.kind).toBe('adr');
      expect(obligation.reviewSubjectScope.artifact.digest).toBe('digest-adr');
      expect(obligation.reviewSubjectScope.artifact.sectionPaths).toEqual([
        [{ headingDepth: 2, siblingIndex: 1, headingText: 'Context' }],
        [{ headingDepth: 2, siblingIndex: 2, headingText: 'Decision' }],
        [{ headingDepth: 2, siblingIndex: 3, headingText: 'Consequences' }],
      ]);
    }
  });

  it('floors the Mode A challenge count on discovery risk surfaces (no targetPaths, no git diff)', async () => {
    // B-floor: with no author targetPaths and no git diff, the challenge count is
    // driven by the repository's persisted risk surfaces. A detected persistence
    // surface classifies as STANDARD, so the ADR obligation requires >= 1
    // challenge — proving discovery evidence, not a dead-end, governs the count.
    const discovery = {
      surfaces: {
        api: [],
        persistence: [
          {
            id: 'repo',
            label: 'repo',
            classification: 'fact',
            evidence: ['src/db/repository.ts'],
          },
        ],
        cicd: [],
        security: [],
        layers: [],
      },
    } as unknown as DiscoveryResult;

    const expectedPaths = discoveryRiskPaths(discovery);
    const expectedClass = maxTaskClass(
      assessMinimumTaskClass(expectedPaths).minimumTaskClass,
      'TRIVIAL',
    );
    const expectedCount = CHALLENGE_POLICY_V1.counts[expectedClass];
    // Guard: the fixture must exercise a non-trivial floor, else the test proves nothing.
    expect(expectedPaths.length).toBeGreaterThan(0);
    expect(expectedCount).toBeGreaterThan(0);

    const policySnapshot = {
      ...makeState('READY').policySnapshot,
      challengePolicy: TEAM_POLICY.challengePolicy,
    };
    mocks.state = makeState('READY', { policySnapshot });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.executeArchitecture.mockReturnValue({
      kind: 'ok',
      state: makeState('ARCHITECTURE', {
        policySnapshot,
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          reviewCompletion: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      transitions: [],
    });
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      selfReview: { ...TEAM_POLICY.selfReview, subagentEnabled: true },
    });
    mocks.readDiscovery.mockResolvedValueOnce(discovery);

    const { architecture } = await import('./architecture.js');
    const parsed = JSON.parse(
      String(await architecture.execute({ title: 'x', adrText: 'y' }, {} as never)),
    );

    expect(parsed.phase).toBe('ARCHITECTURE');
    const savedState = mocks.writeStateWithArtifacts.mock.calls.at(-1)?.[1] as SessionState;
    const obligation = savedState.reviewAssurance?.obligations.at(-1);
    expect(obligation?.requiredChallengeCount).toBe(expectedCount);
    expect(obligation?.metadata?.targetPaths).toEqual(expectedPaths);
  });

  it('unions author targetPaths with discovery surfaces and can only raise the count (optional A)', async () => {
    // Optional A: an author MAY hint targetPaths. They are UNIONED with the
    // detected discovery surfaces (never replace them) and can only raise the
    // challenge count. Here discovery alone is STANDARD (count 1); a HIGH-RISK
    // author path lifts the union to HIGH-RISK (count 2).
    const discovery = {
      surfaces: {
        api: [],
        persistence: [
          {
            id: 'repo',
            label: 'repo',
            classification: 'fact',
            evidence: ['src/db/repository.ts'],
          },
        ],
        cicd: [],
        security: [],
        layers: [],
      },
    } as unknown as DiscoveryResult;
    const authorPaths = ['src/migrations/001-add-table.ts'];
    const discoveryPaths = discoveryRiskPaths(discovery);
    const expectedUnion = [...new Set([...authorPaths, ...discoveryPaths])];
    const expectedClass = maxTaskClass(
      assessMinimumTaskClass(expectedUnion).minimumTaskClass,
      'TRIVIAL',
    );
    const expectedCount = CHALLENGE_POLICY_V1.counts[expectedClass];
    const discoveryOnlyCount =
      CHALLENGE_POLICY_V1.counts[
        maxTaskClass(assessMinimumTaskClass(discoveryPaths).minimumTaskClass, 'TRIVIAL')
      ];
    // Guard: the author path must strictly RAISE the count above discovery-only.
    expect(expectedCount).toBeGreaterThan(discoveryOnlyCount);

    const policySnapshot = {
      ...makeState('READY').policySnapshot,
      challengePolicy: TEAM_POLICY.challengePolicy,
    };
    mocks.state = makeState('READY', { policySnapshot });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.executeArchitecture.mockReturnValue({
      kind: 'ok',
      state: makeState('ARCHITECTURE', {
        policySnapshot,
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          reviewCompletion: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      transitions: [],
    });
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      selfReview: { ...TEAM_POLICY.selfReview, subagentEnabled: true },
    });
    mocks.readDiscovery.mockResolvedValueOnce(discovery);

    const { architecture } = await import('./architecture.js');
    const parsed = JSON.parse(
      String(
        await architecture.execute(
          { title: 'x', adrText: 'y', targetPaths: authorPaths },
          {} as never,
        ),
      ),
    );

    expect(parsed.phase).toBe('ARCHITECTURE');
    const savedState = mocks.writeStateWithArtifacts.mock.calls.at(-1)?.[1] as SessionState;
    const obligation = savedState.reviewAssurance?.obligations.at(-1);
    expect(obligation?.requiredChallengeCount).toBe(expectedCount);
    expect(obligation?.metadata?.targetPaths).toEqual(expectedUnion);
  });

  it('skips the discovery read and creates no obligation when subagent review is disabled', async () => {
    // Guard: with self-review disabled, classification short-circuits BEFORE any
    // discovery read and creates no obligation, even under an active challengePolicy.
    const policySnapshot = {
      ...makeState('READY').policySnapshot,
      challengePolicy: TEAM_POLICY.challengePolicy,
    };
    mocks.state = makeState('READY', { policySnapshot });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.executeArchitecture.mockReturnValue({
      kind: 'ok',
      state: makeState('ARCHITECTURE', {
        policySnapshot,
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          reviewCompletion: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      transitions: [],
    });
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      selfReview: { ...TEAM_POLICY.selfReview, subagentEnabled: false },
    });

    const { architecture } = await import('./architecture.js');
    const parsed = JSON.parse(
      String(await architecture.execute({ title: 'x', adrText: 'y' }, {} as never)),
    );

    expect(parsed.phase).toBe('ARCHITECTURE');
    expect(parsed.reviewMode).toBe('self');
    expect(mocks.readDiscovery).not.toHaveBeenCalled();
    const savedState = mocks.writeStateWithArtifacts.mock.calls.at(-1)?.[1] as SessionState;
    expect(savedState.reviewAssurance?.obligations ?? []).toHaveLength(0);
  });

  it('creates an obligation without challenge requirements and skips discovery when no challengePolicy is active', async () => {
    // Guard: an absent challengePolicy (e.g. a solo-derived snapshot) short-circuits
    // before the discovery read; the subagent obligation is created but carries no
    // challenge-count requirement.
    const policySnapshot = {
      ...makeState('READY').policySnapshot,
      challengePolicy: undefined,
    };
    mocks.state = makeState('READY', { policySnapshot });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.executeArchitecture.mockReturnValue({
      kind: 'ok',
      state: makeState('ARCHITECTURE', {
        policySnapshot,
        architecture: {
          id: 'ADR-001',
          title: 'ADR',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          digest: 'digest-adr',
          status: 'proposed',
          reviewCompletion: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      transitions: [],
    });
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      selfReview: { ...TEAM_POLICY.selfReview, subagentEnabled: true },
    });

    const { architecture } = await import('./architecture.js');
    const parsed = JSON.parse(
      String(await architecture.execute({ title: 'x', adrText: 'y' }, {} as never)),
    );

    expect(parsed.phase).toBe('ARCHITECTURE');
    expect(mocks.readDiscovery).not.toHaveBeenCalled();
    const savedState = mocks.writeStateWithArtifacts.mock.calls.at(-1)?.[1] as SessionState;
    const obligation = savedState.reviewAssurance?.obligations.at(-1);
    expect(obligation?.obligationType).toBe('architecture');
    expect(obligation?.requiredChallengeCount).toBeUndefined();
  });

  it('blocks mixed ADR submission and review verdict', async () => {
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        reviewVerdict: 'accept',
      },
      {} as never,
    );
    expect(JSON.parse(String(res)).code).toBe('ADR_SUBMISSION_MIXED_INPUTS');
  });

  it('blocks adrText + reviewVerdict=accept with ADR_APPROVE_WITH_TEXT (#499 gap closed, mirrors verdict)', async () => {
    // #499: an approval carrying adrText (the heavy payload, no title) previously
    // routed to review and SILENTLY DROPPED the adrText. It now fails closed,
    // analogous to plan's PLAN_APPROVE_WITH_TEXT.
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        reviewVerdict: 'accept',
      },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('ADR_APPROVE_WITH_TEXT');
    // Anti-confabulation: the verdict the caller sent is forwarded to the block
    // (this suite mocks formatBlocked, so it surfaces as the passed-through param;
    // the rendered "reviewVerdict=..." message is covered by the reasons tests).
    expect(parsed.receivedVerdict).toBe('accept');
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
  });

  it('blocks reviewerUnavailable mixed into an ADR submission with INVALID_ARCHITECTURE_TOOL_SEQUENCE (#499: dead code now wired)', async () => {
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        reviewerUnavailable: true,
      },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('INVALID_ARCHITECTURE_TOOL_SEQUENCE');
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
  });

  it('blocks ADR resubmission during active review loop', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        reviewCompletion: 'pending',
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
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
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
        reviewCompletion: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: null,
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
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
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
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
        reviewCompletion: 'pending',
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
        reviewCompletion: 'pending',
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
        reviewCompletion: 'pending',
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

  it('invalidates a prior approval certificate when the ADR is revised', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        reviewCompletion: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        approvalCertificate: {
          flow: 'architecture',
          authorityDigest: 'digest-adr',
          claimDeclarationsDigest: 'claims-digest',
          decisionAttestationDigest: 'decision-digest',
          approvedAt: '2026-01-01T00:00:00.000Z',
          approvedBy: 'reviewer',
          certificateId: '00000000-0000-4000-8000-000000000001',
          reviewBinding: {
            kind: 'current_review',
            reviewObligationId: '00000000-0000-4000-8000-000000000002',
            reviewEvidenceDigest: 'review-evidence-digest',
            reviewedSubjectDigest: 'digest-adr',
          },
        },
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
    mocks.autoAdvance.mockImplementation((state: SessionState) => ({
      kind: 'advanced',
      state,
      evalResult: { kind: 'pending' },
      transitions: [],
    }));

    const { architecture } = await import('./architecture.js');
    await architecture.execute(
      {
        reviewVerdict: 'changes_requested',
        adrText: '## Context\nA2\n\n## Decision\nB\n\n## Consequences\nC',
        reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'changes_requested' }),
      },
      {} as never,
    );

    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as SessionState;
    expect(writtenState.architecture?.approvalCertificate).toBeUndefined();
  });

  it('routes reviewer acceptance to the human architecture gate', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        reviewCompletion: 'pending',
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
    mocks.autoAdvance.mockImplementation((state: SessionState) => ({
      kind: 'advanced',
      state: { ...state, phase: 'ARCH_REVIEW' },
      evalResult: { kind: 'waiting', phase: 'ARCH_REVIEW', reason: 'human decision required' },
      transitions: [],
    }));
    const { architecture } = await import('./architecture.js');
    const res = await architecture.execute(
      {
        reviewVerdict: 'accept',
        reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'accept' }),
      },
      {} as never,
    );
    expect(JSON.parse(String(res)).status).toContain('Human approval is required');
    const parsed = JSON.parse(String(res));
    expect(parsed.reviewCard).toBeDefined();
    expect(typeof parsed.reviewCard).toBe('string');
    expect(parsed.reviewCard).toContain('# FlowGuard Architecture Review');
    expect(parsed.presentation).toEqual({ markdown: parsed.reviewCard });
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as {
      architecture?: { status?: string };
    };
    expect(parsed.phase).toBe('ARCH_REVIEW');
    expect(writtenState.architecture?.status).toBe('proposed');
    expect((writtenState.architecture as { reviewCompletion?: string }).reviewCompletion).toBe(
      'reviewer_accepted',
    );
  });

  it('force-converges to the human gate (ARCH_REVIEW) instead of blocking at the iteration limit', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        reviewCompletion: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      // iteration 2 + this review → 3 == maxSelfReviewIterations: force-convergence.
      selfReview: {
        iteration: 2,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.autoAdvance.mockImplementation((state: SessionState) => ({
      kind: 'advanced',
      state: { ...state, phase: 'ARCH_REVIEW' },
      evalResult: { kind: 'waiting', phase: 'ARCH_REVIEW', reason: 'human decision required' },
      transitions: [],
    }));
    const { architecture } = await import('./architecture.js');
    const parsed = JSON.parse(
      String(
        await architecture.execute(
          {
            reviewVerdict: 'changes_requested',
            adrText: '## Context\nA3\n\n## Decision\nB\n\n## Consequences\nC',
            reviewFindings: makeFindings({ iteration: 2, overallVerdict: 'changes_requested' }),
          },
          {} as never,
        ),
      ),
    );

    expect(parsed.error).not.toBe(true);
    expect(parsed.code).toBeUndefined();
    expect(parsed.phase).toBe('ARCH_REVIEW');
    expect(parsed.status).toContain('iteration limit');
    expect(parsed.status).toContain('without reviewer approval');
    expect(parsed.status).toContain('Human approval is required');
    expect(parsed.reviewCard).toContain('Reviewer did NOT approve');
  });

  it('never auto-finalizes an exhausted ADR in auto-approve modes', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      architecture: {
        id: 'ADR-001',
        title: 'ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        digest: 'digest-adr',
        status: 'proposed',
        reviewCompletion: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      selfReview: {
        iteration: 2,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.autoAdvance.mockImplementation((state: SessionState) => ({
      kind: 'advanced',
      state: { ...state, phase: 'ARCH_REVIEW' },
      evalResult: { kind: 'waiting', phase: 'ARCH_REVIEW', reason: 'human decision required' },
      transitions: [],
    }));
    const { architecture } = await import('./architecture.js');
    const parsed = JSON.parse(
      String(
        await architecture.execute(
          {
            reviewVerdict: 'changes_requested',
            adrText: '## Context\nA3\n\n## Decision\nB\n\n## Consequences\nC',
            reviewFindings: makeFindings({ iteration: 2, overallVerdict: 'changes_requested' }),
          },
          {} as never,
        ),
      ),
    );

    expect(parsed.error).not.toBe(true);
    expect(parsed.code).toBeUndefined();
    expect(parsed.phase).toBe('ARCH_REVIEW');
    expect(parsed.status).toContain('without reviewer approval');
    expect(parsed.status).toContain('Human approval is required');
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as SessionState;
    expect(writtenState.architecture?.status).toBe('proposed');
    expect(writtenState.architecture?.reviewCompletion).toBe('review_exhausted');
  });

  it('rejects reviewFindings without a verdict in a submission (#499: no silent discard)', async () => {
    // #499 hardening: previously the architecture tool silently DISCARDED
    // reviewFindings supplied on a Mode-A submission (no verdict). That mixed
    // shape is now rejected with ADR_FINDINGS_WITHOUT_VERDICT, matching plan's
    // PLAN_FINDINGS_WITHOUT_VERDICT and implement's INVALID_IMPLEMENT_TOOL_SEQUENCE.
    const { architecture } = await import('./architecture.js');
    const findings = {
      iteration: 1,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'accept' as const,
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
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('ADR_FINDINGS_WITHOUT_VERDICT');
    // Fail-closed: no state written on a rejected submission.
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
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
      ...TEAM_POLICY,
      maxSelfReviewIterations: 3,
      selfReview: { ...TEAM_POLICY.selfReview, subagentEnabled: true },
    });
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
      ...TEAM_POLICY,
      maxSelfReviewIterations: 3,
      selfReview: { ...TEAM_POLICY.selfReview, subagentEnabled: true },
    });
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
        reviewCompletion: 'pending',
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
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
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
        reviewCompletion: 'pending',
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
    mocks.autoAdvance.mockImplementation((s: SessionState) => ({
      kind: 'advanced',
      state: s,
      evalResult: { kind: 'pending' },
      transitions: [],
    }));
    const newFinding = makeFindings({ iteration: 1, overallVerdict: 'accept' });
    const { architecture } = await import('./architecture.js');
    await architecture.execute(
      { reviewVerdict: 'accept', reviewFindings: newFinding },
      {} as never,
    );
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as {
      architecture?: { reviewFindings?: Array<{ overallVerdict?: string }> };
    };
    expect(writtenState.architecture?.reviewFindings).toHaveLength(2);
    expect(writtenState.architecture?.reviewFindings?.[0]?.overallVerdict).toBe(
      'changes_requested',
    );
    expect(writtenState.architecture?.reviewFindings?.[1]?.overallVerdict).toBe('accept');
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
        reviewCompletion: 'pending',
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
      { reviewVerdict: 'accept', reviewFindings: findings },
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
        reviewCompletion: 'pending',
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
        reviewCompletion: 'pending',
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
        reviewVerdict: 'accept',
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // BUG-21: Null-tolerant mode detection (defense-in-depth for Fix F)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('BUG-21: null-tolerant mode detection (architecture tool)', () => {
    it('HAPPY: reviewVerdict=null + title + adrText → Mode A (initial submission)', async () => {
      mocks.requireStateForMutation.mockResolvedValue(
        makeState('ARCHITECTURE', {
          ticket: { text: 'x', digest: 'd', source: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        }),
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
        makeState('ARCHITECTURE', {
          ticket: { text: 'x', digest: 'd', source: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        }),
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
        makeState('ARCHITECTURE', {
          ticket: { text: 'x', digest: 'd', source: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        }),
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
