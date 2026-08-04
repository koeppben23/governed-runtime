import { describe, expect, it } from 'vitest';
import { normalizeFindingsChallenges } from './challenge-binding.js';

describe('host-authoritative challenge evidence references', () => {
  const canonical = {
    kind: 'plan_adr_section',
    artifactKind: 'adr',
    artifactDigest: 'a'.repeat(64),
    sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Decision' }],
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
                ...canonical,
                sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Hallucinated' }],
              },
            ],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [canonical],
    );
    expect(result).not.toHaveProperty('bindOutcome');
    if ('findings' in result) {
      const challenges = result.findings.challenges as Array<Record<string, unknown>>;
      expect(challenges[0]?.evidenceRefs).toEqual([canonical]);
    }
  });

  it('rejects evidence references unknown to the host contract', () => {
    const result = normalizeFindingsChallenges(
      {
        challenges: [
          {
            clientReference: 'c1',
            kind: 'design_challenge',
            evidenceRefs: [{ ...canonical, artifactDigest: 'b'.repeat(64) }],
          },
        ],
      },
      'obligation-1',
      'child-1',
      [canonical],
    );
    expect(result).toMatchObject({ bindOutcome: 'challenge_evidence_unknown' });
  });
});
