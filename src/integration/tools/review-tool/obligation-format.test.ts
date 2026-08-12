/**
 * @module integration/tools/review-tool/obligation-format.test
 * @description Contract: blocked-review messages address a concrete obligation.
 *
 * The agent is instructed to re-run `flowguard_review` with the obligation id
 * quoted in this message. An unresolved placeholder makes that instruction
 * unfollowable and, in host-task mode, strands the review flow.
 */

import { describe, it, expect } from 'vitest';
import { formatMissingContentAnalysis } from './obligation-format.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';

const OBLIGATION_ID = 'f8163adf-6604-435a-b3ae-bae1b6b3ea08';

describe('formatMissingContentAnalysis', () => {
  it('interpolates the obligation id into the host-task continuation instruction', () => {
    const parsed = JSON.parse(formatMissingContentAnalysis(OBLIGATION_ID, true)) as {
      code: string;
      message: string;
      reviewObligationId: string;
    };

    expect(parsed.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(parsed.reviewObligationId).toBe(OBLIGATION_ID);
    expect(parsed.message).toContain(`reviewObligationId '${OBLIGATION_ID}'`);
    // Regression: the host-task branch was a plain double-quoted string nested
    // in a template literal, so the placeholder reached the agent verbatim.
    expect(parsed.message).not.toContain('${obligationId}');
  });

  it('keeps the findings-submission instruction for non-host-task policies', () => {
    const parsed = JSON.parse(formatMissingContentAnalysis(OBLIGATION_ID, false)) as {
      message: string;
    };

    expect(parsed.message).toContain(REVIEWER_SUBAGENT_TYPE);
    expect(parsed.message).toContain('complete ReviewFindings object');
    expect(parsed.message).not.toContain('${obligationId}');
    expect(parsed.message).not.toContain('reviewObligationId');
  });
});
