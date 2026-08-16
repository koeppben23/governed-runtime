/**
 * @module durable-dispatch.test
 * @description Reviewer Task dispatch must be governed by the DURABLE attempt
 *              lifecycle, never by the transient capture. A bare Task call
 *              cannot re-arm a rejected attempt — only the originating
 *              FlowGuard command re-issues one and emits a fresh signal.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it } from 'vitest';
import { assuranceWith as fixtureAssuranceWith } from '../../../fixtures.js';
import { enforceBeforeSubagentCall } from './prompt-integrity.js';
import { createSessionState, onFlowGuardToolAfter, onTaskToolAfter } from './enforcement.js';
import {
  modeAResponse,
  validPrompt,
  taskResultWithAttestation,
  pendingObligation,
  attemptFor,
  MODE_A_OBLIGATION_ID,
  CHILD_SESSION_ID,
} from '../../plugin-host-task-diagnostics-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from './types.js';
import type { ReviewAssuranceState } from '../../../state/evidence.js';

const NOW = '2026-05-10T12:00:00.000Z';
const LATER = '2026-05-10T12:01:00.000Z';

const assuranceWithAttempts = (
  obligation: ReturnType<typeof pendingObligation>,
  attempts: ReturnType<typeof attemptFor>[],
): ReviewAssuranceState => fixtureAssuranceWith({ obligation, attempts });

function signalWithAttempt(attemptId: string, obligationId: string): string {
  const base = JSON.parse(modeAResponse(0, 1, obligationId)) as Record<string, unknown>;
  base.reviewAttemptId = attemptId;
  return JSON.stringify(base);
}

describe('durable attempt lifecycle gates reviewer Task dispatch', () => {
  it('HAPPY: a pending review with a durable created attempt is dispatchable', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);

    const obligation = pendingObligation({
      obligationId: MODE_A_OBLIGATION_ID,
      iteration: 0,
      planVersion: 1,
    });
    const attempt = attemptFor(obligation, CHILD_SESSION_ID, { childSessionId: undefined });
    const assurance = assuranceWithAttempts(obligation, [attempt]);

    const result = enforceBeforeSubagentCall(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      true,
      assurance,
    );
    expect(result.allowed).toBe(true);
  });

  it('BAD: a rejected durable attempt blocks a bare Task re-invocation', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      taskResultWithAttestation(MODE_A_OBLIGATION_ID, { childSessionId: CHILD_SESSION_ID }),
      LATER,
    );

    const obligation = pendingObligation({
      obligationId: MODE_A_OBLIGATION_ID,
      iteration: 0,
      planVersion: 1,
    });
    const rejected = {
      ...attemptFor(obligation, CHILD_SESSION_ID),
      status: 'rejected' as const,
      rejectionReason: 'schema_invalid' as const,
    };
    const assurance = assuranceWithAttempts(obligation, [rejected]);

    const result = enforceBeforeSubagentCall(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      true,
      assurance,
    );
    expect(result.allowed).toBe(false);
  });

  it('HAPPY: a fresh created attempt after an output repair re-dispatches', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      taskResultWithAttestation(MODE_A_OBLIGATION_ID, { childSessionId: CHILD_SESSION_ID }),
      LATER,
    );

    const obligation = pendingObligation({
      obligationId: MODE_A_OBLIGATION_ID,
      iteration: 0,
      planVersion: 1,
    });
    const rejected = {
      ...attemptFor(obligation, CHILD_SESSION_ID),
      status: 'rejected' as const,
      rejectionReason: 'schema_invalid' as const,
    };
    const repaired = {
      ...attemptFor(obligation, CHILD_SESSION_ID),
      attemptId: '44444444-4444-4444-8444-444444444445',
      ordinal: 2,
      childSessionId: undefined,
      origin: {
        kind: 'output_repair' as const,
        predecessorAttemptId: rejected.attemptId,
        triggerReason: 'schema_invalid' as const,
      },
    };
    const assurance = assuranceWithAttempts(obligation, [rejected, repaired]);

    // The originating command re-issued the signal with the NEW attempt id.
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      {},
      signalWithAttempt(repaired.attemptId, MODE_A_OBLIGATION_ID),
      LATER,
    );

    const result = enforceBeforeSubagentCall(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      true,
      assurance,
    );
    expect(result.allowed).toBe(true);
  });
});
