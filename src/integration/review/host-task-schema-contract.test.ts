import { describe, expect, it } from 'vitest';
import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { buildTextCompatReviewerPrompt, renderReviewerTaskPrompt } from './prompt-builders.js';

const BASE_INPUT = {
  iteration: 0,
  planVersion: 1,
  obligationId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: 'mandate-digest',
  criteriaVersion: 'criteria-v1',
  subjectLabel: 'the artifact under review',
};

describe('host-task reviewer serialization contract', () => {
  it('embeds the canonical ReviewFindings schema in every text host-task prompt', () => {
    const prompt = buildTextCompatReviewerPrompt(renderReviewerTaskPrompt(BASE_INPUT));

    expect(prompt).toContain('## Text Compatibility Serialization Contract');
    expect(prompt).toContain(JSON.stringify(REVIEW_FINDINGS_JSON_SCHEMA, null, 2));
    for (const field of REVIEW_FINDINGS_JSON_SCHEMA.required) {
      expect(prompt).toContain(`"${field}"`);
    }
  });

  it('makes challenge nesting explicit instead of leaving wrapper shape to model inference', () => {
    const prompt = buildTextCompatReviewerPrompt(
      renderReviewerTaskPrompt({
        ...BASE_INPUT,
        challengeContract: {
          requiredChallengeCount: 1,
          requiredChallengeKind: 'design_challenge',
          evidenceRefs: [
            {
              kind: 'plan_adr_section',
              artifactKind: 'plan',
              artifactDigest: 'a'.repeat(64),
              sectionPath: [
                { headingDepth: 1, siblingIndex: 1, headingText: 'Implementation Plan' },
              ],
              excerptDigest: 'b'.repeat(64),
            },
          ],
        },
      }),
    );

    expect(prompt).toContain('challenges belong in the top-level challenges array');
    expect(prompt).toContain(
      'never invent wrapper objects such as nonBlockingIssues or designChallenges',
    );
    expect(REVIEW_FINDINGS_JSON_SCHEMA.properties).toHaveProperty('challenges');
    expect(REVIEW_FINDINGS_JSON_SCHEMA.properties).not.toHaveProperty('nonBlockingIssues');
  });

  it('keeps the full canonical schema on output-repair prompts', () => {
    const prompt = buildTextCompatReviewerPrompt(
      renderReviewerTaskPrompt({
        ...BASE_INPUT,
        retrySchemaErrors: [
          'majorRisks: Invalid input: expected array, received undefined',
          'nonBlockingIssues.designChallenges: Unrecognized keys: "nonBlockingIssues", "designChallenges"',
        ],
      }),
    );

    expect(prompt).toContain('### Prior Output Rejected — Schema Validation Errors');
    expect(prompt).toContain('majorRisks: Invalid input: expected array, received undefined');
    expect(prompt).toContain('nonBlockingIssues.designChallenges');
    expect(prompt).toContain(JSON.stringify(REVIEW_FINDINGS_JSON_SCHEMA, null, 2));
  });
});
