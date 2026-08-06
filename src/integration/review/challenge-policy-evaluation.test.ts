/**
 * @module integration/review/challenge-policy-evaluation.test
 * @description Controlled #747 lifecycle evaluation using host-captured reviewer findings.
 */

import { performance } from 'node:perf_hooks';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { CHALLENGE_POLICY_V1 } from '../../config/policy-types.js';
import { makeState } from '../../fixtures.js';
import type { ReviewFindings } from '../../state/evidence.js';
import { readState, writeState } from '../../adapters/persistence.js';
import { computeFingerprint, sessionDir } from '../../adapters/workspace/index.js';
import { createTestWorkspace, createToolContext, parseToolResult } from '../test-helpers.js';
import { resolve_implementation_challenge } from '../tools/challenge-resolution.js';
import { resolveHostTaskFindings } from '../tools/review-validation-host-task.js';
import {
  computeTargetedResolutionChallengeIds,
  computeUnaddressedPriorFailIds,
} from '../tools/implement-review.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  buildInvocationEvidence,
  createReviewObligation,
  hashFindings,
} from './assurance.js';

type Fixture = {
  readonly name: string;
  /** Independently assigned fixture label, never derived from the resolver result. */
  readonly expectedPolicyBlock: boolean;
  readonly capture: 'missing_challenge' | 'structurally_valid';
};

type Metrics = {
  readonly recall: number;
  readonly precision: number | null;
  readonly blockingRate: number;
  readonly reReviewRate: number;
  readonly pipelineValidationLatencyMs: number;
  readonly fixtureReviewerLatencyMs: number;
};

const FIXTURES: readonly Fixture[] = [
  {
    name: 'missing-required-challenge',
    expectedPolicyBlock: true,
    capture: 'missing_challenge',
  },
  {
    // This label models a semantic defect that structural challenge validation cannot detect.
    name: 'semantic-challenge-gap',
    expectedPolicyBlock: true,
    capture: 'structurally_valid',
  },
  {
    // This deliberately contested label keeps false positives visible in the comparison.
    name: 'contested-no-challenge-control',
    expectedPolicyBlock: false,
    capture: 'missing_challenge',
  },
  {
    name: 'valid-challenge-control',
    expectedPolicyBlock: false,
    capture: 'structurally_valid',
  },
];

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

function capturedFindings(
  obligationId: string,
  iteration: number,
  capture: Fixture['capture'],
  overrides: Partial<ReviewFindings> = {},
): ReviewFindings {
  const challengeId = '11111111-1111-4111-8111-111111111111';
  return {
    iteration,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: `captured-reviewer-${iteration}` },
    reviewedAt: '2026-07-26T00:00:00.000Z',
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: obligationId,
      iteration,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    ...(capture === 'structurally_valid'
      ? {
          challenges: [
            {
              challengeId,
              obligationId,
              kind: 'implementation_challenge' as const,
              scenario: 'Exercise the changed behavior.',
              claim: 'The implementation handles the expected input.',
              locations: ['src/example.ts'],
              evidenceRefs: [
                { kind: 'implementation' as const, implementationDigest: 'impl-digest' },
                {
                  kind: 'validation_attempt' as const,
                  attemptId: '33333333-3333-4333-8333-333333333333',
                },
              ],
              outcome: 'pass' as const,
            },
          ],
        }
      : {}),
    ...overrides,
  };
}

async function fixtureReviewer(
  artifact: Readonly<{ obligationId: string; iteration: number; capture: Fixture['capture'] }>,
): Promise<ReviewFindings> {
  // Deterministic reviewer fixture: deserialize its review artifact before producing findings.
  const parsed = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
  return capturedFindings(parsed.obligationId, parsed.iteration, parsed.capture);
}

