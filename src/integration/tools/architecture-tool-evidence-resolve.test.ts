import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeState } from '../../fixtures.js';
import { TEAM_POLICY } from '../../config/policy-presets.js';
import { CHALLENGE_POLICY_V1 } from '../../config/policy-types.js';
import type { SessionState } from '../../state/schema.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import { discoveryRiskPaths } from '../discovery-risk-paths.js';
import { assessMinimumTaskClass, maxTaskClass } from '../phase-tool-gate.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  hashFindings,
} from '../review/assurance.js';

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
    writeStateWithArtifacts: vi.fn<(sessDir: string, state: SessionState) => Promise<void>>(
      async () => undefined,
    ),
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

vi.mock('../../adapters/persistence-discovery.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, readDiscovery: mocks.readDiscovery };
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
              reviewOutputMode: 'structured_output',
              structuredOutputUsed: true,
              reviewAssuranceLevel: 'structured_high',
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
              reviewOutputMode: 'structured_output',
              structuredOutputUsed: true,
              reviewAssuranceLevel: 'structured_high',
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

    it('HAPPY: host_task_required + only verdict submitted + evidence resolved → card shows findings and ADR text', async () => {
      // Bug: args.reviewFindings was used for latestReview/attachReviewCard,
      // but in host_task_required mode the agent submits only the verdict.
      // Fix: review.effectiveFindings carries the resolved evidence findings.
      const capturedFindings = {
        iteration: 0,
        planVersion: 1,
        reviewMode: 'subagent' as const,
        overallVerdict: 'accept',
        blockingIssues: [],
        majorRisks: [
          {
            severity: 'major',
            category: 'risk',
            message: 'Race condition in in-memory storage',
            location: 'TaskRepository',
          },
          {
            severity: 'minor',
            category: 'quality',
            message: 'Lack of architectural coupling guard',
          },
        ],
        missingVerification: ['No negative-path integration test'],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: { sessionId: 'ses_child' },
        reviewedAt: now,
      };

      const stateWithFindings = makeState('ARCHITECTURE', {
        architecture: {
          id: 'ADR-001',
          title: 'Architecture Decision',
          adrText: '## Context\nctx\n\n## Decision\ndec\n\n## Consequences\ncons\n',
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
              reviewOutputMode: 'structured_output',
              structuredOutputUsed: true,
              reviewAssuranceLevel: 'structured_high',
              hostVisible: true,
              promptHash: 'abc',
              mandateDigest: REVIEW_MANDATE_DIGEST,
              criteriaVersion: REVIEW_CRITERIA_VERSION,
              findingsHash: hashFindings(capturedFindings),
              invokedAt: now,
              fulfilledAt: now,
              consumedByObligationId: null,
              capturedVerdict: 'accept',
              capturedRawFindings: capturedFindings,
            },
          ],
        },
      });
      mocks.state = stateWithFindings;
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        ...TEAM_POLICY,
        maxSelfReviewIterations: 3,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      // autoAdvance retains ARCHITECTURE — converged path is triggered by
      // approvedConverged (revisionDelta=none + verdict=accept), not by phase.
      mocks.autoAdvance.mockReturnValue({
        kind: 'advanced',
        state: mocks.state,
        evalResult: { kind: 'pending' },
        transitions: [],
      });

      const { architecture } = await import('./architecture.js');
      // Agent submits ONLY the verdict — no reviewFindings (host_task_required contract)
      const res = await architecture.execute({ reviewVerdict: 'accept' }, {} as never);
      const parsed = JSON.parse(String(res));

      // Not blocked — evidence-resolved findings are used
      expect(parsed.error).toBeUndefined();
      // latestReview reflects the resolved evidence findings, not the absent args.reviewFindings
      expect(parsed.latestReview).toBeDefined();
      expect(parsed.latestReview.overallVerdict).toBe('accept');
      expect(parsed.latestReview.majorRiskCount).toBe(2);
      // reviewCard carries the ADR text and resolved findings
      expect(typeof parsed.reviewCard).toBe('string');
      expect(parsed.reviewCard).toContain('## Architecture Decision');
      expect(parsed.reviewCard).toContain('## Context');
      expect(parsed.reviewCard).toContain('## Decision');
      expect(parsed.reviewCard).toContain('## Consequences');
      expect(parsed.reviewCard).toContain('## Reviewer Findings');
      expect(parsed.reviewCard).toContain('### Major Risks (2)');
      expect(parsed.reviewCard).toContain('Race condition in in-memory storage');
      expect(parsed.reviewCard).toContain('Lack of architectural coupling guard');
    });

    it('HAPPY: host_task_required + no reviewFindings + evidence available → succeeds', async () => {
      mocks.state = stateWithEvidence('accept');
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        ...TEAM_POLICY,
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
        ...TEAM_POLICY,
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
        ...TEAM_POLICY,
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
        ...TEAM_POLICY,
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
        ...TEAM_POLICY,
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
        ...TEAM_POLICY,
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
        ...TEAM_POLICY,
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
        ...TEAM_POLICY,
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
        ...TEAM_POLICY,
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

    it('Mode B (revision loop) does not dead-end with no prior/author targetPaths and empty discovery', async () => {
      // Regression: architecture Mode B used the old resolver and hard-blocked with
      // RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE when the prior obligation carried no
      // targetPaths (which the Mode A fix now permits) and an ADR has no diff. It now
      // derives from discovery (empty here) and creates the next obligation instead.
      const base = stateWithEvidence('changes_requested');
      mocks.state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, challengePolicy: CHALLENGE_POLICY_V1 },
      };
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        ...TEAM_POLICY,
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
      mocks.readDiscovery.mockResolvedValueOnce(null);

      const { architecture } = await import('./architecture.js');
      const parsed = JSON.parse(
        String(
          await architecture.execute(
            {
              reviewVerdict: 'changes_requested',
              adrText: '## Context\nRevised\n\n## Decision\nB\n\n## Consequences\nC',
            },
            {} as never,
          ),
        ),
      );

      expect(parsed.error).toBeUndefined();
      expect(parsed.code).not.toBe('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
      // The next-iteration obligation was created (not a dead-end).
      const savedState = mocks.writeStateWithArtifacts.mock.calls.at(-1)?.[1] as SessionState;
      const obligations = savedState.reviewAssurance?.obligations ?? [];
      expect(obligations.length).toBeGreaterThanOrEqual(2);
      expect(obligations.at(-1)?.obligationType).toBe('architecture');
    });

    it('Mode B floors the next-iteration challenge count on discovery risk surfaces', async () => {
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
      expect(expectedCount).toBeGreaterThan(0);

      const base = stateWithEvidence('changes_requested');
      mocks.state = {
        ...base,
        policySnapshot: { ...base.policySnapshot, challengePolicy: CHALLENGE_POLICY_V1 },
      };
      mocks.requireStateForMutation.mockResolvedValue(mocks.state);
      mocks.resolvePolicyFromState.mockReturnValue({
        ...TEAM_POLICY,
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
      mocks.readDiscovery.mockResolvedValueOnce(discovery);

      const { architecture } = await import('./architecture.js');
      const parsed = JSON.parse(
        String(
          await architecture.execute(
            {
              reviewVerdict: 'changes_requested',
              adrText: '## Context\nRevised\n\n## Decision\nB\n\n## Consequences\nC',
            },
            {} as never,
          ),
        ),
      );

      expect(parsed.error).toBeUndefined();
      const savedState = mocks.writeStateWithArtifacts.mock.calls.at(-1)?.[1] as SessionState;
      const nextObligation = savedState.reviewAssurance?.obligations.at(-1);
      expect(nextObligation?.requiredChallengeCount).toBe(expectedCount);
      expect(nextObligation?.metadata?.targetPaths).toEqual(expectedPaths);
    });
  });
});
