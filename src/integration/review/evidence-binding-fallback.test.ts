/** @module integration/review-evidence-binding-fallback.test */

import { describe, expect, it } from 'vitest';
import { buildHostTaskEvidence } from './evidence-binding.js';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from './enforcement/enforcement.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import {
  CHILD_SESSION_ID,
  LATER,
  NOW,
  SESSION_ID,
  attemptFor,
  modeAResponse,
  pendingObligation,
  validPrompt,
} from '../plugin-host-task-diagnostics-helpers.js';

function reviewerOutput(attestation: unknown): string {
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    ...(attestation === undefined ? {} : { attestation }),
  });
}

function bind(attestation: unknown) {
  const state = createSessionState();
  onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
  const obligation = pendingObligation();
  onTaskToolAfter(
    state,
    { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
    reviewerOutput(attestation),
    LATER,
    { metadata: { sessionID: CHILD_SESSION_ID } },
  );
  return buildHostTaskEvidence(state, SESSION_ID, LATER, {
    obligations: [obligation],
    invocations: [],
    attempts: [attemptFor(obligation)],
  });
}

describe('strict reviewer attestation boundary', () => {
  it.each([undefined, null, 'not-an-object', { toolObligationId: 'not-a-uuid' }])(
    'rejects invalid reviewer attestation %j without fallback binding',
    (attestation) => {
      const result = bind(attestation);
      expect(result.bindOutcome).toBe('schema_invalid');
      expect(result.evidence).toBeNull();
    },
  );

  it('binds a strict reviewer-owned attestation', () => {
    const obligation = pendingObligation();
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      reviewerOutput({ toolObligationId: obligation.obligationId }),
      LATER,
      { metadata: { sessionID: CHILD_SESSION_ID } },
    );
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: [attemptFor(obligation)],
    });
    expect(result.bindOutcome).toBe('bound');
  });
});
