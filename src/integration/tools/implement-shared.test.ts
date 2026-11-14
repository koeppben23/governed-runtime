/**
 * @module integration/tools/implement-shared.test
 * @description Tests for implement-shared helpers — iteration calculation,
 *              args classification, runtime construction, and sequence validation.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildImplementRuntime,
  validateImplementSequence,
  type ImplementArgs,
  type ImplementRuntime,
} from './implementation/implement-shared.js';
import { nextImplementationReviewIteration } from './implementation-review-activation.js';
import type { SessionState, Phase } from '../../state/schema.js';
import type { ReviewFindings } from '../../state/evidence.js';

// ─── Minimal Fixtures ─────────────────────────────────────────────────────────

function state(phase: Phase, overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: '00000000-0000-4000-8000-000000000001',
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
    reviewCycles: { plan: 1, architecture: 1, implementation: 1 },
    reviewDecision: null,
    reviewReportPath: null,
    implReviewFindings: [],
    peerReviewFindings: [],
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
      reviewBudget: { plan: 3, architecture: 3, implementation: 5 },
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
    reviewBudget: { plan: 3, architecture: 3, implementation: 5 },
    allowSelfApproval: false,
    ...overrides,
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
      implReview: {
        iteration: 1,
        reviewCycle: 1,
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
    });
    expect(nextImplementationReviewIteration(s)).toBe(6);
  });
});

// ─── buildImplementRuntime ────────────────────────────────────────────────────

describe('buildImplementRuntime', () => {
  it('derives the implementation review budget from policy', () => {
    const rt = buildImplementRuntime({
      args: implementArgs(),
      context: toolContext(),
      worktree: '/tmp/repo',
      sessDir: '/tmp/sess',
      state: state('IMPLEMENTATION'),
      policy: flowGuardPolicy({ reviewBudget: { plan: 3, architecture: 3, implementation: 7 } }),
      ctx: {} as unknown as ImplementRuntime['ctx'],
    });
    expect(rt.maxImplementationReviewIterations).toBe(7);
  });
});

// ─── validateImplementSequence ────────────────────────────────────────────────

describe('validateImplementSequence', () => {
  it('a stray reviewFindings key is not a verdict shape (rejected at the schema boundary)', () => {
    // Findings are never part of the tool args: the strict published schema
    // rejects unknown reviewFindings keys; the runtime classifier sees only
    // verdict/unavailable, so a findings-only call is an initial submission.
    const result = validateImplementSequence(
      {
        ...implementArgs(),
        reviewFindings: {},
      } as unknown as ImplementArgs,
      state('IMPLEMENTATION'),
    );
    expect(result).toBeNull();
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

// ─── Mint Gate (scope↔revision-authority coherence) ──────────────────────────

import { vi } from 'vitest';

vi.mock('../../rails/repository-authority.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../rails/repository-authority.js')>();
  return {
    ...original,
    freezeCandidatePairAuthority: vi.fn(),
  };
});

vi.mock('../review/context/discovery-attempt-context.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../review/context/discovery-attempt-context.js')>();
  return {
    ...original,
    resolveAttemptDiscoveryOrBlock: vi.fn(),
  };
});

import { freezeCandidatePairAuthority } from '../../rails/repository-authority.js';
import { resolveAttemptDiscoveryOrBlock } from '../review/context/discovery-attempt-context.js';
import { activateImplementationReviewObligation } from './implementation-review-activation.js';

const CANDIDATE_PAIR = {
  kind: 'candidate_pair' as const,
  base: {
    kind: 'commit' as const,
    repositoryIdentity: { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
    objectSha: 'd'.repeat(40),
  },
  head: {
    kind: 'tree' as const,
    repositoryIdentity: { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
    objectSha: 'c'.repeat(40),
  },
};

function implReviewState(): SessionState {
  return state('IMPL_REVIEW', {
    ticket: {
      text: 'Test',
      source: 'user',
      digest: 'ticket-digest',
      createdAt: '2026-01-01T00:00:00.000Z',
      riskDeclaration: { kind: 'absent' },
    },
    implementation: {
      implementationId: '00000000-0000-4000-8000-0000000000aa',
      changedFiles: ['src/test.ts'],
      domainFiles: ['src/test.ts'],
      digest: 'impl-digest',
      executedAt: '2026-01-01T00:00:00.000Z',
    },
    validationAttempts: [],
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v7',
      obligations: [],
      invocations: [],
      attempts: [],
      dispatches: [],
    },
  });
}

describe('activateImplementationReviewObligation — implementation subject model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('HAPPY: mints an implementation-scoped obligation whose digest equals the subject digest (governed mint with Discovery context)', async () => {
    vi.mocked(freezeCandidatePairAuthority).mockResolvedValue(CANDIDATE_PAIR);
    vi.mocked(resolveAttemptDiscoveryOrBlock).mockResolvedValue({
      kind: 'ok',
      context: {
        kind: 'repository',
        snapshot: {
          observedAt: '2026-01-01T00:00:00.000Z',
          discoveryDigest: null,
          workspaceFingerprint: null,
          health: {
            status: 'available',
            healthy: true,
            failedCollectorNames: [],
            hasBudgetExhaustion: false,
            ageWarning: null,
            notVerified: [],
          },
          drift: {
            status: 'not_assessed',
            drifted: false,
            currentDigest: null,
            persistedDigest: null,
            changedContributorNames: [],
            notVerified: [],
          },
          detectedStack: null,
          verificationCandidates: [],
          riskSurfaces: [],
          warnings: [],
          notVerified: [],
        },
      },
    });

    const input = implReviewState();
    const result = await activateImplementationReviewObligation(input, {
      iteration: 1,
      planVersion: 1,
      now: '2026-01-01T00:00:00.000Z',
      worktree: '/tmp/repo',
    });

    expect(result.blocked).toBeUndefined();
    expect(result.obligation).not.toBeNull();
    // Exact subject identity: implementation scope, digest == subjectDigest.
    expect(result.obligation!.reviewSubjectScope).toEqual({
      kind: 'implementation',
      implementationDigest: 'impl-digest',
    });
    expect(result.obligation!.subjectDigest).toBe('impl-digest');
    // Repository evidence authority stays optional and separate (candidate pair present → governed attempt).
    expect(result.obligation!.repositoryRevisionProvenance).toMatchObject({
      kind: 'available',
      baseSha: 'd'.repeat(40),
      headSha: 'c'.repeat(40),
    });
    expect(result.state.reviewAssurance?.obligations).toHaveLength(1);
    expect(result.state.reviewAssurance?.attempts).toHaveLength(1);
    expect(result.state.reviewAssurance?.attempts[0]?.repositoryDiscovery.kind).toBe('repository');
  });

  it('HAPPY: mints the obligation WITHOUT repository authority — reviewability is digest-bound, evidence authority is optional', async () => {
    vi.mocked(freezeCandidatePairAuthority).mockResolvedValue(undefined);
    vi.mocked(resolveAttemptDiscoveryOrBlock).mockResolvedValue({
      kind: 'ok',
      context: { kind: 'not_applicable' },
    });

    const input = implReviewState();
    const result = await activateImplementationReviewObligation(input, {
      iteration: 1,
      planVersion: 1,
      now: '2026-01-01T00:00:00.000Z',
      worktree: '/tmp/repo',
    });

    expect(result.blocked).toBeUndefined();
    expect(result.obligation).not.toBeNull();
    expect(result.obligation!.reviewSubjectScope).toEqual({
      kind: 'implementation',
      implementationDigest: 'impl-digest',
    });
    // No frozen authority ⇒ evidence degraded, NOT a mint block.
    expect(result.obligation!.repositoryRevisionProvenance).toMatchObject({
      kind: 'unavailable',
    });
    expect(result.state.reviewAssurance?.attempts[0]?.repositoryDiscovery.kind).toBe(
      'not_applicable',
    );
  });

  it('BAD: refuses to mint when the repository Discovery basis cannot be materialized (zero mutation)', async () => {
    vi.mocked(freezeCandidatePairAuthority).mockResolvedValue(CANDIDATE_PAIR);
    vi.mocked(resolveAttemptDiscoveryOrBlock).mockResolvedValue({
      kind: 'blocked',
      reason: 'persisted Discovery basis is unavailable for this repository review',
    });

    const input = implReviewState();
    const result = await activateImplementationReviewObligation(input, {
      iteration: 1,
      planVersion: 1,
      now: '2026-01-01T00:00:00.000Z',
      worktree: '/tmp/repo',
    });

    expect(result.obligation).toBeNull();
    expect(result.blocked).toEqual({
      code: 'REVIEWER_CONTEXT_UNAVAILABLE',
      reason: 'persisted Discovery basis is unavailable for this repository review',
    });
    expect(result.state).toEqual(input);
  });
});
