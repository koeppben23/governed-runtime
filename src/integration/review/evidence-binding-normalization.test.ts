/** @module integration/review-evidence-binding-normalization.test */

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

function bind(payload: Record<string, unknown>) {
  const state = createSessionState();
  onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
  const obligation = pendingObligation();
  onTaskToolAfter(
    state,
    { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
    JSON.stringify(payload),
    LATER,
    { metadata: { sessionID: CHILD_SESSION_ID } },
  );
  return buildHostTaskEvidence(state, SESSION_ID, LATER, {
    obligations: [obligation],
    invocations: [],
    attempts: [attemptFor(obligation)],
  });
}

const base = {
  iteration: 0,
  planVersion: 1,
  reviewMode: 'subagent',
  overallVerdict: 'accept',
  blockingIssues: [],
  majorRisks: [],
  missingVerification: [],
  scopeCreep: [],
  unknowns: [],
};

describe('strict reviewer input normalization boundary', () => {
  it.each([
    { ...base, attestation: null },
    { ...base, attestation: 'not-an-object' },
    { ...base, attestation: { toolObligationId: 'not_provided_in_prompt' } },
    { ...base, reviewedBy: { sessionId: CHILD_SESSION_ID } },
  ])('rejects invalid transport payload without stripping or repairing it', (payload) => {
    const result = bind(payload);
    expect(result.bindOutcome).toBe('schema_invalid');
    expect(result.evidence).toBeNull();
  });
});
