import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeState } from '../../fixtures.js';
import { convertArgsToInputSchema } from '../../mcp-server/schema-converter.js';
import { TEAM_POLICY } from '../../config/policy-presets.js';
import { CHALLENGE_POLICY_V1 } from '../../config/policy-types.js';
import type { SessionState } from '../../state/schema.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import { discoveryRiskPaths } from '../discovery/discovery-risk-paths.js';
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
    resolvePolicyFromState: vi.fn(() => TEAM_POLICY),
    createPolicyContext: vi.fn(() => ({
      policy: { reviewBudget: { architecture: 3 } },
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
    enrichWithWorkflowDirective: vi.fn((value: Record<string, unknown>) => value),
    writeStateWithArtifacts: vi.fn<(sessDir: string, state: SessionState) => Promise<SessionState>>(
      async (_sessDir: string, state: SessionState) => state,
    ),
    changedFiles: vi.fn(async () => [] as string[]),
    readDiscovery: vi.fn(async () => null as DiscoveryResult | null),
  };
});

vi.mock('../blocked-result.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../blocked-result.js')>()),
  formatBlocked: mocks.formatBlocked,
}));

const discoveryMock = vi.hoisted(() => ({
  fn: undefined as unknown as (typeof import('../review/context/discovery-attempt-context.js'))['resolveAttemptDiscoveryOrBlock'],
}));

vi.mock('../review/context/discovery-attempt-context.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../review/context/discovery-attempt-context.js')>();
  discoveryMock.fn = vi.fn(actual.resolveAttemptDiscoveryOrBlock);
  return { ...actual, resolveAttemptDiscoveryOrBlock: discoveryMock.fn };
});

vi.mock('./helpers.js', () => ({
  resolveWorkspacePaths: mocks.resolveWorkspacePaths,
  requireStateForMutation: mocks.requireStateForMutation,
  resolvePolicyFromState: mocks.resolvePolicyFromState,
  createPolicyContext: mocks.createPolicyContext,
  formatEval: mocks.formatEval,
  formatError: mocks.formatError,
  enrichWithWorkflowDirective: mocks.enrichWithWorkflowDirective,
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
  headCommitFullStrict: vi.fn().mockResolvedValue('a'.repeat(40)),
}));

vi.mock('../../adapters/persistence-discovery.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/persistence-discovery.js')>();
  return { ...original, readDiscovery: mocks.readDiscovery };
});

vi.mock('../../machine/evaluate.js', () => ({
  evaluate: () => ({ kind: 'pending' }),
}));

vi.mock('../../state/evidence.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../state/evidence.js')>();
  return {
    ...original,
    validateAdrSections: mocks.validateAdrSections,
  };
});

