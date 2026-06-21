/**
 * @module integration/tools/architecture-shared.test
 * @description Tests for architecture-shared helpers — text detection,
 *              submission gate validation, and review instruction construction.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect, vi } from 'vitest';
import {
  hasText,
  validateInitialSubmissionGate,
  buildArchitectureReviewInstruction,
} from './architecture-shared.js';
import type { SessionState, Phase } from '../../state/schema.js';

vi.mock('../review/orchestration-mode.js', () => ({
  resolveRuntimeReviewPlatform: vi.fn(() => 'unknown'),
  resolveReviewOrchestrationMode: vi.fn(() => 'self'),
}));

vi.mock('../review/pending-instruction.js', () => ({
  buildPendingReviewInstruction: vi.fn((_input: unknown) => ({
    next: 'faux-review-instruction',
  })),
}));

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

function archObligation(status: string) {
  return {
    obligationType: 'architecture' as const,
    obligationId: `obl-${status}-1`,
    status: status as 'pending' | 'blocked' | 'fulfilled',
    iteration: 0,
    planVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as NonNullable<SessionState['reviewAssurance']>['obligations'][number];
}

// ─── hasText ──────────────────────────────────────────────────────────────────

describe('hasText', () => {
  it('returns true for non-empty trimmed string', () => {
    expect(hasText('hello')).toBe(true);
    expect(hasText('  hello  ')).toBe(true);
  });

  it('returns false for whitespace-only strings', () => {
    expect(hasText('   ')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasText('')).toBe(false);
  });

  it('returns false for non-strings', () => {
    expect(hasText(42)).toBe(false);
    expect(hasText(null)).toBe(false);
    expect(hasText(undefined)).toBe(false);
  });
});

// ─── validateInitialSubmissionGate ─────────────────────────────────────────────

describe('validateInitialSubmissionGate', () => {
  it('mixed title + verdict => ADR_SUBMISSION_MIXED_INPUTS', () => {
    const result = validateInitialSubmissionGate(
      { title: 'ADR Title', reviewVerdict: 'accept' },
      state('ARCHITECTURE'),
      true,
    );
    expect(result).toContain('ADR_SUBMISSION_MIXED_INPUTS');
  });

  it('not initial submission => null', () => {
    const result = validateInitialSubmissionGate({ title: 'ADR' }, state('ARCHITECTURE'), false);
    expect(result).toBeNull();
  });

  it('no text and wrong phase => null', () => {
    expect(validateInitialSubmissionGate({}, state('READY'), true)).toBeNull();
  });

  it('no selfReview => null', () => {
    expect(
      validateInitialSubmissionGate(
        { title: 'ADR' },
        state('ARCHITECTURE', { selfReview: null }),
        true,
      ),
    ).toBeNull();
  });

  it('3+ blocked architecture obligations => ORCHESTRATION_PERMANENTLY_FAILED', () => {
    const s = state('ARCHITECTURE', {
      selfReview: {} as SessionState['selfReview'],
      reviewAssurance: {
        obligations: [
          archObligation('blocked'),
          archObligation('blocked'),
          archObligation('blocked'),
        ],
      } as SessionState['reviewAssurance'],
    });
    const result = validateInitialSubmissionGate({ title: 'ADR' }, s, true)!;
    expect(result).toContain('ORCHESTRATION_PERMANENTLY_FAILED');
  });
});

// ─── buildArchitectureReviewInstruction ───────────────────────────────────────

describe('buildArchitectureReviewInstruction', () => {
  it('subagentEnabled=false => self-review text prompt', () => {
    const result = buildArchitectureReviewInstruction({
      policy: {
        reviewInvocationPolicy: 'self',
      } as SessionState['policySnapshot'],
      subagentEnabled: false,
      obligation: null,
      iteration: 0,
      planVersion: 1,
      subjectLabel: 'ADR',
    });
    expect(result.next).toContain('Self-review needed');
    expect(result.reviewInvocation).toBeUndefined();
  });

  it('subagentEnabled=true => returns next + reviewInvocation', () => {
    const result = buildArchitectureReviewInstruction({
      policy: {
        reviewInvocationPolicy: 'self',
      } as SessionState['policySnapshot'],
      subagentEnabled: true,
      obligation: null,
      iteration: 0,
      planVersion: 1,
      subjectLabel: 'ADR',
    });
    expect(result.next).toBe('faux-review-instruction');
  });
});
