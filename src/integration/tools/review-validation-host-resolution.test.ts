import { describe, expect, it } from 'vitest';
import { assuranceWith as fixtureAssuranceWith } from '../../fixtures.js';
import { resolveHostTaskEffectiveFindings } from './review-validation.js';
import type { ReviewInvocationEvidence, ReviewObligation } from '../../state/evidence-review.js';
import type { ReviewAssuranceState } from '../../state/evidence-review.js';
import {
  makeHostTaskInvocation,
  makeReviewObligation,
  RV_INVOCATION_ID,
  RV_OBLIGATION_ID,
} from './review-validation-test-helpers.js';
import { hashFindings } from '../review/assurance.js';

const OBLIGATION_ID = RV_OBLIGATION_ID;
const INVOCATION_ID = RV_INVOCATION_ID;
const now = new Date().toISOString();

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

const assuranceWith = (
  obligation: ReviewObligation,
  invocations: ReviewInvocationEvidence[],
): ReviewAssuranceState => fixtureAssuranceWith({ obligation, invocations });

function ctx(
  overrides: Partial<Parameters<typeof resolveHostTaskEffectiveFindings>[0]> = {},
): Parameters<typeof resolveHostTaskEffectiveFindings>[0] {
  const obligation = makeReviewObligation();
  return {
    pendingObligation: obligation,
    expected: { obligationType: 'plan' as const, iteration: 0, planVersion: 1 },
    policy: {
      reviewInvocationPolicy: 'host_task_required' as const,
      strictEnforcement: true,
      subagentEnabled: true,
      fallbackToSelf: false,
    },
    input: {},
    state: {
      assurance: assuranceWith(obligation, [makeHostTaskInvocation(validRawFindings)]),
      sessionId: 'ses_parent',
      unresolvedImplementationChallengeIds: [],
      unaddressedPriorFailIds: [],
      allowedChallengeEvidenceRefs: [],
      previouslyUsedChallengeIds: [],
    },
    ...overrides,
  };
}

function parsed(blocked: unknown): Record<string, unknown> {
  return JSON.parse(blocked as string) as Record<string, unknown>;
}

function codeOf(blocked: unknown): string {
  return parsed(blocked).code as string;
}

function messageOf(blocked: unknown): string {
  return parsed(blocked).message as string;
}

describe('resolveHostTaskEffectiveFindings', () => {
  it('resolves effective findings and the evidence invocation id', () => {
    const result = resolveHostTaskEffectiveFindings(ctx());
    expect(result.blocked).toBeUndefined();
    expect(result.effectiveFindings?.overallVerdict).toBe('accept');
    expect(result.evidenceInvocationId).toBe(INVOCATION_ID);
  });

  it('maps rejected host-task findings through the acceptance rejection formatter', () => {
    const obligation = makeReviewObligation({ status: 'consumed' });
    const result = resolveHostTaskEffectiveFindings(
      ctx({
        pendingObligation: obligation,
        state: {
          sessionId: 'ses_parent',
          assurance: assuranceWith(obligation, [makeHostTaskInvocation(validRawFindings)]),
        },
      }),
    );
    expect(result.blocked).toBeDefined();
    expect(codeOf(result.blocked)).toBe('SUBAGENT_EVIDENCE_REUSED');
    expect(messageOf(result.blocked)).toContain('consumed');
  });

  it('maps unparseable captured findings to HOST_TASK_FINDINGS_UNPARSEABLE', () => {
    const obligation = makeReviewObligation();
    const result = resolveHostTaskEffectiveFindings(
      ctx({
        state: {
          sessionId: 'ses_parent',
          assurance: assuranceWith(obligation, [
            makeHostTaskInvocation(validRawFindings, {
              capturedRawFindings: { overallVerdict: 'accept' },
            }),
          ]),
        },
      }),
    );
    expect(codeOf(result.blocked)).toBe('HOST_TASK_FINDINGS_UNPARSEABLE');
    expect(messageOf(result.blocked)).toContain('could not be parsed as valid ReviewFindings');
  });

  it('maps incoherent captured findings to their structured block code', () => {
    const obligation = makeReviewObligation();
    const incoherent = {
      ...validRawFindings,
      blockingIssues: [
        {
          severity: 'major',
          category: 'correctness',
          message: 'contradicts accept',
        },
      ],
    };
    const result = resolveHostTaskEffectiveFindings(
      ctx({
        state: {
          sessionId: 'ses_parent',
          assurance: assuranceWith(obligation, [makeHostTaskInvocation(incoherent)]),
        },
      }),
    );
    expect(result.blocked).toBeDefined();
    expect(JSON.parse(result.blocked as string).code).toBeDefined();
  });

  it('maps attempt lineage failures to REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE', () => {
    const obligation = makeReviewObligation();
    const incoherent = {
      ...validRawFindings,
      blockingIssues: [
        {
          severity: 'major',
          category: 'correctness',
          message: 'stale',
          relation: {
            subjectAnchors: [
              {
                kind: 'repository_location',
                location: { path: 'src/foo.ts', revision: 'head', line: 10 },
              },
            ],
            evidenceLocations: [{ path: 'src/foo.ts', revision: 'head', line: 10 }],
          },
        },
      ],
    };
    const invocation = makeHostTaskInvocation(incoherent);
    delete (invocation as Record<string, unknown>).attemptId;
    const result = resolveHostTaskEffectiveFindings(
      ctx({
        state: {
          sessionId: 'ses_parent',
          assurance: assuranceWith(obligation, [invocation]),
        },
      }),
    );
    expect(codeOf(result.blocked)).toBe('REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE');
    expect(messageOf(result.blocked)).toContain(INVOCATION_ID);
    expect(messageOf(result.blocked)).toContain(OBLIGATION_ID);
  });

  it('flags reviewerUnavailable as misuse when the reviewer was already spawned', () => {
    const obligation = makeReviewObligation();
    const result = resolveHostTaskEffectiveFindings(
      ctx({
        input: { reviewerUnavailable: true },
        state: {
          sessionId: 'ses_parent',
          // Invocation exists (reviewer spawned) but carries no captured
          // findings, so resolution falls through to the misuse check.
          assurance: assuranceWith(obligation, [
            makeHostTaskInvocation(validRawFindings, { capturedRawFindings: undefined }),
          ]),
        },
      }),
    );
    expect(codeOf(result.blocked)).toBe('INVALID_REVIEW_TOOL_SEQUENCE');
    expect(messageOf(result.blocked)).toContain(OBLIGATION_ID);
    expect(messageOf(result.blocked)).toContain(
      'reviewerUnavailable submitted but host_subagent_task invocations already exist',
    );
  });

  it('blocks strict when reviewerUnavailable arrives without any reviewer invocation', () => {
    const obligation = makeReviewObligation();
    const result = resolveHostTaskEffectiveFindings(
      ctx({
        input: { reviewerUnavailable: true },
        state: {
          sessionId: 'ses_parent',
          assurance: assuranceWith(obligation, []),
        },
      }),
    );
    expect(codeOf(result.blocked)).toBe('REVIEWER_UNAVAILABLE_STRICT');
    expect(messageOf(result.blocked)).toContain(
      'reviewer unavailable; independent ReviewFindings remain required',
    );
  });

  it('ignores submitted reviewFindings in host-task mode and still resolves evidence', () => {
    const result = resolveHostTaskEffectiveFindings(
      ctx({ input: { reviewFindings: validRawFindings } }),
    );
    expect(result.blocked).toBeUndefined();
    expect(result.evidenceInvocationId).toBe(INVOCATION_ID);
  });
});
