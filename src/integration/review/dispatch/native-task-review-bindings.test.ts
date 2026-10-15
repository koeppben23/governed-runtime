/**
 * @module integration/review/native-task-review-bindings.test
 * @description Capture-boundary contract tests for the #747 implementation-challenge
 * repair loop in the native reviewer transport.
 *
 * The host capture boundary (`validateCapturedFindings`) and the tool
 * consumption boundary (`resolveStructuredEffectiveFindings`) are two distinct
 * gates over the same reviewer findings. #1081 requires them to agree on the
 * exact set of prior failing challenges the author addressed, otherwise the
 * repair loop deadlocks: capture would reject the very verdicts consumption
 * requires (or accept findings consumption later rejects).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewFindings, ReviewObligation } from '../../../state/evidence.js';
import { makeState } from '../../../fixtures.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { TEST_EXECUTION_OBSERVATION } from '../../../state/evidence-test-constants.js';
import {
  capturePreparedFindings,
  validateCapturedFindings,
  type NativeReviewRuntimePort,
} from './native-task-review-bindings.js';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import { buildReviewChallengeContract } from '../obligations/challenge-contract.js';
import {
  createReviewObligation,
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../obligations/assurance.js';

const NOW = '2026-07-26T00:00:00.000Z';
const IMPL_DIGEST = 'impl-digest';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const PRIOR_CHALLENGE = '11111111-1111-4111-8111-111111111111';
const LATE_CHALLENGE = '99999999-9999-4999-8999-999999999999';
const FRESH_CHALLENGE = '22222222-2222-4222-8222-222222222222';
const FOREIGN_CHALLENGE = '88888888-8888-4888-8888-888888888888';
const OBLIGATION_ID = '44444444-4444-4444-8444-444444444444';

function implementationChallenge(challengeId: string, outcome: 'pass' | 'fail') {
  return {
    challengeId,
    obligationId: OBLIGATION_ID,
    kind: 'implementation_challenge' as const,
    scenario: 'Exercise the changed behavior.',
    claim: 'The implementation handles the expected input.',
    locations: ['src/example.ts'],
    evidenceRefs: [
      { kind: 'implementation' as const, implementationDigest: IMPL_DIGEST },
      { kind: 'validation_attempt' as const, attemptId: ATTEMPT_ID },
    ],
    outcome,
  };
}

function priorFindings(
  challenges: ReturnType<typeof implementationChallenge>[],
  verdicts?: { challengeId: string; verdict: string }[],
): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges,
    reviewedBy: { sessionId: 'ses_round1' },
    reviewedAt: NOW,
    ...(verdicts ? { challengeResolutionVerdicts: verdicts } : {}),
  } as unknown as ReviewFindings;
}

function passingAttempt() {
  return {
    attemptId: ATTEMPT_ID,
    scope: 'implementation' as const,
    implementationId: '00000000-0000-4000-8000-0000000000aa',
    implementationDigest: IMPL_DIGEST,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: {
      checkId: 'test',
      passed: true,
      detail: 'passed',
      executedAt: NOW,
      kind: 'test' as const,
      command: 'npm test',
      exitCode: 0,
      executionMs: 1,
      outputDigest: 'a'.repeat(64),
      timedOut: false,
      outcome: 'supported' as const,
    },
  };
}

function roundTwoState(input: {
  priorChallenges: ReturnType<typeof implementationChallenge>[];
  resolutions: { challengeId: string; implementationDigest: string }[];
}) {
  return makeState('IMPL_REVIEW', {
    implementation: {
      implementationId: '00000000-0000-4000-8000-0000000000aa',
      changedFiles: ['src/example.ts'],
      domainFiles: ['src/example.ts'],
      digest: IMPL_DIGEST,
      executedAt: NOW,
    },
    validationAttempts: [passingAttempt()] as never,
    implReviewFindings: [priorFindings(input.priorChallenges)] as never,
    challengeResolutions: input.resolutions.map((resolution) => ({
      validationAttemptIds: [ATTEMPT_ID],
      resolvedAt: NOW,
      ...resolution,
    })),
  });
}

function implementationObligation(): ReviewObligation {
  return {
    ...createReviewObligation({
      obligationType: 'implement',
      iteration: 1,
      reviewCycle: 2,
      planVersion: 1,
      now: NOW,
      subjectDigest: IMPL_DIGEST,
      reviewMaterial: freezeReviewMaterial('frozen review material', IMPL_DIGEST),
      reviewSubjectScope: { kind: 'implementation', implementationDigest: IMPL_DIGEST },
      changedFiles: ['src/example.ts'],
    }),
    obligationId: OBLIGATION_ID,
    requiredChallengeCount: 1,
    requiredChallengeKind: 'implementation_challenge',
  };
}

function preparedRoundTwo(input: {
  verdicts?: { challengeId: string; verdict: string }[];
  omitVerdicts?: boolean;
}): Record<string, unknown> {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_round2' },
    reviewedAt: NOW,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: OBLIGATION_ID,
      iteration: 1,
      planVersion: 1,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
    challenges: [implementationChallenge(FRESH_CHALLENGE, 'pass')],
    ...(input.omitVerdicts
      ? {}
      : {
          challengeResolutionVerdicts: input.verdicts ?? [
            { challengeId: PRIOR_CHALLENGE, verdict: 'resolved' },
          ],
        }),
  };
}

describe('native capture — implementation challenge repair loop (#1081/#747)', () => {
  it('accepts a reviewer verdict that independently closes an author-resolved prior challenge', () => {
    const state = roundTwoState({
      priorChallenges: [implementationChallenge(PRIOR_CHALLENGE, 'fail')],
      resolutions: [{ challengeId: PRIOR_CHALLENGE, implementationDigest: IMPL_DIGEST }],
    });
    const result = validateCapturedFindings(
      state,
      implementationObligation(),
      preparedRoundTwo({}),
    );
    expect(result.kind).toBe('valid');
  });

  it('blocks accept while a prior failing challenge has no author resolution', () => {
    const state = roundTwoState({
      priorChallenges: [implementationChallenge(PRIOR_CHALLENGE, 'fail')],
      resolutions: [],
    });
    const result = validateCapturedFindings(
      state,
      implementationObligation(),
      preparedRoundTwo({ omitVerdicts: true }),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('unreachable');
    expect(result.code).toBe('SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED');
  });

  it('blocks a verdict for a challenge outside the targeted set', () => {
    const state = roundTwoState({
      priorChallenges: [implementationChallenge(PRIOR_CHALLENGE, 'fail')],
      resolutions: [{ challengeId: PRIOR_CHALLENGE, implementationDigest: IMPL_DIGEST }],
    });
    const result = validateCapturedFindings(
      state,
      implementationObligation(),
      preparedRoundTwo({
        verdicts: [{ challengeId: FOREIGN_CHALLENGE, verdict: 'resolved' }],
      }),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('unreachable');
    expect(result.code).toBe('SUBAGENT_RESOLUTION_VERDICT_UNKNOWN');
  });

  it('blocks a duplicate verdict for the same targeted challenge', () => {
    const state = roundTwoState({
      priorChallenges: [implementationChallenge(PRIOR_CHALLENGE, 'fail')],
      resolutions: [{ challengeId: PRIOR_CHALLENGE, implementationDigest: IMPL_DIGEST }],
    });
    const result = validateCapturedFindings(
      state,
      implementationObligation(),
      preparedRoundTwo({
        verdicts: [
          { challengeId: PRIOR_CHALLENGE, verdict: 'resolved' },
          { challengeId: PRIOR_CHALLENGE, verdict: 'resolved' },
        ],
      }),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('unreachable');
    expect(result.code).toBe('SUBAGENT_RESOLUTION_VERDICT_DUPLICATE');
  });

  it('binds targets to the reviewer contract: a late author resolution cannot count as reviewed', () => {
    // The reviewer was dispatched when only PRIOR_CHALLENGE was author-resolved.
    // A second resolution (LATE_CHALLENGE) recorded after dispatch must NOT be
    // treated as an independently reviewed closure: the reviewer findings carry
    // no verdict for it, so the capture fails closed instead of accepting.
    const state = roundTwoState({
      priorChallenges: [
        implementationChallenge(PRIOR_CHALLENGE, 'fail'),
        implementationChallenge(LATE_CHALLENGE, 'fail'),
      ],
      resolutions: [
        { challengeId: PRIOR_CHALLENGE, implementationDigest: IMPL_DIGEST },
        { challengeId: LATE_CHALLENGE, implementationDigest: IMPL_DIGEST },
      ],
    });
    const result = validateCapturedFindings(
      state,
      implementationObligation(),
      preparedRoundTwo({
        verdicts: [{ challengeId: PRIOR_CHALLENGE, verdict: 'resolved' }],
      }),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('unreachable');
    expect(result.code).toBe('SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED');
  });

  it('does not apply implementation-challenge resolution requirements to non-implement reviews', () => {
    const planObligation: ReviewObligation = {
      ...createReviewObligation({
        obligationType: 'plan',
        iteration: 0,
        reviewCycle: 1,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'plan-digest',
        reviewMaterial: freezeReviewMaterial('## Decision\nBody', 'plan-digest'),
        reviewSubjectScope: {
          kind: 'artifact',
          artifact: {
            kind: 'plan',
            digest: 'plan-digest',
            sectionPaths: [[{ headingDepth: 2, siblingIndex: 1, headingText: 'Decision' }]],
          },
        },
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      }),
      obligationId: OBLIGATION_ID,
      requiredChallengeCount: 1,
      requiredChallengeKind: 'design_challenge',
    };
    const state = makeState('PLAN_REVIEW', {
      implReviewFindings: [
        priorFindings([implementationChallenge(PRIOR_CHALLENGE, 'fail')]),
      ] as never,
      challengeResolutions: [
        {
          challengeId: PRIOR_CHALLENGE,
          implementationDigest: IMPL_DIGEST,
          validationAttemptIds: [ATTEMPT_ID],
          resolvedAt: NOW,
        },
      ] as never,
    });
    const prepared = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'accept',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_plan_reviewer' },
      reviewedAt: NOW,
      attestation: {
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: OBLIGATION_ID,
        iteration: 0,
        planVersion: 1,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
      challenges: [
        {
          challengeId: FRESH_CHALLENGE,
          obligationId: OBLIGATION_ID,
          kind: 'design_challenge',
          scenario: 'Exercise the decision against its canonical section.',
          claim: 'The decision is supported.',
          locations: ['Plan: Decision'],
          evidenceRefs: buildReviewChallengeContract(state, planObligation)?.evidenceRefs ?? [],
          outcome: 'supported',
        },
      ],
    };
    const result = validateCapturedFindings(state, planObligation, prepared);
    expect(result.kind).toBe('valid');
  });
});

describe('native capture - structured follow-up timing diagnostics', () => {
  const ALLOWED_FIELDS = new Set([
    'obligationId',
    'childSessionId',
    'followupPromptMs',
    'promptOutcome',
    'followupPromptMsUnavailable',
  ]);

  afterEach(() => {
    _resetAgentResolutionCache();
  });

  function runtimeWith(info: (...args: unknown[]) => void): NativeReviewRuntimePort {
    return {
      orchestratorDeps: {
        client: {
          app: { agents: vi.fn(async () => ({ data: [{ name: REVIEWER_SUBAGENT_TYPE }] })) },
          session: { prompt: vi.fn(async () => ({ data: { info: {} } })) },
        },
      },
      log: { info, warn: vi.fn() },
      logError: vi.fn(),
    } as unknown as NativeReviewRuntimePort;
  }

  const obligation = { obligationId: OBLIGATION_ID } as unknown as ReviewObligation;

  it('logs one allowlisted timing line per follow-up, without content', async () => {
    const info = vi.fn();
    await capturePreparedFindings(runtimeWith(info), obligation, 'ses_child_1');
    const timingCalls = info.mock.calls.filter(
      ([, message]) => message === 'review structured followup timing',
    );
    expect(timingCalls).toHaveLength(1);
    const fields = timingCalls[0]?.[2] as Record<string, unknown>;
    for (const key of Object.keys(fields)) expect(ALLOWED_FIELDS.has(key), key).toBe(true);
    expect(fields).toMatchObject({
      obligationId: OBLIGATION_ID,
      childSessionId: 'ses_child_1',
      promptOutcome: 'responded',
    });
  });

  it('a throwing logger never changes the capture result', async () => {
    const throwing = vi.fn(() => {
      throw new Error('log sink failure');
    });
    const observed = await capturePreparedFindings(
      runtimeWith(throwing),
      obligation,
      'ses_child_1',
    );
    _resetAgentResolutionCache();
    const reference = await capturePreparedFindings(
      runtimeWith(vi.fn()),
      obligation,
      'ses_child_1',
    );
    expect(observed).toEqual(reference);
    expect(throwing).toHaveBeenCalled();
  });
});
