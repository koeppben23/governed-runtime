/**
 * @module integration/tools/evidence-first-resolution-implement.test
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
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  hashFindings,
} from '../review/assurance.js';

// ═══════════════════════════════════════════════════════════════════════════

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
    formatAutoAdvanceOverflow: vi.fn((overflow: { phase: string; limit: number }) =>
      JSON.stringify({
        error: true,
        code: 'AUTO_ADVANCE_OVERFLOW',
        autoAdvanceOverflow: { phase: overflow.phase, limit: overflow.limit },
      }),
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
  formatAutoAdvanceOverflow: mocks.formatAutoAdvanceOverflow,
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

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
const now = '2026-01-01T00:00:00.000Z';
const originalFlowguardHostPlatform = process.env.FLOWGUARD_HOST_PLATFORM;

// ─── Test Fixtures ──────────────────────────────────────────────────────────

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
    agentType: 'flowguard-reviewer',
    invocationMode: 'manual_attested',
    hostVisible: false,
    promptHash: 'abc',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash: hashFindings(input.findings),
    invokedAt: now,
    fulfilledAt: now,
    consumedByObligationId: null,
    source: 'agent-submitted-attested',
  };
}

function implStateWithEvidence(verdict: 'accept' | 'changes_requested' = 'accept') {
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

// ═══════════════════════════════════════════════════════════════════════════
// Implement — BUG-17 Evidence-First Resolution
// ═══════════════════════════════════════════════════════════════════════════

describe('BUG-17: implement evidence-first resolution', () => {
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

  it('HAPPY: host_task_required + evidence available → succeeds', async () => {
    mocks.state = implStateWithEvidence('accept');
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

    const { review_implementation } = await import('./implement.js');
    const res = await review_implementation.execute({ reviewVerdict: 'accept' }, {} as never);
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

    const { review_implementation } = await import('./implement.js');
    const res = await review_implementation.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('EDGE: host_task_required + agent submits INVALID reviewFindings → still succeeds (ignored)', async () => {
    mocks.state = implStateWithEvidence('accept');
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

    const { review_implementation } = await import('./implement.js');
    const res = await review_implementation.execute(
      {
        reviewVerdict: 'accept',
        // Agent submits WRONG iteration — ignored in host_task mode
        reviewFindings: makeFindings({ iteration: 999, overallVerdict: 'changes_requested' }),
      },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    // Evidence 'accept' matches reviewVerdict 'accept' → succeeds
    expect(parsed.error).toBeUndefined();
  });

  it('BAD: host_task_required + captured findings UNPARSEABLE → HOST_TASK_FINDINGS_UNPARSEABLE (distinct from no-evidence)', async () => {
    const state = implStateWithEvidence('accept');
    // Corrupt the captured findings so ReviewFindingsSchema.safeParse fails.
    // The reviewer DID run and evidence WAS bound — this must NOT degrade to the
    // generic REVIEW_FINDINGS_REQUIRED ("reviewer never ran").
    (
      state.reviewAssurance!.invocations[0] as { capturedRawFindings: unknown }
    ).capturedRawFindings = { overallVerdict: 12345, not: 'a-valid-findings-object' };
    mocks.state = state;
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });

    const { review_implementation } = await import('./implement.js');
    const res = await review_implementation.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('HOST_TASK_FINDINGS_UNPARSEABLE');
  });

  it('REGRESSION: sdk_allowed + no reviewFindings → BLOCKED', async () => {
    mocks.state = implStateWithEvidence('accept');
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'sdk_allowed',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    });

    const { review_implementation } = await import('./implement.js');
    const res = await review_implementation.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('HAPPY: host_task_preferred + Codex manual_attested reviewFindings converge without pluginHandshakeAt', async () => {
    process.env.FLOWGUARD_HOST_PLATFORM = 'codex';
    const findings = makeStrictFindings(OBLIGATION_ID, { iteration: 1 });
    mocks.state = makeState('IMPL_REVIEW', {
      plan: {
        current: { body: '## Plan\n1. Fix', digest: 'digest-plan', sections: [], createdAt: now },
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
            pluginHandshakeAt: null,
            status: 'fulfilled',
            invocationId: INVOCATION_ID,
            blockedCode: null,
            fulfilledAt: now,
            consumedAt: null,
          },
        ],
        invocations: [manualAttestedInvocation({ obligationType: 'implement', findings })],
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      maxSelfReviewIterations: 3,
      reviewInvocationPolicy: 'host_task_preferred',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: true },
    });
    mocks.autoAdvance.mockReturnValue({
      kind: 'advanced',
      state: mocks.state,
      evalResult: { kind: 'pending' },
      transitions: [],
    });

    const { review_implementation } = await import('./implement.js');
    const res = await review_implementation.execute(
      { reviewVerdict: 'accept', reviewFindings: findings },
      {} as never,
    );
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBeUndefined();
  });
});
