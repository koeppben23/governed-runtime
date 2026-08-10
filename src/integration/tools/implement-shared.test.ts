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
  buildImplementRuntime,
  validateImplementSequence,
  normalizeHostFindings,
  type ImplementArgs,
  type ImplementRuntime,
} from './implement-shared.js';
import type { SessionState, Phase } from '../../state/schema.js';
import type { ReviewFindings } from '../../state/evidence.js';

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

function makeReviewFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'reviewer' },
    reviewedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function finding(
  overrides: Partial<ReviewFindings['blockingIssues'][number]> = {},
): ReviewFindings['blockingIssues'][number] {
  const location = { path: 'src/foo.ts', revision: 'head' as const, line: 1 };
  return {
    severity: 'critical',
    category: 'correctness',
    message: 'Issue',
    relation: {
      subjectAnchors: [{ kind: 'repository_location', location }],
      evidenceLocations: [location],
    },
    ...overrides,
  };
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
      implReview: {
        iteration: 1,
        maxIterations: 5,
        prevDigest: null,
        currDigest: 'digest-impl',
        revisionDelta: 'minor',
        verdict: 'changes_requested',
        executedAt: '2026-01-01T00:00:00.000Z',
      },
      implReviewFindings: [
        { iteration: 5 } as unknown as SessionState['implReviewFindings'] extends Array<infer T>
          ? T
          : never,
      ],
    } as Partial<SessionState>);
    expect(nextImplementationReviewIteration(s)).toBe(6);
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
    const result = validateImplementSequence(
      implementArgs({ reviewFindings: {} as unknown as ImplementArgs['reviewFindings'] }),
      state('IMPLEMENTATION'),
    );
    expect(result).toContain('INVALID_IMPLEMENT_TOOL_SEQUENCE');
  });

  it('reviewerUnavailable retry is allowed only at IMPL_REVIEW with implementation evidence', () => {
    const result = validateImplementSequence(
      implementArgs({ reviewerUnavailable: true }),
      state('IMPLEMENTATION'),
    );
    expect(result).toContain('IMPLEMENTATION_EVIDENCE_REQUIRED');
    expect(
      validateImplementSequence(
        implementArgs({ reviewerUnavailable: true }),
        state('IMPL_REVIEW', { implementation: {} } as Partial<SessionState>),
      ),
    ).toBeNull();
  });

  it('verdict without implementation evidence => IMPLEMENTATION_EVIDENCE_REQUIRED (mirrors verdict)', () => {
    const result = validateImplementSequence(
      implementArgs({ reviewVerdict: 'accept' }),
      state('READY'),
    );
    expect(result).toContain('IMPLEMENTATION_EVIDENCE_REQUIRED');
    // #499 anti-confabulation: the block echoes the verdict the caller actually sent.
    expect(result).toContain('accept');
  });

  it('verdict in wrong phase => IMPLEMENT_REVIEW_LOOP_REQUIRED', () => {
    const result = validateImplementSequence(
      implementArgs({ reviewVerdict: 'accept' }),
      state('IMPLEMENTATION', { implementation: {} } as Partial<SessionState>),
    );
    expect(result).toContain('IMPLEMENT_REVIEW_LOOP_REQUIRED');
    expect(result).toContain('flowguard_run_check');
    expect(result).toContain('IMPL_REVIEW');
    expect(result).not.toContain('flowguard_implement');
  });

  it('valid sequence returns null', () => {
    const s = state('IMPL_REVIEW', {
      implementation: {} as unknown as SessionState['implementation'],
    });
    expect(validateImplementSequence(implementArgs({ reviewVerdict: 'accept' }), s)).toBeNull();
  });
});

// ─── Host Finding Identity Normalization ─────────────────────────────────────

describe('normalizeHostFindings', () => {
  it('mints host-assigned findingId on blockingIssues', () => {
    const findings = makeReviewFindings({
      blockingIssues: [finding({ message: 'Missing null check' })],
    });
    const result = normalizeHostFindings(findings);
    expect(result.blockingIssues[0]!.findingId).toBeTruthy();
    expect(result.blockingIssues[0]!.findingId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('mints host-assigned findingId on majorRisks', () => {
    const findings = makeReviewFindings({
      majorRisks: [finding({ severity: 'major', category: 'risk', message: 'Retry untested' })],
    });
    const result = normalizeHostFindings(findings);
    expect(result.majorRisks[0]!.findingId).toBeTruthy();
  });

  it('overwrites reviewer-supplied findingId', () => {
    const findings = makeReviewFindings({
      blockingIssues: [finding({ findingId: 'reviewer-supplied-bad-uuid' })],
    });
    const result = normalizeHostFindings(findings);
    expect(result.blockingIssues[0]!.findingId).not.toBe('reviewer-supplied-bad-uuid');
    expect(result.blockingIssues[0]!.findingId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('assigns unique findingId per finding', () => {
    const findings = makeReviewFindings({
      blockingIssues: [
        finding({ message: 'Issue A' }),
        finding({ severity: 'major', category: 'completeness', message: 'Issue B' }),
      ],
    });
    const result = normalizeHostFindings(findings);
    expect(result.blockingIssues[0]!.findingId).not.toBe(result.blockingIssues[1]!.findingId);
  });

  it('preserves all non-identity finding fields', () => {
    const findings = makeReviewFindings({
      blockingIssues: [finding()],
    });
    const result = normalizeHostFindings(findings);
    expect(result.blockingIssues[0]!.severity).toBe('critical');
    expect(result.blockingIssues[0]!.category).toBe('correctness');
    expect(result.blockingIssues[0]!.message).toBe('Issue');
    expect(result.blockingIssues[0]!.relation.subjectAnchors[0]).toMatchObject({
      kind: 'repository_location',
      location: { path: 'src/foo.ts' },
    });
  });
});
