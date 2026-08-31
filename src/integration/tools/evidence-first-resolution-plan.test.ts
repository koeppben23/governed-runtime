/**
 * @module integration/tools/evidence-first-resolution-plan.test
 * @description BUG-17 tests: In host_task_required mode, plugin-captured evidence
 * is SSOT — agent-submitted reviewFindings are IGNORED. SDK path continues to
 * validate agent-submitted findings normally.
 *
 * Tests plan.ts and implement.ts evidence-first patterns.
 * (architecture.ts tests are in architecture-tool.test.ts)
 *
 * @test-policy HAPPY, BAD, EDGE, REGRESSION — all categories present.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeState, TICKET } from '../../fixtures.js';
import { TEAM_POLICY } from '../../config/policy-presets.js';
import type { SessionState } from '../../state/schema.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  hashFindings,
} from '../review/assurance.js';
import { computeRecordDigest } from '../../state/evidence-plan.js';

// ═══════════════════════════════════════════════════════════════════════════

const mocks = vi.hoisted(() => {
  return {
    state: null as SessionState | null,
    isCommandAllowed: vi.fn(() => true),
    autoAdvance: vi.fn(),
    resolveWorkspacePaths: vi.fn(async () => ({
      worktree: '/tmp/test',
      fingerprint: 'test',
      sessDir: '/tmp/session',
      wsDir: '/tmp/ws',
    })),
    requireStateForMutation: vi.fn(async () => makeState('TICKET')),
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
    formatAutoAdvanceOverflow: vi.fn((overflow: { phase: string; limit: number }) =>
      JSON.stringify({
        error: true,
        code: 'AUTO_ADVANCE_OVERFLOW',
        autoAdvanceOverflow: { phase: overflow.phase, limit: overflow.limit },
      }),
    ),
    appendNextAction: vi.fn((payload: string) => payload),
    writeStateWithArtifacts: vi.fn(async (_sessDir: string, state: SessionState) => state),
    extractSections: vi.fn(() => []),
    readDiscovery: vi.fn(async () => null as unknown),
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
  formatAutoAdvanceOverflow: mocks.formatAutoAdvanceOverflow,
  extractSections: mocks.extractSections,
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
  Command: { PLAN: 'PLAN', IMPLEMENT: 'IMPLEMENT' },
  isCommandAllowed: mocks.isCommandAllowed,
}));

vi.mock('../../rails/types.js', () => ({
  autoAdvance: mocks.autoAdvance,
  applyTransition: vi.fn((s: unknown) => s),
}));

vi.mock('../../machine/evaluate.js', () => ({
  evaluate: () => ({ kind: 'pending' }),
  evaluateWithEvent: () => ({ kind: 'pending' }),
}));

vi.mock('../../adapters/persistence-discovery.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, readDiscovery: mocks.readDiscovery };
});

vi.mock('../../presentation/phase-labels.js', () => ({
  PHASE_LABELS: { PLAN: 'Plan', PLAN_REVIEW: 'Plan Review' },
}));

vi.mock('../../presentation/next-action-copy.js', () => ({
  buildProductNextAction: vi.fn(() => ''),
}));

vi.mock('../../presentation/plan-review-card.js', () => ({
  buildPlanReviewCard: vi.fn(() => null),
}));

vi.mock('../../adapters/workspace/evidence-artifacts.js', () => ({
  materializeReviewCardArtifact: vi.fn(async () => undefined),
}));

vi.mock('../../machine/next-action.js', () => ({
  resolveNextAction: vi.fn(() => ({ next: 'next action' })),
}));

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
const now = '2026-01-01T00:00:00.000Z';
const originalFlowguardHostPlatform = process.env.FLOWGUARD_HOST_PLATFORM;

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function discoveryWithPaths(evidence: string[]): DiscoveryResult {
  return {
    surfaces: {
      api: [],
      persistence: [{ id: 'r', label: 'r', classification: 'fact', evidence }],
      cicd: [],
      security: [],
      layers: [],
    },
  } as unknown as DiscoveryResult;
}

function makeFindings(
  overrides: Partial<{
    iteration: number;
    planVersion: number;
    overallVerdict: 'accept' | 'changes_requested';
  }> = {},
) {
  return {
    iteration: overrides.iteration ?? 0,
    planVersion: overrides.planVersion ?? 1,
    reviewMode: 'subagent' as const,
    overallVerdict: overrides.overallVerdict ?? 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_child' },
    reviewedAt: now,
  };
}

function makeStrictFindings(
  obligationId: string,
  overrides: Partial<{
    iteration: number;
    planVersion: number;
    overallVerdict: 'accept' | 'changes_requested';
  }> = {},
) {
  return {
    ...makeFindings(overrides),
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: obligationId,
      iteration: overrides.iteration ?? 0,
      planVersion: overrides.planVersion ?? 1,
      reviewedBy: 'flowguard-reviewer' as const,
    },
  };
}

function manualAttestedInvocation(input: {
  obligationType: 'plan' | 'implement';
  findings: Record<string, unknown>;
}) {
  return {
    invocationId: INVOCATION_ID,
    obligationId: OBLIGATION_ID,
    obligationType: input.obligationType,
    parentSessionId: 'ses_parent',
    childSessionId: 'ses_child',
    agentType: 'flowguard-reviewer' as const,
    invocationMode: 'manual_attested' as const,
    reviewOutputMode: 'structured_output' as const,
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high' as const,
    hostVisible: false,
    promptHash: 'abc',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash: hashFindings(input.findings),
    invokedAt: now,
    fulfilledAt: now,
    consumedByObligationId: null,
    source: 'agent-submitted-attested' as const,
  };
}

function planStateWithEvidence(
  verdict: 'accept' | 'changes_requested' = 'accept',
  blockingIssues: unknown[] = [],
) {
  const rawFindings: Record<string, unknown> = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues,
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_child' },
    reviewedAt: now,
  };
  return makeState('PLAN', {
    ticket: TICKET,
    plan: {
      current: {
        body: '## Plan\n1. Fix',
        digest: 'digest-plan',
        sections: [],
        createdAt: now,
        recordDigest: computeRecordDigest({
          contentDigest: 'digest-plan',
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
        }),
        planVersion: 1,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
        lineageStatus: 'verified' as const,
      },
      history: [],
      reviewCompletion: 'pending',
      reviewFindings: [],
    },
    selfReview: {
      iteration: 0,
      maxIterations: 3,
      prevDigest: null,
      currDigest: 'digest-plan',
      revisionDelta: 'major',
      verdict: 'changes_requested',
    },
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      attempts: [
        {
          attemptId: OBLIGATION_ID.replace(/^(\w{8})/, 'd0000001'),
          obligationId: OBLIGATION_ID,
          obligationType: 'plan' as const,
          subjectDigest: 'test-subject-digest',
          childSessionId: 'ses_child',
          ordinal: 0,
          status: 'bound' as const,
          origin: { kind: 'initial' } as const,
          repositoryDiscovery: { kind: 'not_applicable' } as const,
          createdAt: now,
        },
      ],
      dispatches: [],
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
          subjectDigest: 'test-subject-digest',
          iteration: 0,
          planVersion: 1,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          maxReviewerOutputRepairAttempts: 1,
          createdAt: now,
          pluginHandshakeAt: now,
          status: 'fulfilled',
          invocationId: INVOCATION_ID,
          blockedCode: null,
          fulfilledAt: now,
          consumedAt: null,
          reviewSubjectScope: {
            kind: 'repository_change',
            paths: ['src/foo.ts'],
            revisions: ['base', 'head'],
          },
        },
      ],
      invocations: [
        {
          invocationId: INVOCATION_ID,
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
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
          attemptId: OBLIGATION_ID.replace(/^(\w{8})/, 'd0000001'),
        },
      ],
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Plan — BUG-17 Evidence-First Resolution
// ═══════════════════════════════════════════════════════════════════════════

describe('BUG-17: plan evidence-first resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalFlowguardHostPlatform === undefined) {
      delete process.env.FLOWGUARD_HOST_PLATFORM;
    } else {
      process.env.FLOWGUARD_HOST_PLATFORM = originalFlowguardHostPlatform;
    }
  });

  it('HAPPY: host_task_required + evidence available → succeeds (no reviewFindings needed)', async () => {
    mocks.state = planStateWithEvidence('accept');
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

    const { plan } = await import('./plan.js');
    const res = await plan.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));
    // Evidence-resolved findings used — no BLOCKED
    expect(parsed.error).toBeUndefined();
  });

  it('F12 REGRESSION: host_task_required + captured accept WITH blocking issue → BLOCKED, no advance, no persist', async () => {
    // Exact demo defect: the host-captured reviewer record has overallVerdict
    // 'accept' AND a non-empty blockingIssues array. The plan tool must fail
    // closed at evidence resolution and MUST NOT advance to PLAN_REVIEW or
    // persist any converged state.
    mocks.state = planStateWithEvidence('accept', [
      {
        severity: 'minor',
        category: 'quality',
        message: 'stale comment',
        relation: {
          subjectAnchors: [
            { kind: 'repository_location', location: { path: 'src/foo.ts', revision: 'head' } },
          ],
          evidenceLocations: [],
        },
      },
    ]);
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });

    const { plan } = await import('./plan.js');
    const res = await plan.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));

    // 1. Fail-closed with the coherence reason code.
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');

    // 2. No advance to the review gate and no converged state persisted:
    //    the boundary stopped before any state materialization.
    expect(mocks.autoAdvance).not.toHaveBeenCalled();
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
    expect(mocks.appendNextAction).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: auto-advance overflow returns blocked and persists NO state (#428)', async () => {
    mocks.state = planStateWithEvidence('accept');
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });
    // autoAdvance overflows: a non-terminating topology. The overflow variant
    // carries NO advanced state.
    mocks.autoAdvance.mockReturnValue({
      kind: 'overflow',
      phase: 'PLAN_REVIEW',
      limit: 10,
      transitions: [],
    });

    const { plan } = await import('./plan.js');
    const res = await plan.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));

    // 1. Surfaces the structured fail-closed overflow result.
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('AUTO_ADVANCE_OVERFLOW');
    expect(parsed.autoAdvanceOverflow).toEqual({ phase: 'PLAN_REVIEW', limit: 10 });

    // 2. No persistence: the boundary stopped before writeStateWithArtifacts.
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();

    // 3. No substitute advanced state: the success response (built from a
    //    finalState and wrapped by appendNextAction) was never constructed —
    //    a full stop before any state materialization, not just an unpersisted
    //    write.
    expect(mocks.appendNextAction).not.toHaveBeenCalled();
  });

  it('BAD: host_task_required + no evidence → BLOCKED', async () => {
    const stateNoEvidence = makeState('PLAN', {
      ticket: TICKET,
      plan: {
        current: {
          body: '## Plan\n1. Fix',
          digest: 'digest-plan',
          sections: [],
          createdAt: now,
          recordDigest: computeRecordDigest({
            contentDigest: 'digest-plan',
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
          }),
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'verified' as const,
        },
        history: [],
        reviewCompletion: 'pending',
        reviewFindings: [],
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-plan',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [],
        invocations: [],
        attempts: [],
        dispatches: [],
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

    const { plan } = await import('./plan.js');
    const res = await plan.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('initial obligation: no discovery surfaces and no targetPaths → succeeds with empty challenge scope (never dead-ends)', async () => {
    // Pre-implementation SSOT parity: a plan carries no diff, so the historical
    // resolver returned RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE and hard-blocked
    // every enforced-mode initial submission. The shared classifier now derives
    // scope from persisted discovery and NEVER dead-ends. Empty evidence → count 0,
    // a genuine "no detected risk" signal, not a block.
    mocks.state = makeState('TICKET', {
      ticket: TICKET,
      policySnapshot: {
        ...makeState('TICKET').policySnapshot,
        challengePolicy: TEAM_POLICY.challengePolicy,
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });
    mocks.readDiscovery.mockResolvedValueOnce(null);
    mocks.autoAdvance.mockImplementation((s: SessionState) => ({
      kind: 'advanced',
      state: s,
      evalResult: { kind: 'pending' },
      transitions: [],
    }));

    const { plan } = await import('./plan.js');
    const parsed = JSON.parse(
      String(await plan.execute({ planText: '## Plan\n1. Fix' }, {} as never)),
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.code).not.toBe('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
    expect(mocks.writeStateWithArtifacts).toHaveBeenCalled();
    // Empty scope → no targetPaths metadata is stamped on the obligation.
    const persisted = mocks.writeStateWithArtifacts.mock.calls.at(
      -1,
    )?.[1] as unknown as SessionState;
    const obligation = persisted.reviewAssurance?.obligations.at(-1);
    expect(obligation?.metadata?.targetPaths).toBeUndefined();
  });

  it('initial obligation: discovery risk surfaces floor the challenge scope even without author targetPaths', async () => {
    mocks.state = makeState('TICKET', {
      ticket: TICKET,
      policySnapshot: {
        ...makeState('TICKET').policySnapshot,
        challengePolicy: TEAM_POLICY.challengePolicy,
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });
    mocks.readDiscovery.mockResolvedValueOnce(discoveryWithPaths(['src/db.ts']));
    mocks.autoAdvance.mockImplementation((s: SessionState) => ({
      kind: 'advanced',
      state: s,
      evalResult: { kind: 'pending' },
      transitions: [],
    }));

    const { plan } = await import('./plan.js');
    const parsed = JSON.parse(
      String(await plan.execute({ planText: '## Plan\n1. Fix' }, {} as never)),
    );

    expect(parsed.error).toBeUndefined();
    const persisted = mocks.writeStateWithArtifacts.mock.calls.at(
      -1,
    )?.[1] as unknown as SessionState;
    const obligation = persisted.reviewAssurance?.obligations.at(-1);
    expect(obligation?.metadata?.targetPaths).toEqual(['src/db.ts']);
  });

  it('initial obligation: no challenge obligation when subagent review is disabled (no discovery read)', async () => {
    mocks.state = makeState('TICKET', {
      ticket: TICKET,
      policySnapshot: {
        ...makeState('TICKET').policySnapshot,
        challengePolicy: TEAM_POLICY.challengePolicy,
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      selfReview: { subagentEnabled: false, fallbackToSelf: false, strictEnforcement: false },
    });
    mocks.autoAdvance.mockImplementation((s: SessionState) => ({
      kind: 'advanced',
      state: s,
      evalResult: { kind: 'pending' },
      transitions: [],
    }));

    const { plan } = await import('./plan.js');
    const parsed = JSON.parse(
      String(await plan.execute({ planText: '## Plan\n1. Fix' }, {} as never)),
    );

    expect(parsed.error).toBeUndefined();
    expect(mocks.readDiscovery).not.toHaveBeenCalled();
  });

  it('EDGE: host_task_required + agent submits INVALID reviewFindings → still succeeds (ignored)', async () => {
    // BUG-17: In host_task mode, agent-submitted findings are completely ignored.
    // Even findings with wrong iteration/planVersion don't block because evidence is SSOT.
    mocks.state = planStateWithEvidence('accept');
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

    const { plan } = await import('./plan.js');
    const res = await plan.execute(
      {
        reviewVerdict: 'accept',
        // Agent submits WRONG iteration — would normally be BLOCKED, but BUG-17 ignores
        reviewFindings: makeFindings({ iteration: 999, overallVerdict: 'changes_requested' }),
      },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    // Succeeds because evidence 'accept' matches reviewVerdict 'accept'
    expect(parsed.error).toBeUndefined();
  });

  it('REGRESSION: sdk_allowed + no reviewFindings → BLOCKED (requires agent submission)', async () => {
    // In non-host_task mode, evidence is NOT auto-resolved — agent must submit findings
    mocks.state = planStateWithEvidence('accept');
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'sdk_allowed',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });

    const { plan } = await import('./plan.js');
    const res = await plan.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('HAPPY: sdk_allowed + Claude manual_attested reviewFindings converge without pluginHandshakeAt', async () => {
    process.env.FLOWGUARD_HOST_PLATFORM = 'claude-code';
    const findings = makeStrictFindings(OBLIGATION_ID);
    mocks.state = makeState('PLAN', {
      ticket: TICKET,
      plan: {
        current: {
          body: '## Plan\n1. Fix',
          digest: 'digest-plan',
          sections: [],
          createdAt: now,
          recordDigest: computeRecordDigest({
            contentDigest: 'digest-plan',
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
          }),
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'verified' as const,
        },
        history: [],
        reviewCompletion: 'pending',
        reviewFindings: [],
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-plan',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [
          {
            obligationId: OBLIGATION_ID,
            obligationType: 'plan',
            subjectDigest: 'test-subject-digest',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            maxReviewerOutputRepairAttempts: 1,
            createdAt: now,
            pluginHandshakeAt: null,
            status: 'fulfilled',
            invocationId: INVOCATION_ID,
            blockedCode: null,
            fulfilledAt: now,
            consumedAt: null,
            reviewSubjectScope: {
              kind: 'repository_change',
              paths: ['src/foo.ts'],
              revisions: ['base', 'head'],
            },
          },
        ],
        invocations: [manualAttestedInvocation({ obligationType: 'plan', findings })],
        attempts: [],
        dispatches: [],
      },
    });
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

    const { plan } = await import('./plan.js');
    const res = await plan.execute(
      { reviewVerdict: 'accept', reviewFindings: findings },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBeUndefined();
  });

  it('revision loop: no prior/author targetPaths and empty discovery → next obligation created, never dead-ends', async () => {
    // Parity with architecture Mode B. The plan revision loop previously used the
    // old resolver and hard-blocked with RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE
    // when neither prior nor author targetPaths existed (a plan has no diff). It
    // now derives from discovery (empty here) and creates the next obligation.
    mocks.state = planStateWithEvidence('changes_requested');
    mocks.state = {
      ...mocks.state,
      policySnapshot: {
        ...mocks.state!.policySnapshot,
        challengePolicy: TEAM_POLICY.challengePolicy,
      },
    } as SessionState;
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });
    mocks.autoAdvance.mockImplementation((s: SessionState) => ({
      kind: 'advanced',
      state: s,
      evalResult: { kind: 'pending' },
      transitions: [],
    }));
    mocks.readDiscovery.mockResolvedValueOnce(null);

    const { plan } = await import('./plan.js');
    const parsed = JSON.parse(
      String(
        await plan.execute(
          {
            reviewVerdict: 'changes_requested',
            planText: '## Plan\n1. Fix\n2. Revised',
            claims: [],
          },
          {} as never,
        ),
      ),
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.code).not.toBe('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
    const savedState = mocks.writeStateWithArtifacts.mock.calls.at(
      -1,
    )?.[1] as unknown as SessionState;
    const obligations = savedState.reviewAssurance?.obligations ?? [];
    expect(obligations.length).toBeGreaterThanOrEqual(2);
    expect(obligations.at(-1)?.obligationType).toBe('plan');
    expect(obligations.at(-1)?.metadata?.targetPaths).toBeUndefined();
    // The plan artifact is the review SUBJECT — never the repository diff or
    // discovery risk surfaces (regression: review_finding_out_of_scope on
    // artifact-anchored findings because the scope was repository_change).
    const planScope = obligations.at(-1)?.reviewSubjectScope;
    expect(planScope?.kind).toBe('artifact');
    if (planScope?.kind === 'artifact') {
      expect(planScope.artifact.kind).toBe('plan');
      expect(planScope.artifact.sectionPaths).toEqual([
        [{ headingDepth: 2, siblingIndex: 1, headingText: 'Plan' }],
      ]);
    }
  });

  it('revision loop: unions author targetPaths with discovery risk surfaces on the next obligation', async () => {
    mocks.state = planStateWithEvidence('changes_requested');
    mocks.state = {
      ...mocks.state,
      policySnapshot: {
        ...mocks.state!.policySnapshot,
        challengePolicy: TEAM_POLICY.challengePolicy,
      },
    } as SessionState;
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });
    mocks.autoAdvance.mockImplementation((s: SessionState) => ({
      kind: 'advanced',
      state: s,
      evalResult: { kind: 'pending' },
      transitions: [],
    }));
    mocks.readDiscovery.mockResolvedValueOnce(discoveryWithPaths(['src/db.ts']));

    const { plan } = await import('./plan.js');
    const parsed = JSON.parse(
      String(
        await plan.execute(
          {
            reviewVerdict: 'changes_requested',
            planText: '## Plan\n1. Fix\n2. Revised',
            claims: [],
            targetPaths: ['src/api.ts'],
          },
          {} as never,
        ),
      ),
    );

    expect(parsed.error).toBeUndefined();
    const savedState = mocks.writeStateWithArtifacts.mock.calls.at(
      -1,
    )?.[1] as unknown as SessionState;
    const nextObligation = savedState.reviewAssurance?.obligations.at(-1);
    expect(nextObligation?.metadata?.targetPaths).toEqual(['src/api.ts', 'src/db.ts']);
  });
});
