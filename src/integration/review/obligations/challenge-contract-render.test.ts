/**
 * @module integration/review/challenge-contract-render.test
 * @description Reviewer-facing projection of the offered challenge evidence refs.
 *
 * The offered refs are rendered exactly once as a numbered whitelist; the
 * shape example cites exactly one offered ref that fits the challenge kind.
 * The validator is unchanged: any non-empty subset of offered refs binds, a
 * ref outside the offer is rejected.
 */

import { describe, expect, it } from 'vitest';
import { validateChallengeConsistency } from '../enforcement/challenge-consistency.js';
import {
  renderReviewChallengeContract,
  type ReviewerChallengePromptContract,
} from './challenge-contract.js';

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);

const IMPLEMENTATION_REFS = [
  { kind: 'implementation', implementationDigest: DIGEST },
  { kind: 'validation_attempt', attemptId: '22222222-2222-4222-8222-222222222222' },
  { kind: 'validation_attempt', attemptId: '33333333-3333-4333-8333-333333333333' },
];

function section(index: number, headingText: string) {
  return {
    kind: 'plan_adr_section',
    artifactKind: 'plan',
    artifactDigest: DIGEST,
    sectionPath: [{ headingDepth: 2, siblingIndex: index, headingText }],
    excerptDigest: String(index).repeat(64),
  };
}

const PLAN_REFS = [section(1, 'Goal'), section(2, 'Approach'), section(3, 'Verification')];
const CONTENT_REFS = [{ kind: 'content', digest: DIGEST }];

function render(contract: ReviewerChallengePromptContract) {
  const lines = renderReviewChallengeContract(contract, OBLIGATION_ID);
  const shapeLine = lines.find((line) => line.startsWith('- Required challenge object shape: '));
  if (!shapeLine) throw new Error('expected a challenge shape line');
  const example = JSON.parse(shapeLine.slice('- Required challenge object shape: '.length)) as {
    evidenceRefs: Record<string, unknown>[];
  };
  return { lines, text: lines.join('\n'), example };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('renderReviewChallengeContract offered evidence refs', () => {
  it.each([
    ['implementation_challenge', IMPLEMENTATION_REFS, IMPLEMENTATION_REFS[1]],
    ['design_challenge', PLAN_REFS, PLAN_REFS[0]],
    ['content_challenge', CONTENT_REFS, CONTENT_REFS[0]],
  ] as const)(
    'lists every offered ref once and cites exactly one fitting ref for %s',
    (kind, refs, expectedExample) => {
      const { lines, text, example } = render({
        requiredChallengeCount: 1,
        requiredChallengeKind: kind,
        evidenceRefs: refs,
      });

      expect(example.evidenceRefs).toEqual([expectedExample]);
      expect(text).toContain(`- Offered evidenceRefs (${refs.length}): the only admissible refs.`);
      refs.forEach((ref, index) => {
        expect(lines).toContain(`  ${index + 1}. ${JSON.stringify(ref)}`);
        const expectedCount = ref === expectedExample ? 2 : 1;
        expect(occurrences(text, JSON.stringify(ref))).toBe(expectedCount);
      });
      expect(text).not.toContain('No usable evidence reference was supplied');
    },
  );

  it('states the validation_attempt requirement for passing implementation challenges only', () => {
    const rule =
      '- An implementation_challenge with outcome "pass" MUST cite at least one validation_attempt ref.';
    expect(
      render({
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        evidenceRefs: IMPLEMENTATION_REFS,
      }).lines,
    ).toContain(rule);
    expect(
      render({
        requiredChallengeCount: 1,
        requiredChallengeKind: 'design_challenge',
        evidenceRefs: PLAN_REFS,
      }).lines,
    ).not.toContain(rule);
  });

  it('falls back to the first offered ref and never synthesizes one', () => {
    const { example } = render({
      requiredChallengeCount: 1,
      requiredChallengeKind: 'design_challenge',
      evidenceRefs: [...CONTENT_REFS, IMPLEMENTATION_REFS[0]!],
    });
    expect(example.evidenceRefs).toEqual([CONTENT_REFS[0]]);
  });

  it('keeps the unable_to_review path when no ref is offered', () => {
    const { text, example } = render({
      requiredChallengeCount: 1,
      requiredChallengeKind: 'implementation_challenge',
      evidenceRefs: [],
    });
    expect(example.evidenceRefs).toEqual([]);
    expect(text).not.toContain('Offered evidenceRefs');
    expect(text).toContain('No usable evidence reference was supplied; return unable_to_review.');
  });

  it('binds the rendered example and any offered subset, and rejects a ref outside the offer', () => {
    const { example } = render({
      requiredChallengeCount: 1,
      requiredChallengeKind: 'implementation_challenge',
      evidenceRefs: IMPLEMENTATION_REFS,
    });
    const validate = (evidenceRefs: readonly unknown[]) =>
      validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        expectedObligationId: OBLIGATION_ID,
        allowedEvidenceRefs: IMPLEMENTATION_REFS,
        challenges: [
          {
            kind: 'implementation_challenge',
            obligationId: OBLIGATION_ID,
            outcome: 'pass',
            evidenceRefs,
          },
        ],
      });

    expect(validate(example.evidenceRefs)).toEqual({ ok: true });
    expect(validate([IMPLEMENTATION_REFS[0], IMPLEMENTATION_REFS[2]])).toEqual({ ok: true });
    expect(
      validate([{ kind: 'validation_attempt', attemptId: '44444444-4444-4444-8444-444444444444' }]),
    ).toMatchObject({
      ok: false,
      code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
      details: { reason: 'evidence_mismatch' },
    });
    expect(validate([IMPLEMENTATION_REFS[0]])).toMatchObject({
      ok: false,
      code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
      details: { reason: 'validation_attempt_missing' },
    });
  });
});
