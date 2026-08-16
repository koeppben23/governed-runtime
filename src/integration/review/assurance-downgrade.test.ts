/**
 * @module integration/review-assurance-downgrade.test
 * @description F8 tests: review-output assurance downgrade for recovered JSON.
 *
 * Clean structured reviewer output binds at structured_high. Findings recovered
 * from an embedded/brace-balanced JSON block in mixed model output (the class of
 * malformed/verrutschtes output seen in the demo run) bind at
 * structured_recovered so the audit trail reflects reduced provenance
 * confidence. Binding still proceeds (user chose: downgrade, not fail-closed).
 *
 * @test-policy HAPPY, EDGE, REGRESSION.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from './enforcement/enforcement.js';
import { buildHostTaskEvidence } from './evidence-binding.js';
import { extractCapturedFindings } from './enforcement/extraction.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import {
  NOW,
  LATER,
  SESSION_ID,
  CHILD_SESSION_ID,
  modeAResponse,
  validPrompt,
  pendingObligation,
  attemptFor,
} from '../plugin-host-task-diagnostics-helpers.js';

function findingsJson(obligationId: string): string {
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
    attestation: {
      toolObligationId: obligationId,
    },
  });
}

describe('F8: extractCapturedFindings tags the extraction method', () => {
  it('marks clean whole-output JSON as clean_json', () => {
    const captured = extractCapturedFindings(findingsJson('00000000-0000-4000-8000-000000000000'));
    expect(captured?.extractionMethod).toBe('clean_json');
  });

  it('marks embedded/brace-recovered JSON as recovered_block', () => {
    const embedded = `Here is my review analysis in prose.\n\n\`\`\`json\n${findingsJson(
      '00000000-0000-4000-8000-000000000000',
    )}\n\`\`\`\nThanks!`;
    const captured = extractCapturedFindings(embedded);
    expect(captured?.extractionMethod).toBe('recovered_block');
  });
});

describe('F8: buildHostTaskEvidence downgrades assurance for recovered findings', () => {
  function setup(makeTaskResult: (obligationId: string) => string) {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
    const obligation = pendingObligation();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      makeTaskResult(obligation.obligationId),
      LATER,
      { metadata: { sessionID: CHILD_SESSION_ID }, callID: 'call_assurance_001' },
    );
    return { state, obligation, attempts: [attemptFor(obligation, CHILD_SESSION_ID)] };
  }

  it('binds clean JSON at structured_high', () => {
    const { state, obligation, attempts } = setup((id) => findingsJson(id));
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence?.reviewAssuranceLevel).toBe('structured_high');
    // Clean structured output keeps the structured-output transport contract.
    expect(result.evidence?.reviewOutputMode).toBe('structured_output');
    expect(result.evidence?.structuredOutputUsed).toBe(true);
  });

  it('binds recovered/embedded JSON at structured_recovered (not high)', () => {
    const { state, obligation, attempts } = setup(
      (id) => `Review summary follows.\n\n\`\`\`json\n${findingsJson(id)}\n\`\`\``,
    );
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence?.reviewAssuranceLevel).toBe('structured_recovered');
  });

  it('keeps the whole transport contract consistent for recovered findings', () => {
    // Review finding: structured_recovered must not coexist with
    // reviewOutputMode=structured_output / structuredOutputUsed=true. All four
    // transport fields must agree that the payload was recovered from mixed text.
    const { state, obligation, attempts } = setup(
      (id) => `Prose analysis.\n\n\`\`\`json\n${findingsJson(id)}\n\`\`\``,
    );
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence?.reviewAssuranceLevel).toBe('structured_recovered');
    expect(result.evidence?.reviewOutputMode).toBe('text_compat');
    expect(result.evidence?.structuredOutputUsed).toBe(false);
    expect(result.evidence?.extractionMethod).toBe('outermost_braces');
  });
});
