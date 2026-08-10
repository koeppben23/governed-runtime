import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANDIDATE_CONTENT_DIGEST,
  CANDIDATE_DIGEST,
  makeState,
  makeImplEvidence,
} from '../../fixtures.js';
import { readState, writeState } from '../../adapters/persistence.js';
import { computeFingerprint, sessionDir } from '../../adapters/workspace/index.js';
import { createTestWorkspace, createToolContext, parseToolResult } from '../test-helpers.js';
import { resolve_implementation_challenge } from './challenge-resolution.js';

// #747 recording precondition: only a FAILED falsification (fail/not_verified)
// may be resolved. Recording a resolution for a `pass` challenge would fabricate
// a closure lifecycle for an already-passing challenge.

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const DIGEST = CANDIDATE_DIGEST;
const CONTENT_DIGEST = CANDIDATE_CONTENT_DIGEST;
const CONTENT_DIGEST_2 = 'content-digest-2';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID_2 = '55555555-5555-4555-8555-555555555555';
const FAIL_CHALLENGE = '11111111-1111-4111-8111-111111111111';
const PASS_CHALLENGE = '22222222-2222-4222-8222-222222222222';

function challenge(challengeId: string, outcome: 'pass' | 'fail') {
  return {
    challengeId,
    obligationId: '44444444-4444-4444-8444-444444444444',
    kind: 'implementation_challenge' as const,
    scenario: 'Exercise the changed behavior.',
    claim: 'The implementation handles the expected input.',
    locations: ['src/example.ts'],
    evidenceRefs: [
      { kind: 'implementation' as const, implementationDigest: DIGEST },
      { kind: 'validation_attempt' as const, attemptId: ATTEMPT_ID },
    ],
    outcome,
  };
}

