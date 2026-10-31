/**
 * @module integration/plugin-native-challenge-retry.test
 * @description Native capture-path regression for challenge evidence diagnostics:
 * a passing implementation challenge without validation-attempt evidence is
 * rejected with the exact validated field path, and the corrected fresh attempt
 * binds without weakening the validator.
 *
 * @test-policy BAD, CORNER
 */

import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import type { SessionState } from '../state/schema.js';
import { createTestWorkspace } from './test-helpers.js';
import { createReviewClient } from './opencode-v2-test-helpers.js';
import { readState, writeState } from '../adapters/persistence.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './review/dispatch/dispatch-authority.js';
import { seedStrictImplementationSession } from './plugin-host-task-diagnostics-test-helpers.js';
import {
  completedReviewMessages,
  createReviewRuntime,
  observedPrompt,
  REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
} from './reviewer-capture-test-helpers.js';
import { ReviewerCaptureController } from './reviewer-capture.js';
import {
  nativeReviewTaskBefore,
  nativeReviewTaskAfter,
} from './review/dispatch/native-task-review.js';
import { onFlowGuardToolAfter } from './review/enforcement/enforcement.js';
import { isTerminalPhase } from '../machine/topology.js';

const CHILD_SESSION_ID = 'child-session-native-1';
const CALL_ID = 'call-native-1';

function nativeFindings(
  obligationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: { toolObligationId: obligationId },
    ...overrides,
  };
}

async function dispatchReviewerTask(
  runtime: ReturnType<typeof createReviewRuntime>,
  sessionID: string,
  callID = CALL_ID,
) {
  const output: { args: Record<string, unknown> } = {
    args: { subagent_type: 'flowguard-reviewer', prompt: 'agent-authored prompt' },
  };
  await nativeReviewTaskBefore(
    runtime,
    { tool: 'task', sessionID, callID },
    output,
    async () => undefined,
    REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
  );
  return output;
}

async function completeReviewerTask(
  runtime: ReturnType<typeof createReviewRuntime>,
  sessionID: string,
  callID = CALL_ID,
) {
  const output: { title: string; output: string; metadata: Record<string, unknown> } = {
    title: 'task',
    output: 'Free-form reviewer transcript text is not findings authority.',
    metadata: { sessionId: CHILD_SESSION_ID },
  };
  await nativeReviewTaskAfter(
    runtime,
    { tool: 'task', sessionID, callID, args: { subagent_type: 'flowguard-reviewer' } },
    output,
  );
  return output;
}