describe('integration/tools/architecture (wrapper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.changedFiles.mockResolvedValue([]);
    mocks.resolvePolicyFromState.mockReturnValue(TEAM_POLICY);
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
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ adrText: 'x' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('EMPTY_ADR_TITLE');
  });

  it('blocks Mode A without adrText', async () => {
    const { architecture } = await import('./architecture/architecture.js');
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
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.code).toBe('MISSING_ADR_SECTIONS');
    expect(parsed.error).toBe(true);
  });

  it('writes state and returns payload on Mode A success', async () => {
    const { architecture } = await import('./architecture/architecture.js');
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
    });
    // Discovery absent → no detected risk surface. Git is irrelevant to an ADR:
    // even a rejecting git diff must not change the outcome.
    mocks.readDiscovery.mockResolvedValueOnce(null);
    mocks.changedFiles.mockRejectedValueOnce(new Error('git unavailable'));

    const { architecture } = await import('./architecture/architecture.js');
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
    });
    mocks.readDiscovery.mockResolvedValueOnce(discovery);

    const { architecture } = await import('./architecture/architecture.js');
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
    });
    mocks.readDiscovery.mockResolvedValueOnce(discovery);

    const { architecture } = await import('./architecture/architecture.js');
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

  it('blocks mixed ADR submission and review verdict', async () => {
    const { architecture } = await import('./architecture/architecture.js');
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
    const { architecture } = await import('./architecture/architecture.js');
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
    const { architecture } = await import('./architecture/architecture.js');
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
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture/architecture.js');
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
    const { architecture } = await import('./architecture/architecture.js');
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
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('ARCHITECTURE_REVIEW_LOOP_REQUIRED');
  });

  it('blocks Mode B when architecture is missing', async () => {
    mocks.state = makeState('ARCHITECTURE', {
      selfReview: {
        iteration: 0,
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('NO_ARCHITECTURE');
  });

  it('does not mutate an ADR when a revision carries agent findings without host evidence', async () => {
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
        reviewCycle: 1,
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

    const { architecture } = await import('./architecture/architecture.js');
    await architecture.execute(
      {
        reviewVerdict: 'changes_requested',
        adrText: '## Context\nA2\n\n## Decision\nB\n\n## Consequences\nC',
      },
      {} as never,
    );

    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
  });

  it('fails closed on an agent-supplied reviewer acceptance without host-captured evidence', async () => {
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
        reviewCycle: 1,
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
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
  });

  it('never auto-finalizes an exhausted ADR from agent-supplied findings without host evidence', async () => {
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
        reviewCycle: 1,
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
    const { architecture } = await import('./architecture/architecture.js');
    const parsed = JSON.parse(
      String(
        await architecture.execute(
          {
            reviewVerdict: 'changes_requested',
            adrText: '## Context\nA3\n\n## Decision\nB\n\n## Consequences\nC',
          },
          {} as never,
        ),
      ),
    );

    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
  });

  it('formats error when dependency throws', async () => {
    mocks.resolveWorkspacePaths.mockRejectedValueOnce(new Error('boom'));
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('INTERNAL_ERROR');
  });

  // ── F13 slice 7b: Mode-A review dispatch + reviewObligation ──

  it('emits the review-dispatch signal for mandatory review (Mode A)', async () => {
    // The architecture tool MUST emit the review-required dispatch signal plus
    // the host-observed child-session binding metadata. Under the structured-only
    // contract no reviewer Task prompt is projected here: the host creates the
    // reviewer child session from the obligation and attestation metadata.
    mocks.resolvePolicyFromState.mockReturnValueOnce({
      ...TEAM_POLICY,
      reviewBudget: { ...TEAM_POLICY.reviewBudget, architecture: 3 },
    });
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.reviewDispatch).toEqual({ required: true });
    expect(parsed.reviewAttemptId).toEqual(expect.any(String));
    expect(parsed.reviewMode).toBe('subagent');
    expect(parsed.reviewInvocation).toBeDefined();
    expect(parsed.reviewInvocation.reviewerSubagentType).toBe('flowguard-reviewer');
    expect(parsed.reviewInvocation.authority).toBe('review_obligation_evidence_binding');
    expect(parsed.reviewInvocation.requiredReviewAttestation.toolObligationId).toBeDefined();
  });

  it('attaches an architecture review obligation for mandatory review (Mode A)', async () => {
    // Slice 7b: the response and the persisted state must carry a fresh
    // ReviewObligation with obligationType='architecture' so:
    //  (a) the orchestrator can identify the subagent dispatch target, and
    //  (b) Mode B verdict submission can be cross-checked via
    //      validateReviewFindings (slice 7c).
    mocks.resolvePolicyFromState.mockReturnValueOnce({
      ...TEAM_POLICY,
      reviewBudget: { ...TEAM_POLICY.reviewBudget, architecture: 3 },
    });
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.reviewObligation).toBeDefined();
    expect(parsed.reviewObligation.obligationType).toBe('architecture');
    expect(parsed.reviewObligation.iteration).toBe(0);
    expect(parsed.reviewObligation.planVersion).toBe(1);
    expect(parsed.reviewObligation.obligationId).toBeDefined();
    expect(parsed).not.toHaveProperty('reviewObligationId');
    expect(parsed).not.toHaveProperty('reviewObligationIteration');
    // Persisted state carries the obligation
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as {
      reviewAssurance?: { obligations?: Array<{ obligationType?: string }> };
    };
    expect(writtenState.reviewAssurance?.obligations).toHaveLength(1);
    expect(writtenState.reviewAssurance?.obligations?.[0]?.obligationType).toBe('architecture');
  });

  it('requires independent review for every initial submission (Mode A)', async () => {
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.reviewDispatch).toEqual({ required: true });
    expect(parsed.reviewAttemptId).toEqual(expect.any(String));
    expect(parsed.reviewMode).toBe('subagent');
    expect(parsed.reviewObligation).toBeDefined();
    const writtenState = mocks.writeStateWithArtifacts.mock.calls[0]?.[1] as {
      reviewAssurance?: { obligations?: unknown[] };
    };
    expect(writtenState.reviewAssurance?.obligations).toHaveLength(1);
  });

  // ── Mode-B host-captured evidence binding ───────────────────────────

  it('blocks Mode B when no host-captured structured evidence is bound', async () => {
    // Findings are never accepted from the agent: a verdict without
    // host-captured structured evidence fails closed with
    // SUBAGENT_EVIDENCE_MISSING before any verdict-specific check
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
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('SUBAGENT_EVIDENCE_MISSING');
  });

  it('persists no agent-supplied findings and retains prior host-captured findings', async () => {
    // The append-only reviewFindings array is written ONLY from host-captured
    // effective findings. A verdict with no bound evidence fails closed, so
    // neither a new entry nor a wipe of the prior capture is ever persisted.
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
      challenges: [],
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
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: 'digest-prev',
        currDigest: 'digest-adr',
        revisionDelta: 'minor',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
  });

  it('fails closed on an agent-supplied unable_to_review without host evidence', async () => {
    // The third verdict is never a tool-submitted shortcut: with no bound
    // captured evidence the call fails closed before any verdict semantics.
    // The bound-evidence unable_to_review path is covered end-to-end by the
    // planning/implementation tool suites.
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
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
    expect(JSON.parse(String(res)).code).toBe('SUBAGENT_EVIDENCE_MISSING');
  });

  it('requires captured findings on a non-converged Mode B call', async () => {
    // Structured-only contract: a non-converged call's findings are authorized
    // only by host-observed structured child-session evidence. Without a bound
    // capture the call fails closed with SUBAGENT_EVIDENCE_MISSING instead of
    // reissuing a reviewer Task.
    mocks.resolvePolicyFromState.mockReturnValue(TEAM_POLICY);
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
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-adr',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute(
      {
        reviewVerdict: 'changes_requested',
        adrText: '## Context\nA2\n\n## Decision\nB\n\n## Consequences\nC',
      },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_MISSING');
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
      const { architecture } = await import('./architecture/architecture.js');
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
      const { architecture } = await import('./architecture/architecture.js');
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
      const { architecture } = await import('./architecture/architecture.js');
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // Tool boundary: the published strict input schema rejects unknown args
  // ═══════════════════════════════════════════════════════════════════════════════

  it('surfaces a structurally blocked reviewer Discovery context with its obligation', async () => {
    vi.mocked(discoveryMock.fn).mockResolvedValueOnce({
      kind: 'blocked',
      reason: 'persisted Discovery basis is unavailable for this repository review',
      obligationId: 'obligation-x',
    });
    const { architecture } = await import('./architecture/architecture.js');
    const res = await architecture.execute({ title: 'x', adrText: 'y' }, {} as never);
    const parsed = JSON.parse(String(res)) as Record<string, unknown>;
    expect(parsed.code).toBe('REVIEWER_CONTEXT_UNAVAILABLE');
    expect(parsed.obligationId).toBe('obligation-x');
    expect(parsed.reason).toBe(
      'persisted Discovery basis is unavailable for this repository review',
    );
    const callArgs = vi.mocked(discoveryMock.fn).mock.calls.at(-1)?.[0] as
      { obligationId?: string } | undefined;
    expect(callArgs?.obligationId).toBeDefined();
  });

  it('forwards provided architecture claims into the rails execution', async () => {
    const { architecture } = await import('./architecture/architecture.js');
    await architecture.execute(
      {
        title: 'x',
        adrText: 'y',
        claims: [
          {
            statement: 'The decision uses a safe approach.',
            authoritySectionId: 'sec-1',
            critical: true,
            requiredReviewEvidence: ['review-evid-1'],
          },
        ],
      },
      {} as never,
    );
    const call = mocks.executeArchitecture.mock.calls.at(-1) as unknown[] | undefined;
    expect(call?.[1]).toMatchObject({
      claims: [expect.objectContaining({ statement: 'The decision uses a safe approach.' })],
    });
  });

  describe('strict tool input schema', () => {
    it('rejects an unknown reviewFindings argument (no agent findings submission)', async () => {
      const { architecture } = await import('./architecture/architecture.js');
      const schema = convertArgsToInputSchema(architecture.args);
      const parsed = schema.safeParse({ reviewVerdict: 'accept', reviewFindings: {} });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
      }
      // Verdict-only submission remains representable.
      expect(schema.safeParse({ reviewVerdict: 'accept' }).success).toBe(true);
    });
  });
});