async function resolveCapturedFixture(
  fixture: Fixture,
  frozen: boolean,
): Promise<{ blocked: boolean; reviewerLatencyMs: number }> {
  const obligation = createReviewObligation({
    obligationType: 'implement',
    iteration: 0,
    planVersion: 1,
    now: '2026-07-26T00:00:00.000Z',
    subjectDigest: 'test',
    changedFiles: ['src/example.ts'],
    policySnapshot: frozen ? { challengePolicy: CHALLENGE_POLICY_V1 } : {},
  });
  const reviewerStartedAt = performance.now();
  const findings = await fixtureReviewer({
    obligationId: obligation.obligationId,
    iteration: 0,
    capture: fixture.capture,
  });
  const reviewerLatencyMs = performance.now() - reviewerStartedAt;
  const invocation = buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: 'implement',
    parentSessionId: 'evaluation-parent',
    childSessionId: findings.reviewedBy.sessionId,
    invocationMode: 'host_subagent_task',
    hostVisible: true,
    promptHash: `prompt-${fixture.name}`,
    findingsHash: hashFindings(findings),
    invokedAt: '2026-07-26T00:00:00.000Z',
    capturedRawFindings: findings,
  });
  const result = resolveHostTaskFindings(
    { obligations: [obligation], invocations: [invocation], attempts: [] },
    obligation,
  );
  return { blocked: result.kind !== 'resolved', reviewerLatencyMs };
}

async function runResolutionAndIndependentReReview(frozen: boolean): Promise<boolean> {
  const ws = await createTestWorkspace();
  cleanup = ws.cleanup;
  const sessionID = `ses_challenge_eval_${crypto.randomUUID().replace(/-/g, '')}`;
  const context = createToolContext({ worktree: ws.tmpDir, directory: ws.tmpDir, sessionID });
  const fingerprint = await computeFingerprint(ws.tmpDir);
  const sessDir = sessionDir(fingerprint.fingerprint, sessionID);
  await fs.mkdir(sessDir, { recursive: true });

  const firstObligation = createReviewObligation({
    obligationType: 'implement',
    iteration: 0,
    planVersion: 1,
    now: '2026-07-26T00:00:00.000Z',
    subjectDigest: 'test',
    changedFiles: ['src/example.ts'],
    policySnapshot: frozen ? { challengePolicy: CHALLENGE_POLICY_V1 } : {},
  });
  const challengeId = '22222222-2222-4222-8222-222222222222';
  const firstFindings = capturedFindings(firstObligation.obligationId, 0, 'structurally_valid', {
    overallVerdict: 'changes_requested',
    reviewedBy: { sessionId: 'captured-reviewer-first' },
    challenges: [
      {
        challengeId,
        obligationId: firstObligation.obligationId,
        kind: 'implementation_challenge',
        scenario: 'Exercise the changed behavior.',
        claim: 'The implementation handles the expected input.',
        locations: ['src/example.ts'],
        evidenceRefs: [
          { kind: 'implementation', implementationDigest: 'impl-digest' },
          { kind: 'validation_attempt', attemptId: '33333333-3333-4333-8333-333333333333' },
        ],
        outcome: 'fail',
      },
    ],
  });
  const firstInvocation = buildInvocationEvidence({
    obligationId: firstObligation.obligationId,
    obligationType: 'implement',
    parentSessionId: sessionID,
    childSessionId: firstFindings.reviewedBy.sessionId,
    invocationMode: 'host_subagent_task',
    hostVisible: true,
    promptHash: 'initial-changes-requested-prompt',
    findingsHash: hashFindings(firstFindings),
    invokedAt: '2026-07-26T00:00:00.000Z',
    capturedRawFindings: firstFindings,
  });
  expect(
    resolveHostTaskFindings(
      { obligations: [firstObligation], invocations: [firstInvocation], attempts: [] },
      firstObligation,
    ).kind,
  ).toBe('resolved');
  const attemptId = '33333333-3333-4333-8333-333333333333';
  await writeState(
    sessDir,
    makeState('IMPL_REVIEW', {
      implementation: {
        changedFiles: ['src/example.ts'],
        domainFiles: ['src/example.ts'],
        digest: 'impl-digest',
        executedAt: '2026-07-26T00:00:00.000Z',
      },
      implReviewFindings: [firstFindings],
      reviewAssurance: {
        obligations: [firstObligation],
        invocations: [firstInvocation],
        attempts: [],
      },
      validationAttempts: [
        {
          attemptId,
          scope: 'implementation',
          implementationDigest: 'impl-digest',
          result: {
            checkId: 'test',
            passed: true,
            detail: 'passed',
            executedAt: '2026-07-26T00:00:00.000Z',
            kind: 'test',
            command: 'npm test',
            exitCode: 0,
            executionMs: 1,
            outputDigest: 'a'.repeat(64),
            timedOut: false,
            outcome: 'supported' as const,
          },
        },
      ],
    }),
  );

  const resolution = parseToolResult(
    await resolve_implementation_challenge.execute(
      { challengeId, validationAttemptIds: [attemptId] },
      context,
    ),
  );
  expect(resolution.error).toBeUndefined();
  const state = await readState(sessDir);
  expect(state?.challengeResolutions).toHaveLength(1);

  const secondObligation = createReviewObligation({
    obligationType: 'implement',
    iteration: 1,
    planVersion: 1,
    now: '2026-07-26T00:01:00.000Z',
    subjectDigest: 'test',
    changedFiles: ['src/example.ts'],
    policySnapshot: frozen ? { challengePolicy: CHALLENGE_POLICY_V1 } : {},
  });
  const secondFindings = capturedFindings(secondObligation.obligationId, 1, 'structurally_valid', {
    reviewedBy: { sessionId: 'captured-reviewer-second' },
    challengeResolutionVerdicts: [{ challengeId, verdict: 'resolved' }],
  });
  const secondInvocation = buildInvocationEvidence({
    obligationId: secondObligation.obligationId,
    obligationType: 'implement',
    parentSessionId: sessionID,
    childSessionId: secondFindings.reviewedBy.sessionId,
    invocationMode: 'host_subagent_task',
    hostVisible: true,
    promptHash: 'independent-re-review-prompt',
    findingsHash: hashFindings(secondFindings),
    invokedAt: '2026-07-26T00:01:00.000Z',
    capturedRawFindings: secondFindings,
  });
  const reReview = resolveHostTaskFindings(
    { obligations: [secondObligation], invocations: [secondInvocation], attempts: [] },
    secondObligation,
    state ? computeTargetedResolutionChallengeIds(state) : undefined,
    undefined,
    state ? computeUnaddressedPriorFailIds(state) : undefined,
  );
  return (
    reReview.kind === 'resolved' &&
    secondFindings.reviewedBy.sessionId !== firstFindings.reviewedBy.sessionId
  );
}