describe('canonical challenge-evidence retry through a semantic host fixture, not installed V2 proof', () => {
  it('re-arms after a challenge without validation-attempt evidence and binds the corrected retry', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessionID = crypto.randomUUID();
      const { sessDir, obligationId } = await seedStrictImplementationSession(
        ws.tmpDir,
        sessionID,
        { requiredChallengeCount: 2, maxReviewerAttempts: 2 },
      );
      const validationAttemptId = '33333333-3333-4333-8333-333333333333';
      const executedAt = new Date().toISOString();
      const seeded = await readState(sessDir);
      await writeState(sessDir, {
        ...seeded,
        implementation: {
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          changedFiles: ['src/example.ts'],
          domainFiles: ['src/example.ts'],
          digest: 'impl-digest-1',
          executedAt,
        },
        validationAttempts: [
          {
            attemptId: validationAttemptId,
            scope: 'implementation',
            implementationId: '00000000-0000-4000-8000-0000000000aa',
            implementationDigest: 'impl-digest-1',
            executionObservation: TEST_EXECUTION_OBSERVATION,
            result: {
              checkId: 'test',
              passed: true,
              detail: 'passed',
              executedAt,
              kind: 'test',
              command: 'npm test',
              exitCode: 0,
              executionMs: 1,
              outputDigest: 'a'.repeat(64),
              timedOut: false,
              outcome: 'supported',
            },
          },
        ],
      } as SessionState);

      const capture = new ReviewerCaptureController();
      let findings: Record<string, unknown> = {};
      const structuredPrompt = vi.fn(
        async (
          input: Parameters<ReturnType<typeof createReviewClient>['executeReviewerPrompt']>[0],
        ) => observedPrompt(capture, input, JSON.stringify(findings)),
      );
      const client = createReviewClient({
        listAgents: vi.fn(async () => [{ id: 'flowguard-reviewer' }]),
        executeReviewerPrompt: structuredPrompt,
        readHistory: async () => completedReviewMessages(CHILD_SESSION_ID),
      });
      const runtime = createReviewRuntime(ws.tmpDir, client, capture);

      const state = await readState(sessDir);
      if (!state) throw new Error('expected persisted session state');
      const authority = resolveReviewDispatchAuthority(state.reviewAssurance, obligationId);
      expect(authority.kind).toBe('ok');
      if (authority.kind !== 'ok') return;
      const dispatchOutput = {
        title: 'implement',
        output: JSON.stringify({
          phase: 'IMPL_REVIEW',
          reviewMode: 'subagent',
          ...reviewObligationResponseFields(authority.authority),
          reviewDispatch: { required: true },
        }),
        metadata: {},
      };
      onFlowGuardToolAfter(
        runtime.ws.getEnforcementState(sessionID),
        'flowguard_implement',
        {},
        dispatchOutput.output,
        { now: new Date().toISOString(), isTerminalPhase },
      );
      await dispatchReviewerTask(runtime, sessionID);

      // c1 is a passing implementation challenge with only implementation
      // evidence; c2 carries a valid current-digest validation attempt.
      const implementationRef = { kind: 'implementation', implementationDigest: 'impl-digest-1' };
      const validationRef = { kind: 'validation_attempt', attemptId: validationAttemptId };
      const invalidChallenge = {
        clientReference: 'c1',
        obligationId,
        kind: 'implementation_challenge',
        scenario: 'Exercise the missing-owner rejection path.',
        claim: 'Writes without an owner are rejected.',
        locations: ['src/example.ts'],
        outcome: 'pass',
        evidenceRefs: [implementationRef],
      };
      const validChallenge = {
        clientReference: 'c2',
        obligationId,
        kind: 'implementation_challenge',
        scenario: 'Exercise the blank-owner rejection path.',
        claim: 'Writes with a blank owner are rejected.',
        locations: ['src/example.ts'],
        outcome: 'pass',
        evidenceRefs: [implementationRef, validationRef],
      };

      findings = nativeFindings(obligationId, {
        challenges: [invalidChallenge, validChallenge],
      });
      const first = await completeReviewerTask(runtime, sessionID);

      const retry = JSON.parse(String(first.output)) as Record<string, unknown>;
      const reviewRetry = retry.reviewRetry as Record<string, unknown>;
      expect(reviewRetry).toMatchObject({
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        obligationId,
        retryable: true,
        diagnostics: [
          {
            code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
            reasonKind: 'validation_attempt_missing',
            data: { path: 'challenges.0.evidenceRefs', required: 'validation_attempt' },
          },
        ],
      });
      const retryAttemptId = reviewRetry.attemptId as string;
      expect(retryAttemptId).not.toBe(authority.authority.attempt.attemptId);

      const correctedChallenge = {
        ...invalidChallenge,
        evidenceRefs: [implementationRef, validationRef],
      };
      findings = nativeFindings(obligationId, {
        challenges: [correctedChallenge, validChallenge],
      });
      const secondTask = await dispatchReviewerTask(runtime, sessionID, 'call-native-2');
      const secondPrompt = String(secondTask.args.prompt);
      expect(secondPrompt).toContain('challenges.0.evidenceRefs');
      expect(secondPrompt).toContain('validation_attempt_missing');

      const second = await completeReviewerTask(runtime, sessionID, 'call-native-2');
      const completed = JSON.parse(String(second.output)) as Record<string, unknown>;
      expect(completed.error).toBeUndefined();
      expect(completed.reviewDispatch).toEqual({
        required: true,
        completed: true,
        verdict: 'accept',
      });

      const finalState = await readState(sessDir);
      expect(finalState?.reviewAssurance?.obligations[0]?.status).toBe('fulfilled');
      expect(
        finalState?.reviewAssurance?.attempts.find((a) => a.attemptId === retryAttemptId)?.status,
      ).toBe('bound');
    } finally {
      await ws.cleanup();
    }
  });
});
