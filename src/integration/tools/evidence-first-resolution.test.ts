/**
 * @module integration/tools/evidence-first-resolution.test
 * @description BUG-17 tests: In host_task_required mode, plugin-captured evidence
 * is SSOT — agent-submitted reviewFindings are IGNORED. SDK path continues to
 * validate agent-submitted findings normally.
 *
 * Tests plan.ts and implement.ts evidence-first patterns.
 * (architecture.ts tests are in architecture-tool.test.ts)
 *
 * @test-policy HAPPY, BAD, EDGE, REGRESSION — all categories present.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeState, TICKET } from '../../__fixtures__.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  hashFindings,
} from '../review-assurance.js';

// ─── Shared Mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  return {
    state: null as unknown,
    isCommandAllowed: vi.fn(() => true),
    autoAdvance: vi.fn(),
    resolveWorkspacePaths: vi.fn(async () => ({ sessDir: '/tmp/session' })),
    requireStateForMutation: vi.fn(async () => makeState('TICKET')),
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
    extractSections: vi.fn(() => []),
    changedFiles: vi.fn(async () => ['src/foo.ts']),
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
  extractSections: mocks.extractSections,
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

vi.mock('../../adapters/git.js', () => ({
  changedFiles: mocks.changedFiles,
}));

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

// ─── Constants & Helpers ─────────────────────────────────────────────────────

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
const now = '2026-01-01T00:00:00.000Z';

function makeFindings(
  overrides: Partial<{
    iteration: number;
    planVersion: number;
    overallVerdict: 'approve' | 'changes_requested';
  }> = {},
) {
  return {
    iteration: overrides.iteration ?? 0,
    planVersion: overrides.planVersion ?? 1,
    reviewMode: 'subagent' as const,
    overallVerdict: overrides.overallVerdict ?? 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_child' },
    reviewedAt: now,
  };
}

function planStateWithEvidence(verdict: 'approve' | 'changes_requested' = 'approve') {
  const rawFindings: Record<string, unknown> = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues: [],
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
      },
      history: [],
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
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
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
          obligationType: 'plan',
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

function implStateWithEvidence(verdict: 'approve' | 'changes_requested' = 'approve') {
  const rawFindings: Record<string, unknown> = {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_child' },
    reviewedAt: now,
  };
  return makeState('IMPL_REVIEW', {
    plan: {
      current: {
        body: '## Plan\n1. Fix',
        digest: 'digest-plan',
        sections: [],
        createdAt: now,
      },
      history: [],
      reviewFindings: [],
    },
    implementation: {
      changedFiles: ['src/foo.ts'],
      digest: 'digest-impl',
      createdAt: now,
    },
    selfReview: {
      iteration: 0,
      maxIterations: 3,
      prevDigest: null,
      currDigest: 'digest-impl',
      revisionDelta: 'major',
      verdict: 'changes_requested',
    },
    reviewAssurance: {
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'implement',
          iteration: 1,
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
          obligationType: 'implement',
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

// ═══════════════════════════════════════════════════════════════════════════════
// Plan — BUG-17 Evidence-First Resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUG-17: plan evidence-first resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('HAPPY: host_task_required + evidence available → succeeds (no reviewFindings needed)', async () => {
    mocks.state = planStateWithEvidence('approve');
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

    const { plan } = await import('./plan.js');
    const res = await plan.execute({ selfReviewVerdict: 'approve' }, {} as never);
    const parsed = JSON.parse(String(res));
    // Evidence-resolved findings used — no BLOCKED
    expect(parsed.error).toBeUndefined();
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
        },
        history: [],
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

    const { plan } = await import('./plan.js');
    const res = await plan.execute({ selfReviewVerdict: 'approve' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('EDGE: host_task_required + agent submits INVALID reviewFindings → still succeeds (ignored)', async () => {
    // BUG-17: In host_task mode, agent-submitted findings are completely ignored.
    // Even findings with wrong iteration/planVersion don't block because evidence is SSOT.
    mocks.state = planStateWithEvidence('approve');
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

    const { plan } = await import('./plan.js');
    const res = await plan.execute(
      {
        selfReviewVerdict: 'approve',
        // Agent submits WRONG iteration — would normally be BLOCKED, but BUG-17 ignores
        reviewFindings: makeFindings({ iteration: 999, overallVerdict: 'changes_requested' }),
      },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    // Succeeds because evidence 'approve' matches selfReviewVerdict 'approve'
    expect(parsed.error).toBeUndefined();
  });

  it('REGRESSION: sdk_allowed + no reviewFindings → BLOCKED (requires agent submission)', async () => {
    // In non-host_task mode, evidence is NOT auto-resolved — agent must submit findings
    mocks.state = planStateWithEvidence('approve');
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'sdk_allowed',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });

    const { plan } = await import('./plan.js');
    const res = await plan.execute({ selfReviewVerdict: 'approve' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Implement — BUG-17 Evidence-First Resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUG-17: implement evidence-first resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('HAPPY: host_task_required + evidence available → succeeds', async () => {
    mocks.state = implStateWithEvidence('approve');
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

    const { implement } = await import('./implement.js');
    const res = await implement.execute({ reviewVerdict: 'approve' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBeUndefined();
  });

  it('BAD: host_task_required + no evidence → BLOCKED', async () => {
    const stateNoEvidence = makeState('IMPL_REVIEW', {
      plan: {
        current: {
          body: '## Plan\n1. Fix',
          digest: 'digest-plan',
          sections: [],
          createdAt: now,
        },
        history: [],
        reviewFindings: [],
      },
      implementation: {
        changedFiles: ['src/foo.ts'],
        digest: 'digest-impl',
        createdAt: now,
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-impl',
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

    const { implement } = await import('./implement.js');
    const res = await implement.execute({ reviewVerdict: 'approve' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('EDGE: host_task_required + agent submits INVALID reviewFindings → still succeeds (ignored)', async () => {
    mocks.state = implStateWithEvidence('approve');
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

    const { implement } = await import('./implement.js');
    const res = await implement.execute(
      {
        reviewVerdict: 'approve',
        // Agent submits WRONG iteration — ignored in host_task mode
        reviewFindings: makeFindings({ iteration: 999, overallVerdict: 'changes_requested' }),
      },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    // Evidence 'approve' matches reviewVerdict 'approve' → succeeds
    expect(parsed.error).toBeUndefined();
  });

  it('REGRESSION: sdk_allowed + no reviewFindings → BLOCKED', async () => {
    mocks.state = implStateWithEvidence('approve');
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'sdk_allowed',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });

    const { implement } = await import('./implement.js');
    const res = await implement.execute({ reviewVerdict: 'approve' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });
});

// =============================================================================
// BUG-19: reviewerUnavailable fallback in host_task_required mode
// =============================================================================

describe('BUG-19: reviewerUnavailable self-review fallback', () => {
  /**
   * State with a pending obligation but NO invocation evidence (reviewer
   * was never successfully invoked). resolveHostTaskFindings returns null.
   */
  function planStateNoEvidence() {
    return makeState('PLAN', {
      ticket: TICKET,
      plan: {
        current: {
          body: '## Plan\n1. Fix the bug',
          digest: 'digest-plan',
          sections: [],
          createdAt: now,
        },
        history: [],
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
      policySnapshot: {
        mode: 'team',
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      },
      reviewAssurance: {
        obligations: [
          {
            obligationId: OBLIGATION_ID,
            obligationType: 'plan',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            createdAt: now,
            pluginHandshakeAt: now,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
          },
        ],
        invocations: [], // NO evidence — reviewer failed to be invoked
      },
    });
  }

  function implStateNoEvidence() {
    return makeState('IMPL_REVIEW', {
      plan: {
        current: { body: '## Plan', digest: 'digest-plan', sections: [], createdAt: now },
        history: [],
        reviewFindings: [],
      },
      implementation: { changedFiles: ['src/foo.ts'], digest: 'digest-impl', createdAt: now },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-impl',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
      policySnapshot: {
        mode: 'team',
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      },
      reviewAssurance: {
        obligations: [
          {
            obligationId: OBLIGATION_ID,
            obligationType: 'implement',
            iteration: 1,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            createdAt: now,
            pluginHandshakeAt: now,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
          },
        ],
        invocations: [],
      },
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('HAPPY: plan accepts reviewerUnavailable=true in non-strict host_task_required mode', async () => {
    const state = planStateNoEvidence();
    mocks.requireStateForMutation.mockResolvedValue(state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });
    mocks.autoAdvance.mockReturnValue({
      state: { ...state, phase: 'PLAN_REVIEW' },
      evalResult: { kind: 'pending' },
      transitions: [],
    });

    const { plan } = await import('./plan.js');
    const res = await plan.execute(
      { selfReviewVerdict: 'approve', reviewerUnavailable: true },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBeUndefined();
  });

  it('HAPPY: implement accepts reviewerUnavailable=true in non-strict host_task_required mode', async () => {
    const state = implStateNoEvidence();
    mocks.requireStateForMutation.mockResolvedValue(state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });
    mocks.autoAdvance.mockReturnValue({
      state: { ...state, phase: 'EVIDENCE_REVIEW' },
      evalResult: { kind: 'pending' },
      transitions: [],
    });

    const { implement } = await import('./implement.js');
    const res = await implement.execute(
      { reviewVerdict: 'approve', reviewerUnavailable: true },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBeUndefined();
  });

  it('BAD: plan blocks reviewerUnavailable=true when strictEnforcement is true', async () => {
    const state = planStateNoEvidence();
    mocks.requireStateForMutation.mockResolvedValue(state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: true },
    });

    const { plan } = await import('./plan.js');
    const res = await plan.execute(
      { selfReviewVerdict: 'approve', reviewerUnavailable: true },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEWER_UNAVAILABLE_STRICT');
  });

  it('EDGE: reviewerUnavailable fallback creates findings with reviewMode "self"', async () => {
    const state = planStateNoEvidence();
    mocks.requireStateForMutation.mockResolvedValue(state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });

    let persistedState: unknown = null;
    mocks.writeStateWithArtifacts.mockImplementation(async (_dir: string, s: unknown) => {
      persistedState = s;
    });
    mocks.autoAdvance.mockImplementation((s: unknown) => ({
      state: s,
      evalResult: { kind: 'pending' },
      transitions: [],
    }));

    const { plan } = await import('./plan.js');
    await plan.execute({ selfReviewVerdict: 'approve', reviewerUnavailable: true }, {} as never);

    const ps = persistedState as { plan?: { reviewFindings?: Array<{ reviewMode: string }> } };
    expect(ps?.plan?.reviewFindings).toHaveLength(1);
    expect(ps!.plan!.reviewFindings![0].reviewMode).toBe('self');
  });

  it('EDGE: reviewerUnavailable without evidence still blocks when strictEnforcement (implement)', async () => {
    const state = implStateNoEvidence();
    mocks.requireStateForMutation.mockResolvedValue(state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: true },
    });

    const { implement } = await import('./implement.js');
    const res = await implement.execute(
      { reviewVerdict: 'approve', reviewerUnavailable: true },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEWER_UNAVAILABLE_STRICT');
  });

  it('REGRESSION: reviewerUnavailable=false does NOT trigger fallback (still BLOCKED)', async () => {
    const state = planStateNoEvidence();
    mocks.requireStateForMutation.mockResolvedValue(state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });

    const { plan } = await import('./plan.js');
    const res = await plan.execute(
      { selfReviewVerdict: 'approve', reviewerUnavailable: false },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });
});