async function evaluateFixtures(frozen: boolean): Promise<Metrics> {
  const pipelineStartedAt = performance.now();
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let blocked = 0;
  let reviewerLatencyMs = 0;

  for (const fixture of FIXTURES) {
    const result = await resolveCapturedFixture(fixture, frozen);
    const isBlocked = result.blocked;
    reviewerLatencyMs += result.reviewerLatencyMs;
    if (isBlocked) blocked++;
    if (isBlocked && fixture.expectedPolicyBlock) truePositives++;
    if (isBlocked && !fixture.expectedPolicyBlock) falsePositives++;
    if (!isBlocked && fixture.expectedPolicyBlock) falseNegatives++;
  }

  const secondReviewOccurred = await runResolutionAndIndependentReReview(frozen);
  const totalFixtures = FIXTURES.length + 1;
  return {
    recall: truePositives / (truePositives + falseNegatives),
    precision:
      truePositives + falsePositives === 0
        ? null
        : truePositives / (truePositives + falsePositives),
    blockingRate: blocked / totalFixtures,
    reReviewRate: secondReviewOccurred ? 1 / totalFixtures : 0,
    pipelineValidationLatencyMs: performance.now() - pipelineStartedAt,
    fixtureReviewerLatencyMs: reviewerLatencyMs,
  };
}

describe('controlled challenge-policy lifecycle evaluation (#747)', () => {
  it('compares frozen policy with legacy obligations using captured findings and an actual re-review', async () => {
    const withoutFrozenRequirements = await evaluateFixtures(false);
    await cleanup?.();
    cleanup = null;
    const withFrozenRequirements = await evaluateFixtures(true);

    expect(withoutFrozenRequirements).toMatchObject({
      recall: 0,
      precision: null,
      blockingRate: 0,
      reReviewRate: 1 / 5,
    });
    expect(withFrozenRequirements).toMatchObject({
      recall: 1 / 2,
      precision: 1 / 2,
      blockingRate: 2 / 5,
      reReviewRate: 1 / 5,
    });
    expect(withoutFrozenRequirements.pipelineValidationLatencyMs).toBeGreaterThanOrEqual(0);
    expect(withFrozenRequirements.pipelineValidationLatencyMs).toBeGreaterThanOrEqual(0);
    expect(withoutFrozenRequirements.fixtureReviewerLatencyMs).toBeGreaterThanOrEqual(0);
    expect(withFrozenRequirements.fixtureReviewerLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
