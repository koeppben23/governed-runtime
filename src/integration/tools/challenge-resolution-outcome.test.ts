import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { makeState } from '../../fixtures.js';
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

const DIGEST = 'impl-digest';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
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

async function seedState() {
  const ws = await createTestWorkspace();
  cleanup = ws.cleanup;
  const sessionID = `ses_resolution_${crypto.randomUUID().replace(/-/g, '')}`;
  const context = createToolContext({ worktree: ws.tmpDir, directory: ws.tmpDir, sessionID });
  const fingerprint = await computeFingerprint(ws.tmpDir);
  const sessDir = sessionDir(fingerprint.fingerprint, sessionID);
  await fs.mkdir(sessDir, { recursive: true });
  await writeState(
    sessDir,
    makeState('IMPL_REVIEW', {
      implementation: {
        changedFiles: ['src/example.ts'],
        domainFiles: ['src/example.ts'],
        digest: DIGEST,
        executedAt: '2026-07-26T00:00:00.000Z',
      },
      implReviewFindings: [
        {
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
          challenges: [challenge(FAIL_CHALLENGE, 'fail'), challenge(PASS_CHALLENGE, 'pass')],
        },
      ],
      validationAttempts: [
        {
          attemptId: ATTEMPT_ID,
          scope: 'implementation',
          implementationDigest: DIGEST,
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
          },
        },
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
});
