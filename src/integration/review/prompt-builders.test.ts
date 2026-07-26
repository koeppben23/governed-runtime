import { describe, expect, it } from 'vitest';
import { renderReviewerTaskPrompt } from './prompt-builders.js';

const BASE_INPUT = {
  iteration: 0,
  planVersion: 1,
  obligationId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: 'mandate-digest',
  criteriaVersion: 'criteria-v1',
  subjectLabel: 'the artifact under review',
};

describe('renderReviewerTaskPrompt challenge contract', () => {
  it('requires omitting optional challenges when the frozen count is zero', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      challengeContract: { requiredChallengeCount: 0, requiredChallengeKind: 'design_challenge' },
    });

    expect(prompt).toContain('requiredChallengeCount=0');
    expect(prompt).toContain('Omit the optional challenges field entirely');
  });

  it('provides only host-authoritative evidence for required challenges', () => {
    const evidenceRef = {
      kind: 'plan_adr_section',
      artifactKind: 'adr',
      artifactDigest: 'adr-digest',
      sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Decision' }],
      excerptDigest: 'excerpt-digest',
    };
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      challengeContract: {
        requiredChallengeCount: 1,
        requiredChallengeKind: 'design_challenge',
        evidenceInstructions: [JSON.stringify(evidenceRef)],
      },
    });

    expect(prompt).toContain('return exactly 1 design_challenge challenge(s)');
    expect(prompt).toContain(JSON.stringify(evidenceRef));
    expect(prompt).toContain('Do not invent or alter a digest, sectionPath, or attemptId');
  });
});
