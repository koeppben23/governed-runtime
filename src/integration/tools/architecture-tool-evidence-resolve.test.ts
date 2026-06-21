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
  withMutableSessionTransaction: vi.fn(async (ctx, fn) => {
    const paths = await mocks.resolveWorkspacePaths(ctx);
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

describe('architecture — BUG-15 evidence-resolve', () => {
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
      kind: 'advanced',
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

  describe('BUG-15 Stufe 2: evidence-resolve in architecture tool', () => {
    const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
    const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
    const now = '2026-01-01T00:00:00.000Z';

    const validRawFindings: Record<string, unknown> = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'accept',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_child' },
      reviewedAt: now,
    };

    function stateWithEvidence(verdict: 'accept' | 'changes_requested' = 'accept') {
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

    function strictArchitectureFindings(overallVerdict: 'accept' | 'changes_requested' = 'accept') {
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
      const findings = strictArchitectureFindings('accept');
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
      mocks.state = stateWithEvidence('accept');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      mocks.autoAdvance.mockReturnValue({
        kind: 'advanced',
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
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
      const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
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
        { reviewVerdict: 'accept' }, // mismatch
        {} as never,
      );
      const parsed = JSON.parse(String(res));
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('SUBAGENT_FINDINGS_VERDICT_MISMATCH');
    });

    it('EDGE: non-host_task + no reviewFindings → BLOCKED (unchanged behavior)', async () => {
      mocks.state = stateWithEvidence('accept');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'sdk_allowed', // NOT host_task_required
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
      const parsed = JSON.parse(String(res));
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
    });

    it('EDGE: host_task_required + agent submits reviewFindings → ignored, evidence used (BUG-17)', async () => {
      mocks.state = stateWithEvidence('accept');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      mocks.autoAdvance.mockReturnValue({
        kind: 'advanced',
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        {
          reviewVerdict: 'accept',
          reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'accept' }),
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
      mocks.state = stateWithEvidence('accept');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      mocks.autoAdvance.mockReturnValue({
        kind: 'advanced',
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        {
          reviewVerdict: 'accept',
          // Agent submits WRONG iteration — would normally be blocked, but BUG-17 ignores it
          reviewFindings: makeFindings({ iteration: 999, overallVerdict: 'changes_requested' }),
        },
        {} as never,
      );
      const parsed = JSON.parse(String(res));
      // Still succeeds — evidence 'accept' matches reviewVerdict 'accept'
      expect(parsed.error).toBeUndefined();
    });

    it('REGRESSION: sdk_allowed + agent submits reviewFindings → validates (non-host_task path)', async () => {
      // BUG-17 regression guard: non-host_task modes still validate agent findings
      mocks.state = stateWithEvidence('accept');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'sdk_allowed',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      mocks.autoAdvance.mockReturnValue({
        kind: 'advanced',
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        {
          reviewVerdict: 'accept',
          reviewFindings: makeFindings({ iteration: 0, overallVerdict: 'accept' }),
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
        kind: 'advanced',
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      const res = await architecture.execute(
        { reviewVerdict: 'accept', reviewFindings: strictArchitectureFindings('accept') },
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
        kind: 'advanced',
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
});
