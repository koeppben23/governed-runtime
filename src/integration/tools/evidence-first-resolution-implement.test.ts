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
import { makeState, TICKET, VALIDATION_PASSED } from '../../fixtures.js';
import { TEAM_POLICY } from '../../config/policy-presets.js';
import type { SessionState } from '../../state/schema.js';
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

vi.mock('../../adapters/git.js', () => ({
  changedFiles: mocks.changedFiles,
}));

vi.mock('../../presentation/phase-labels.js', () => ({
  PHASE_LABELS: { PLAN: 'Plan', PLAN_REVIEW: 'Plan Review' },
}));

vi.mock('../../presentation/next-action-copy.js', () => ({
  buildProductNextAction: vi.fn(() => ({ text: 'next action', commands: [] })),
}));

vi.mock('../../presentation/index.js', () => ({
  PHASE_LABELS: { IMPL_REVIEW: 'Implementation review' },
  buildEvidenceReviewCard: vi.fn(() => 'review card'),
  buildProductNextAction: vi.fn(() => ({ text: 'next action', commands: [] })),
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

function implStateWithEvidence(
  verdict: 'accept' | 'changes_requested' = 'accept',
  blockingIssues: unknown[] = [],
) {
  const rawFindings: Record<string, unknown> = {
    iteration: 1,
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
  return makeState('IMPL_REVIEW', {
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
      reviewFindings: [],
    },
    implementation: {
      changedFiles: ['src/foo.ts'],
      digest: 'digest-impl',
      domainFiles: ['src/foo.ts'],
      executedAt: now,
    },
    // Realistic IMPL_REVIEW state: the phase is only reachable once the active
    // checks passed in IMPL_VALIDATION, so carry that passing evidence bound to
    // the current implementation digest.
    implValidation: VALIDATION_PASSED,
    validationAttempts: [
      {
        attemptId: '00000000-0000-4000-8000-00000000dd01',
        scope: 'implementation' as const,
        implementationDigest: 'digest-impl',
        result: { ...VALIDATION_PASSED[0]!, checkId: 'test', passed: true },
      },
      {
        attemptId: '00000000-0000-4000-8000-00000000dd02',
        scope: 'implementation' as const,
        implementationDigest: 'digest-impl',
        result: { ...VALIDATION_PASSED[1]!, checkId: 'lint', passed: true },
      },
    ],
    selfReview: {
      iteration: 0,
      maxIterations: 3,
      prevDigest: null,
      currDigest: 'digest-impl',
      revisionDelta: 'major',
      verdict: 'changes_requested',
    },
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      attempts: [
        {
          attemptId: OBLIGATION_ID.replace(/^(\w{8})/, 'd0000001'),
          obligationId: OBLIGATION_ID,
          obligationType: 'implement' as const,
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
          obligationType: 'implement',
          subjectDigest: 'test-subject-digest',
          iteration: 1,
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
          obligationType: 'implement',
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

    const { review_implementation } = await import('./implement.js');
    const res = await review_implementation.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));
    expect(parsed.error).toBeUndefined();
  });

  it('F12 REGRESSION: host_task_required + captured accept WITH blocking issue → BLOCKED, phase stays IMPL_REVIEW, no persist', async () => {
    // Exact demo defect path: IMPL_REVIEW → verdict-only accept → would
    // previously land in EVIDENCE_REVIEW. Captured findings are internally
    // self-contradictory (accept + blocking issues) — the tool MUST fail
    // closed at the host-task resolution boundary and MUST NOT advance the
    // phase or persist any converged state.
    mocks.state = implStateWithEvidence('accept', [
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

    const { review_implementation } = await import('./implement.js');
    const res = await review_implementation.execute({ reviewVerdict: 'accept' }, {} as never);
    const parsed = JSON.parse(String(res));

    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');

    // No advance, no persist — the block stops before any state materialization.
    expect(mocks.autoAdvance).not.toHaveBeenCalled();
    expect(mocks.writeStateWithArtifacts).not.toHaveBeenCalled();
    expect(mocks.appendNextAction).not.toHaveBeenCalled();
  });

  it('BAD: host_task_required + no evidence → BLOCKED', async () => {
    const stateNoEvidence = makeState('IMPL_REVIEW', {
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
        reviewFindings: [],
      },
      implementation: {
        changedFiles: ['src/foo.ts'],
        digest: 'digest-impl',
        domainFiles: ['src/foo.ts'],
        executedAt: now,
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
      ...TEAM_POLICY,
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
      ...TEAM_POLICY,
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
        reviewFindings: [],
      },
      implementation: {
        changedFiles: ['src/foo.ts'],
        domainFiles: ['src/foo.ts'],
        digest: 'digest-impl',
        executedAt: now,
      },
      // Realistic IMPL_REVIEW state: active checks passed in IMPL_VALIDATION.
      implValidation: VALIDATION_PASSED,
      validationAttempts: [
        {
          attemptId: '00000000-0000-4000-8000-00000000ee01',
          scope: 'implementation' as const,
          implementationDigest: 'digest-impl',
          result: { ...VALIDATION_PASSED[0]!, checkId: 'test', passed: true },
        },
        {
          attemptId: '00000000-0000-4000-8000-00000000ee02',
          scope: 'implementation' as const,
          implementationDigest: 'digest-impl',
          result: { ...VALIDATION_PASSED[1]!, checkId: 'lint', passed: true },
        },
      ],
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-impl',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [
          {
            obligationId: OBLIGATION_ID,
            obligationType: 'implement',
            subjectDigest: 'test-subject-digest',
            iteration: 1,
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
        invocations: [manualAttestedInvocation({ obligationType: 'implement', findings })],
        attempts: [],
        dispatches: [],
      },
    });
    mocks.requireStateForMutation.mockResolvedValue(mocks.state);
    mocks.resolvePolicyFromState.mockReturnValue({
      ...TEAM_POLICY,
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
