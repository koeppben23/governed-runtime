import { describe, expect, it } from 'vitest';
import { renderReviewerTaskPrompt } from './prompt-builders.js';
import { reviewerPromptTypeForTask } from './reviewer-task-type.js';

const BASE = {
  iteration: 1,
  planVersion: 2,
  obligationId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: 'mandate-digest',
  criteriaVersion: 'criteria-v1',
  subjectLabel: 'the artifact under review',
};

const HEADINGS = [
  '### For Plans',
  '### For Implementations',
  '### For Architecture Decisions (ADRs)',
  '### Content Review (for /review flow)',
] as const;

function expectOnlyCriteria(prompt: string, expected: (typeof HEADINGS)[number]): void {
  for (const heading of HEADINGS) {
    if (heading === expected) expect(prompt).toContain(heading);
    else expect(prompt).not.toContain(heading);
  }
}

describe('reviewerPromptTypeForTask', () => {
  it.each([
    ['plan', 'plan'],
    ['implementation', 'implementation'],
    ['implement', 'implementation'],
    ['architecture', 'adr'],
    ['review', 'content'],
  ] as const)('maps %s to %s', (kind, expected) => {
    expect(reviewerPromptTypeForTask(kind)).toBe(expected);
  });
});

describe('renderReviewerTaskPrompt phase criteria', () => {
  it('selects plan criteria from the frozen artifact contract when legacy callers omit reviewType', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE,
      artifactAnchorContract: ['- artifactKind MUST be "plan"'],
      challengeContract: {
        requiredChallengeCount: 1,
        requiredChallengeKind: 'design_challenge',
        evidenceRefs: [{ kind: 'plan_adr_section' }],
      },
    });
    expectOnlyCriteria(prompt, '### For Plans');
  });

  it('selects implementation criteria from the host-enforced implementation contract', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE,
      implementationAnchorContract: ['## Implementation Subject Anchor Contract (host-enforced)'],
      challengeContract: {
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        evidenceRefs: [{ kind: 'implementation' }],
      },
    });
    expectOnlyCriteria(prompt, '### For Implementations');
  });

  it('selects ADR criteria from the frozen artifact contract', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE,
      artifactAnchorContract: ['- artifactKind MUST be "adr"'],
      challengeContract: {
        requiredChallengeCount: 1,
        requiredChallengeKind: 'design_challenge',
        evidenceRefs: [{ kind: 'plan_adr_section' }],
      },
    });
    expectOnlyCriteria(prompt, '### For Architecture Decisions (ADRs)');
  });

  it('selects content criteria from the content challenge contract', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE,
      challengeContract: {
        requiredChallengeCount: 1,
        requiredChallengeKind: 'content_challenge',
        evidenceRefs: [{ kind: 'content' }],
      },
    });
    expectOnlyCriteria(prompt, '### Content Review (for /review flow)');
  });

  it('honors an explicit runtime reviewType before fallback inference', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE,
      reviewType: 'plan',
      implementationAnchorContract: ['## Implementation Subject Anchor Contract (host-enforced)'],
    });
    expectOnlyCriteria(prompt, '### For Plans');
  });
});
