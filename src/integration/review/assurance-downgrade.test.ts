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
import { REVIEW_MANDATE_DIGEST, REVIEW_CRITERIA_VERSION } from './assurance.js';
import {
  NOW,
  LATER,
  SESSION_ID,
  CHILD_SESSION_ID,
  modeAResponse,
  validPrompt,
  pendingObligation,
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
    reviewedBy: { sessionId: CHILD_SESSION_ID },
    reviewedAt: NOW,
    attestation: {
      toolObligationId: obligationId,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      iteration: 0,
      planVersion: 1,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
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
    return { state, obligation };
  }

  it('binds clean JSON at structured_high', () => {
    const { state, obligation } = setup((id) => findingsJson(id));
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence?.reviewAssuranceLevel).toBe('structured_high');
  });

  it('binds recovered/embedded JSON at structured_recovered (not high)', () => {
    const { state, obligation } = setup(
      (id) => `Review summary follows.\n\n\`\`\`json\n${findingsJson(id)}\n\`\`\``,
    );
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence?.reviewAssuranceLevel).toBe('structured_recovered');
  });
});
