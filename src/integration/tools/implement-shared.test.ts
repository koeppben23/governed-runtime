/**
 * @module integration/tools/implement-shared.test
 * @description Tests for implement-shared helpers — iteration calculation,
 *              args classification, runtime construction, and sequence validation.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect } from 'vitest';
import {
  nextImplementationReviewIteration,
  classifyImplementArgs,
  buildImplementRuntime,
  validateImplementSequence,
  type ImplementArgs,
  type ImplementFlags,
  type ImplementRuntime,
} from './implement-shared.js';
import type { SessionState, Phase } from '../../state/schema.js';

// ─── Minimal Fixtures ─────────────────────────────────────────────────────────

function state(phase: Phase, overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: '00000000-0000-4000-8000-000000000001' as SessionState['id'],
    schemaVersion: 'v1',
    phase,
    binding: {
      sessionId: '00000000-0000-4000-8000-000000000002',
      worktree: '/tmp/repo',
      fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
      resolvedAt: '2026-01-01T00:00:00.000Z',
    },
    ticket: null,
    architecture: null,
    plan: null,
    selfReview: null,
    validation: [],
    implementation: null,
    reducedCeremony: null,
    implReview: null,
    reviewDecision: null,
    reviewReportPath: null,
    nextAdrNumber: 1,
    activeProfile: null,
    activeChecks: [],
    policySnapshot: {
      mode: 'team',
      hash: 'policy-hash',
      resolvedAt: '2026-01-01T00:00:00.000Z',
      requestedMode: 'team',
      effectiveGateBehavior: 'human_gated',
      requireHumanGates: true,
      maxSelfReviewIterations: 3,
      maxImplReviewIterations: 5,
      allowSelfApproval: false,
    },
    initiatedBy: 'initiator-1',
    initiatedByIdentity: null,
    transition: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as SessionState;
}

function implementArgs(overrides: Partial<ImplementArgs> = {}): ImplementArgs {
  return { ...overrides };
}

function toolContext() {
  return { sessionId: 'sess-1', agentId: 'agent-1' } as unknown as ImplementRuntime['context'];
}

function flowGuardPolicy(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'team',
    requireHumanGates: true,
    maxSelfReviewIterations: 3,
    maxImplReviewIterations: 5,
    allowSelfApproval: false,
    ...overrides,
    selfReview: {
      subagentEnabled: false,
      fallbackToSelf: false,
      strictEnforcement: false,
      ...((overrides.selfReview as Record<string, unknown>) ?? {}),
    },
  } as unknown as ImplementRuntime['policy'];
}

// ─── nextImplementationReviewIteration ────────────────────────────────────────

describe('nextImplementationReviewIteration', () => {
  it('returns 1 when no implReview or implReviewFindings exist', () => {
    expect(nextImplementationReviewIteration(state('IMPLEMENTATION'))).toBe(1);
  });

  it('returns implReview.iteration + 1 when present', () => {
    expect(
      nextImplementationReviewIteration(
        state('IMPL_REVIEW', { implReview: { iteration: 2 } } as Partial<SessionState>),
      ),
    ).toBe(3);
  });

  it('returns max(findings iteration) + 1 when findings exceed implReview', () => {
    const s = state('IMPL_REVIEW', {
      implReview: { iteration: 1 },
      implReviewFindings: [
        { iteration: 5 } as unknown as SessionState['implReviewFindings'] extends Array<infer T>
          ? T
          : never,
      ],
    } as Partial<SessionState>);
    expect(nextImplementationReviewIteration(s)).toBe(6);
  });
});

// ─── classifyImplementArgs ────────────────────────────────────────────────────

describe('classifyImplementArgs', () => {
  it('empty args => isRecordImpl true, no verdict or findings', () => {
    const flags = classifyImplementArgs(implementArgs());
    expect(flags).toEqual<ImplementFlags>({
      hasVerdict: false,
      hasFindings: false,
      isRecordImpl: true,
    });
  });

  it('reviewVerdict set => hasVerdict true, isRecordImpl false', () => {
    const flags = classifyImplementArgs(implementArgs({ reviewVerdict: 'accept' }));
    expect(flags.hasVerdict).toBe(true);
    expect(flags.isRecordImpl).toBe(false);
  });

  it('reviewFindings provided => hasFindings true', () => {
    const flags = classifyImplementArgs(
      implementArgs({ reviewFindings: {} as unknown as ImplementArgs['reviewFindings'] }),
    );
    expect(flags.hasFindings).toBe(true);
  });

  it('both verdict and findings => both flags true', () => {
    const flags = classifyImplementArgs(
      implementArgs({
        reviewVerdict: 'changes_requested',
        reviewFindings: {} as unknown as ImplementArgs['reviewFindings'],
      }),
    );
    expect(flags.hasVerdict).toBe(true);
    expect(flags.hasFindings).toBe(true);
    expect(flags.isRecordImpl).toBe(false);
  });
});

// ─── buildImplementRuntime ────────────────────────────────────────────────────

describe('buildImplementRuntime', () => {
  it('derives maxImplReviewIterations from policy', () => {
    const rt = buildImplementRuntime({
      args: implementArgs(),
      context: toolContext(),
      worktree: '/tmp/repo',
      sessDir: '/tmp/sess',
      state: state('IMPLEMENTATION'),
      policy: flowGuardPolicy({ maxImplReviewIterations: 7 }),
      ctx: {} as unknown as ImplementRuntime['ctx'],
    });
    expect(rt.maxImplReviewIterations).toBe(7);
  });

  it('defaults subagent fields to false when selfReview is absent', () => {
    const rt = buildImplementRuntime({
      args: implementArgs(),
      context: toolContext(),
      worktree: '/tmp/repo',
      sessDir: '/tmp/sess',
      state: state('IMPLEMENTATION'),
      policy: flowGuardPolicy(),
      ctx: {} as unknown as ImplementRuntime['ctx'],
    });
    expect(rt.subagentEnabled).toBe(false);
    expect(rt.fallbackToSelf).toBe(false);
    expect(rt.strictEnforcement).toBe(false);
  });

  it('passes through selfReview config values', () => {
    const rt = buildImplementRuntime({
      args: implementArgs(),
      context: toolContext(),
      worktree: '/tmp/repo',
      sessDir: '/tmp/sess',
      state: state('IMPLEMENTATION'),
      policy: flowGuardPolicy({
        selfReview: { subagentEnabled: true, fallbackToSelf: true, strictEnforcement: true },
      }),
      ctx: {} as unknown as ImplementRuntime['ctx'],
    });
    expect(rt.subagentEnabled).toBe(true);
    expect(rt.fallbackToSelf).toBe(true);
    expect(rt.strictEnforcement).toBe(true);
  });
});

// ─── validateImplementSequence ────────────────────────────────────────────────

describe('validateImplementSequence', () => {
  it('findings without verdict => INVALID_IMPLEMENT_TOOL_SEQUENCE', () => {
    const result = validateImplementSequence(implementArgs(), state('IMPLEMENTATION'), false, true);
    expect(result).toContain('INVALID_IMPLEMENT_TOOL_SEQUENCE');
  });

  it('verdict without implementation evidence => IMPLEMENTATION_EVIDENCE_REQUIRED', () => {
    const result = validateImplementSequence(
      implementArgs({ reviewVerdict: 'accept' }),
      state('READY'),
      true,
      false,
    );
    expect(result).toContain('IMPLEMENTATION_EVIDENCE_REQUIRED');
  });

  it('verdict in wrong phase => IMPLEMENT_REVIEW_LOOP_REQUIRED', () => {
    const result = validateImplementSequence(
      implementArgs({ reviewVerdict: 'accept' }),
      state('IMPLEMENTATION', { implementation: {} } as Partial<SessionState>),
      true,
      false,
    );
    expect(result).toContain('IMPLEMENT_REVIEW_LOOP_REQUIRED');
  });

  it('valid sequence returns null', () => {
    const s = state('IMPL_REVIEW', {
      implementation: {} as unknown as SessionState['implementation'],
    });
    expect(
      validateImplementSequence(implementArgs({ reviewVerdict: 'accept' }), s, true, false),
    ).toBeNull();
  });
});
