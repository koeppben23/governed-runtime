/**
 * @module integration/review/challenge-contract-render.test
 * @description Reviewer-facing projection of the offered challenge evidence refs.
 *
 * The offered refs are rendered exactly once as a numbered whitelist (Ref 1 to
 * Ref N, in offer order); prose cites them by number and the structured
 * serialization expands the number to the exact offered object. The shape
 * example cites exactly one offered ref that fits the challenge kind. A
 * falsification that finds no violation is stated as a valid result.
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
  const cases: ReadonlyArray<
    readonly [
      NonNullable<ReviewerChallengePromptContract['requiredChallengeKind']>,
      readonly Record<string, unknown>[],
      readonly Record<string, unknown>[],
    ]
  > = [
    // A passing implementation challenge needs BOTH evidence classes, so its
    // shape example cites the fitting execution ref AND the content ref.
    [
      'implementation_challenge',
      IMPLEMENTATION_REFS,
      [IMPLEMENTATION_REFS[1]!, IMPLEMENTATION_REFS[0]!],
    ],
    ['design_challenge', PLAN_REFS, [PLAN_REFS[0]!]],
    ['content_challenge', CONTENT_REFS, [CONTENT_REFS[0]!]],
  ];
  it.each(cases)(
    'lists every offered ref once and cites the fitting example refs for %s',
    (kind, refs, expectedExample) => {
      const { lines, text, example } = render({
        requiredChallengeCount: 1,
        requiredChallengeKind: kind,
        evidenceRefs: refs,
      });

      expect(example.evidenceRefs).toEqual(expectedExample);
      expect(text).toContain(
        `- Offered evidenceRefs (${refs.length}): the only admissible refs, numbered Ref 1 to Ref ${refs.length}.`,
      );
      refs.forEach((ref, index) => {
        expect(lines).toContain(`  Ref ${index + 1}: ${JSON.stringify(ref)}`);
        const expectedCount = expectedExample.includes(ref) ? 2 : 1;
        expect(occurrences(text, JSON.stringify(ref))).toBe(expectedCount);
      });
      expect(text).not.toContain('No usable evidence reference was supplied');
    },
  );

  it('tells the prose to cite refs by number and the serialization to expand them', () => {
    const { lines, text } = render({
      requiredChallengeCount: 1,
      requiredChallengeKind: 'design_challenge',
      evidenceRefs: PLAN_REFS,
    });
    const cite =
      '- In your review prose, cite offered refs only by number (e.g. "Ref 2"); never restate their digests, section paths, attempt IDs, or objects.';
    const expand =
      '- The structured serialization expands each cited number to the exact offered object. Never invent or alter a digest, sectionPath, or attemptId.';
    expect(lines).toContain(cite);
    expect(lines).toContain(expand);
    // The number is a presentation of the offer order, never a new identity.
    PLAN_REFS.forEach((ref, index) => {
      const line = lines.find((item) => item.startsWith(`  Ref ${index + 1}: `))!;
      expect(JSON.parse(line.slice(`  Ref ${index + 1}: `.length))).toEqual(ref);
    });
    expect(text).not.toContain('Copy each cited evidenceRef exactly');
  });

  it('states a no-violation falsification as a valid result next to the outcome rule', () => {
    const { lines } = render({
      requiredChallengeCount: 1,
      requiredChallengeKind: 'design_challenge',
      evidenceRefs: PLAN_REFS,
    });
    const outcome = lines.findIndex((line) => line.startsWith('- Required field: outcome.'));
    expect(outcome).toBeGreaterThan(-1);
    expect(lines[outcome + 1]).toBe(
      '- A falsification attempt that finds no violation is a complete, valid result: record the outcome stating that the claim held. The required challenge count is never a request to find or invent a defect.',
    );
  });

  it('states both evidence classes for passing implementation challenges only', () => {
    const rule =
      '- An implementation_challenge with outcome "pass" MUST cite BOTH evidence classes:';
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
    expect(text).not.toContain('cite offered refs only by number');
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
      details: { challengeIndex: 0, reason: 'validation_attempt_missing' },
    });
    expect(validate([IMPLEMENTATION_REFS[1]])).toMatchObject({
      ok: false,
      code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
      details: { challengeIndex: 0, reason: 'implementation_reference_missing' },
    });
  });
});
