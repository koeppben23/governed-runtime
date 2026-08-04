import { describe, expect, it } from 'vitest';
import { normalizeFindingsChallenges } from './challenge-binding.js';

describe('host-authoritative challenge evidence references', () => {
  const planAdrSection = {
    kind: 'plan_adr_section',
    artifactKind: 'adr',
    artifactDigest: 'a'.repeat(64),
    sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Decision' }],
  };
  const implementation = {
    kind: 'implementation',
    implementationDigest: 'b'.repeat(64),
  };
  const content = {
    kind: 'content',
    digest: 'c'.repeat(64),
  };

  it('replaces reviewer heading text with the canonical host reference', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'design_challenge',
            evidenceRefs: [
              {
                ...planAdrSection,
                sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Hallucinated' }],
              },
            ],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [planAdrSection],
    );
    expect(result).not.toHaveProperty('bindOutcome');
    if ('findings' in result) {
      const challenges = result.findings.challenges as Array<Record<string, unknown>>;
      expect(challenges[0]?.evidenceRefs).toEqual([planAdrSection]);
    }
  });

  it('rejects evidence references unknown to the host contract', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'design_challenge',
            evidenceRefs: [{ ...planAdrSection, artifactDigest: 'b'.repeat(64) }],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [planAdrSection],
    );
    expect(result).toMatchObject({ bindOutcome: 'challenge_evidence_unknown' });
  });

  it('resolves implementation refs by implementationDigest', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'implementation_challenge',
            evidenceRefs: [{ kind: 'implementation', implementationDigest: 'b'.repeat(64) }],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [implementation],
    );
    expect(result).not.toHaveProperty('bindOutcome');
    if ('findings' in result) {
      const challenges = result.findings.challenges as Array<Record<string, unknown>>;
      expect(challenges[0]?.evidenceRefs).toEqual([implementation]);
    }
  });

  it('resolves content refs by digest', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'content_challenge',
            evidenceRefs: [{ kind: 'content', digest: 'c'.repeat(64) }],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [content],
    );
    expect(result).not.toHaveProperty('bindOutcome');
    if ('findings' in result) {
      const challenges = result.findings.challenges as Array<Record<string, unknown>>;
      expect(challenges[0]?.evidenceRefs).toEqual([content]);
    }
  });

  it('rejects unknown content ref digest', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'content_challenge',
            evidenceRefs: [{ kind: 'content', digest: 'd'.repeat(64) }],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [content],
    );
    expect(result).toMatchObject({ bindOutcome: 'challenge_evidence_unknown' });
  });

  it('accepts implementation_challenge with missing outcome (no pass check needed)', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'implementation_challenge',
            evidenceRefs: [{ kind: 'implementation', implementationDigest: 'b'.repeat(64) }],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [implementation],
    );
    expect(result).not.toHaveProperty('bindOutcome');
  });

  it('passes through challenges unchanged when no allowedEvidenceRefs are supplied', () => {
    const reviewerRef = {
      kind: 'plan_adr_section',
      artifactKind: 'adr',
      artifactDigest: 'a'.repeat(64),
      sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Decision' }],
    };
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'design_challenge',
            evidenceRefs: [reviewerRef],
          },
        ],
      },
      'obligation-1',
      'child-1',
      undefined,
    );
    expect(result).not.toHaveProperty('bindOutcome');
    if ('findings' in result) {
      const challenges = result.findings.challenges as Array<Record<string, unknown>>;
      expect(challenges[0]?.evidenceRefs).toEqual([reviewerRef]);
    }
  });

  it('rejects unknown ref kind without crashing', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'design_challenge',
            evidenceRefs: [{ kind: 'unknown_kind', someField: 'value' }],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [implementation],
    );
    expect(result).toMatchObject({ bindOutcome: 'challenge_evidence_unknown' });
  });

  it('ignores plan_adr_section sectionPath headingText in identity comparison', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'design_challenge',
            evidenceRefs: [
              {
                ...planAdrSection,
                sectionPath: [
                  {
                    headingDepth: 2,
                    siblingIndex: 1,
                    headingText: '1. Add null-check to `TaskService.updateTask()`',
                  },
                ],
              },
            ],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [planAdrSection],
    );
    expect(result).not.toHaveProperty('bindOutcome');
    if ('findings' in result) {
      const challenges = result.findings.challenges as Array<Record<string, unknown>>;
      expect(challenges[0]?.evidenceRefs).toEqual([planAdrSection]);
    }
  });

  it('rejects a challenge with a reviewer-supplied heading depth mismatch', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'design_challenge',
            evidenceRefs: [
              {
                ...planAdrSection,
                sectionPath: [{ headingDepth: 3, siblingIndex: 1, headingText: 'Decision' }],
              },
            ],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [planAdrSection],
    );
    expect(result).toMatchObject({ bindOutcome: 'challenge_evidence_unknown' });
  });
});