function attempt(attemptId: string, implementationDigest: string) {
  return {
    attemptId,
    scope: 'implementation' as const,
    implementationDigest,
    result: {
      checkId: 'test',
      passed: true,
      detail: 'passed',
      executedAt: '2026-07-26T00:00:00.000Z',
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

function reviewFindings(overrides: Record<string, unknown>) {
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
    reviewedBy: { sessionId: 'reviewer-0' },
    reviewedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

interface SeedOptions {
  contentDigest?: string;
  findingsList?: Record<string, unknown>[];
  resolutions?: {
    challengeId: string;
    implementationDigest: string;
    validationAttemptIds: string[];
    resolvedAt?: string;
  }[];
  attempts?: ReturnType<typeof attempt>[];
}

async function seedState(options: SeedOptions = {}) {
  const ws = await createTestWorkspace();
  cleanup = ws.cleanup;
  const sessionID = `ses_resolution_${crypto.randomUUID().replace(/-/g, '')}`;
  const context = createToolContext({ worktree: ws.tmpDir, directory: ws.tmpDir, sessionID });
  const fingerprint = await computeFingerprint(ws.tmpDir);
  const sessDir = sessionDir(fingerprint.fingerprint, sessionID);
  await fs.mkdir(sessDir, { recursive: true });
  const implementation = options.contentDigest
    ? makeImplEvidence({ candidate: { contentDigest: options.contentDigest } })
    : makeImplEvidence();
  await writeState(
    sessDir,
    makeState('IMPL_REVIEW', {
      implementation,
      implReviewFindings: (options.findingsList ?? [
        reviewFindings({
          challenges: [challenge(FAIL_CHALLENGE, 'fail'), challenge(PASS_CHALLENGE, 'pass')],
        }),
      ]) as never,
      challengeResolutions: (options.resolutions ?? []).map((resolution) => ({
        resolvedAt: '2026-07-26T00:00:00.000Z',
        ...resolution,
      })),
      validationAttempts: options.attempts ?? [
        attempt(ATTEMPT_ID, implementation.candidate.contentDigest),
      ],
    }),
  );
  return { context, sessDir };
}

describe('resolve_implementation_challenge — outcome precondition (#747)', () => {
  it('blocks resolving a challenge whose outcome is pass', async () => {
    const { context } = await seedState();
    const result = parseToolResult(
      await resolve_implementation_challenge.execute(
        { challengeId: PASS_CHALLENGE, validationAttemptIds: [ATTEMPT_ID] },
        context,
      ),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('IMPLEMENTATION_CHALLENGE_NOT_FAILED');
  });

  it('allows resolving a challenge whose outcome is fail', async () => {
    const { context, sessDir } = await seedState();
    const result = parseToolResult(
      await resolve_implementation_challenge.execute(
        { challengeId: FAIL_CHALLENGE, validationAttemptIds: [ATTEMPT_ID] },
        context,
      ),
    );
    expect(result.error).toBeUndefined();
    const state = await readState(sessDir);
    expect(state?.challengeResolutions).toHaveLength(1);
    expect(state?.challengeResolutions[0]?.challengeId).toBe(FAIL_CHALLENGE);
  });

  describe('multi-round append-only lifecycle (#747)', () => {
    it('blocks a byte-identical second resolution for the same challenge + digest', async () => {
      const { context } = await seedState({
        resolutions: [
          {
            challengeId: FAIL_CHALLENGE,
            implementationDigest: DIGEST,
            validationAttemptIds: [ATTEMPT_ID],
          },
        ],
      });
      const result = parseToolResult(
        await resolve_implementation_challenge.execute(
          { challengeId: FAIL_CHALLENGE, validationAttemptIds: [ATTEMPT_ID] },
          context,
        ),
      );
      expect(result.error).toBe(true);
      expect(result.code).toBe('IMPLEMENTATION_CHALLENGE_ALREADY_RESOLVED');
    });

    it('allows a new resolution for the same challenge against a NEW digest after still_failing', async () => {
      // Round 1: A(fail). Prior author resolution against digest 1. Reviewer round 2
      // returned still_failing → A no longer in the latest challenges[] (only a
      // verdict). New implementation digest 2 + fresh passing attempt: a second
      // append-only resolution must be allowed.
      const { context, sessDir } = await seedState({
        contentDigest: CONTENT_DIGEST_2,
        findingsList: [
          reviewFindings({ challenges: [challenge(FAIL_CHALLENGE, 'fail')] }),
          reviewFindings({
            reviewedBy: { sessionId: 'reviewer-1' },
            challengeResolutionVerdicts: [
              { challengeId: FAIL_CHALLENGE, verdict: 'still_failing' },
            ],
          }),
        ],
        resolutions: [
          {
            challengeId: FAIL_CHALLENGE,
            implementationDigest: DIGEST,
            validationAttemptIds: [ATTEMPT_ID],
          },
        ],
        attempts: [attempt(ATTEMPT_ID, CONTENT_DIGEST), attempt(ATTEMPT_ID_2, CONTENT_DIGEST_2)],
      });
      const result = parseToolResult(
        await resolve_implementation_challenge.execute(
          { challengeId: FAIL_CHALLENGE, validationAttemptIds: [ATTEMPT_ID_2] },
          context,
        ),
      );
      expect(result.error).toBeUndefined();
      const state = await readState(sessDir);
      expect(state?.challengeResolutions).toHaveLength(2);
      expect(state?.challengeResolutions[1]?.implementationDigest).toBe(
        state?.implementation?.candidate.candidateDigest,
      );
    });

    it('resolves a challenge that is absent from the latest challenges[] but still_failing per the latest verdict', async () => {
      // The exact review scenario: A is only present in findings[0].challenges;
      // findings[1] carries A forward solely as a still_failing verdict. The
      // resolver must still treat A as resolvable via the lifecycle projection.
      const { context } = await seedState({
        contentDigest: CONTENT_DIGEST_2,
        findingsList: [
          reviewFindings({ challenges: [challenge(FAIL_CHALLENGE, 'fail')] }),
          reviewFindings({
            reviewedBy: { sessionId: 'reviewer-1' },
            challengeResolutionVerdicts: [
              { challengeId: FAIL_CHALLENGE, verdict: 'still_failing' },
            ],
          }),
        ],
        attempts: [attempt(ATTEMPT_ID_2, CONTENT_DIGEST_2)],
      });
      const result = parseToolResult(
        await resolve_implementation_challenge.execute(
          { challengeId: FAIL_CHALLENGE, validationAttemptIds: [ATTEMPT_ID_2] },
          context,
        ),
      );
      expect(result.error).toBeUndefined();
    });

    it('blocks resolving a challenge whose latest independent verdict is resolved', async () => {
      const { context } = await seedState({
        contentDigest: CONTENT_DIGEST_2,
        findingsList: [
          reviewFindings({ challenges: [challenge(FAIL_CHALLENGE, 'fail')] }),
          reviewFindings({
            reviewedBy: { sessionId: 'reviewer-1' },
            challengeResolutionVerdicts: [{ challengeId: FAIL_CHALLENGE, verdict: 'resolved' }],
          }),
        ],
        attempts: [attempt(ATTEMPT_ID_2, CONTENT_DIGEST_2)],
      });
      const result = parseToolResult(
        await resolve_implementation_challenge.execute(
          { challengeId: FAIL_CHALLENGE, validationAttemptIds: [ATTEMPT_ID_2] },
          context,
        ),
      );
      expect(result.error).toBe(true);
      expect(result.code).toBe('IMPLEMENTATION_CHALLENGE_NOT_FAILED');
    });
  });
});
