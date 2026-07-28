import { describe, it, expect } from 'vitest';
import { validateChallengeConsistency } from './challenge-consistency.js';

// #747: canonical challenge/resolution consistency authority. Separate from the
// F12 verdict/blocking-issues rule (findings-consistency). This matrix pins
// count, kind, evidence, distinctness, outcome, and resolution-verdict gating.
describe('review/enforcement/challenge-consistency', () => {
  describe('challenge matrix', () => {
    const implementationChallenge = {
      kind: 'implementation_challenge',
      evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
      outcome: 'pass',
    };
    // A substantively distinct second implementation challenge (different
    // evidence) so a required count of 2 is not tripped by the anti-gaming
    // distinctness guard.
    const implementationChallenge2 = {
      kind: 'implementation_challenge',
      evidenceRefs: [
        { kind: 'implementation' },
        { kind: 'validation_attempt', attemptId: 'second' },
      ],
      outcome: 'pass',
    };

    it('accepts the required HIGH-RISK implementation coverage', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 2,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [implementationChallenge, implementationChallenge2],
        }),
      ).toEqual({ ok: true });
    });

    it('reports required and actual counts on a count mismatch', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 2,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [implementationChallenge],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_COUNT_INCOHERENT',
        details: { required: 2, actual: 1 },
      });
    });

    it('rejects missing count, wrong kind, missing evidence, and failed implementation evidence', () => {
      for (const challenges of [
        [implementationChallenge],
        [{ ...implementationChallenge, kind: 'design_challenge' }],
        [{ ...implementationChallenge, evidenceRefs: [] }],
        [{ ...implementationChallenge, outcome: 'not_verified' }],
      ]) {
        expect(
          validateChallengeConsistency({
            overallVerdict: 'accept',
            requiredChallengeCount: 2,
            requiredChallengeKind: 'implementation_challenge',
            challenges,
          }).ok,
        ).toBe(false);
      }
    });

    it('rejects a passing implementation challenge without validation-attempt evidence', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [{ ...implementationChallenge, evidenceRefs: [{ kind: 'implementation' }] }],
        }),
      ).toMatchObject({ ok: false, code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING' });
    });

    it('rejects evidence and obligation identifiers outside the active contract', () => {
      const allowedEvidenceRefs = [
        { kind: 'implementation', implementationDigest: 'current-digest' },
        { kind: 'validation_attempt', attemptId: '00000000-0000-4000-8000-000000000002' },
      ];
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        expectedObligationId: '00000000-0000-4000-8000-000000000001',
        allowedEvidenceRefs,
        challenges: [
          {
            obligationId: '00000000-0000-4000-8000-000000000001',
            ...implementationChallenge,
            evidenceRefs: [
              { kind: 'implementation', implementationDigest: 'foreign-digest' },
              { kind: 'validation_attempt', attemptId: '00000000-0000-4000-8000-000000000002' },
            ],
          },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        details: { reason: 'evidence_mismatch' },
      });
    });

    it('rejects an author resolution without a later independent resolved verdict', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 0,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [],
        unresolvedImplementationChallengeIds: ['00000000-0000-4000-8000-000000000001'],
        resolutionVerdicts: [
          { challengeId: '00000000-0000-4000-8000-000000000001', verdict: 'not_verified' },
        ],
      });
      expect(result.ok).toBe(false);
    });

    it('accepts a failed implementation challenge with changes_requested', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'changes_requested',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [{ ...implementationChallenge, outcome: 'fail' }],
        }),
      ).toEqual({ ok: true });
    });

    it('rejects accept when a design challenge falsification is contradicted (B4)', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'design_challenge',
        challenges: [
          {
            kind: 'design_challenge',
            outcome: 'contradicted',
            claim: 'The chosen option does not satisfy the stated latency constraint.',
            locations: ['ADR: Decision'],
            evidenceRefs: [{ kind: 'plan_adr_section' }],
          },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_CONTRADICTED',
        details: { kind: 'design_challenge', outcome: 'contradicted' },
      });
    });

    it('rejects accept when a content challenge falsification is contradicted (B4)', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'content_challenge',
        challenges: [
          {
            kind: 'content_challenge',
            outcome: 'contradicted',
            claim: 'The diff introduces a SQL injection on the search endpoint.',
            locations: ['src/search.ts:20'],
            evidenceRefs: [{ kind: 'content' }],
          },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_CONTRADICTED',
      });
    });

    it('accepts a contradicted design challenge under changes_requested', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'changes_requested',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'design_challenge',
          challenges: [
            {
              kind: 'design_challenge',
              outcome: 'contradicted',
              claim: 'The chosen option does not satisfy the stated latency constraint.',
              locations: ['ADR: Decision'],
              evidenceRefs: [{ kind: 'plan_adr_section' }],
            },
          ],
        }),
      ).toEqual({ ok: true });
    });

    it('accepts a supported design challenge (falsification failed → artifact holds)', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'design_challenge',
          challenges: [
            {
              kind: 'design_challenge',
              outcome: 'supported',
              claim: 'The chosen option satisfies the stated latency constraint.',
              locations: ['ADR: Decision'],
              evidenceRefs: [{ kind: 'plan_adr_section' }],
            },
          ],
        }),
      ).toEqual({ ok: true });
    });

    it('accepts unable_to_review with no challenges when no evidence is available', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'unable_to_review',
          requiredChallengeCount: 2,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
        }),
      ).toEqual({ ok: true });
    });

    it('rejects unable_to_review with fabricated evidence references', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'unable_to_review',
        requiredChallengeCount: 2,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [{ ...implementationChallenge, evidenceRefs: [] }],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
      });
    });

    it('rejects unable_to_review with foreign evidence references', () => {
      const allowedRefs = [{ kind: 'implementation', implementationDigest: 'allowed-digest' }];
      const result = validateChallengeConsistency({
        overallVerdict: 'unable_to_review',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        allowedEvidenceRefs: allowedRefs,
        challenges: [
          {
            ...implementationChallenge,
            evidenceRefs: [
              { kind: 'implementation', implementationDigest: 'foreign-digest' },
              { kind: 'validation_attempt' },
            ],
          },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        details: { reason: 'evidence_mismatch' },
      });
    });

    // ── Isolated per-branch negative paths (each pins exactly one guard so a
    //    mutation of that guard cannot survive behind an earlier check). ──

    it('rejects a challenge whose obligationId differs from the expected obligation', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        expectedObligationId: '00000000-0000-4000-8000-000000000001',
        challenges: [
          { obligationId: '00000000-0000-4000-8000-0000000000ff', ...implementationChallenge },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        details: { reason: 'obligation_mismatch' },
      });
    });

    it('accepts when obligationId matches the expected obligation', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          expectedObligationId: '00000000-0000-4000-8000-000000000001',
          challenges: [
            { obligationId: '00000000-0000-4000-8000-000000000001', ...implementationChallenge },
          ],
        }),
      ).toEqual({ ok: true });
    });

    it('rejects a wrong-kind challenge when the count already matches', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [{ ...implementationChallenge, kind: 'design_challenge' }],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_KIND_INCOHERENT',
        details: { required: 'implementation_challenge', actual: 'design_challenge' },
      });
    });

    it('does not enforce kind when requiredChallengeCount is 0 (kind guard is count-gated)', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
        }),
      ).toEqual({ ok: true });
    });

    it('rejects optional challenges when the frozen requirement count is 0', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'changes_requested',
        requiredChallengeCount: 0,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [{ ...implementationChallenge, outcome: 'fail' }],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_COUNT_INCOHERENT',
        details: { required: 0, actual: 1 },
      });
    });

    it('rejects a passing implementation challenge whose only evidence is non-validation-attempt', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'changes_requested',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [
          {
            kind: 'implementation_challenge',
            outcome: 'pass',
            evidenceRefs: [{ kind: 'implementation' }],
          },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        details: { required: 'validation_attempt' },
      });
    });

    it('does not require validation-attempt evidence when outcome is not pass', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'changes_requested',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [
            {
              kind: 'implementation_challenge',
              outcome: 'fail',
              evidenceRefs: [{ kind: 'implementation' }],
            },
          ],
        }),
      ).toEqual({ ok: true });
    });

    it('rejects accept when a required implementation challenge outcome is fail', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [{ ...implementationChallenge, outcome: 'fail' }],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
        details: { outcome: 'fail' },
      });
    });

    it('rejects accept when a required implementation challenge outcome is not_verified', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [{ ...implementationChallenge, outcome: 'not_verified' }],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
        details: { outcome: 'not_verified' },
      });
    });
  });

  describe('anti-gaming distinctness and placeholder floor (B1/B2)', () => {
    const base = {
      kind: 'implementation_challenge' as const,
      outcome: 'pass' as const,
      scenario: 'A concurrent duplicate event arrives during retry processing.',
      claim: 'The null branch is not covered by the delivered guard.',
      locations: ['src/foo.ts:10'],
    };

    it('rejects two challenges with an identical substance signature', () => {
      const dup = {
        ...base,
        challengeId: '00000000-0000-4000-8000-00000000000a',
        evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
      };
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 2,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [
          dup,
          { ...dup, challengeId: '00000000-0000-4000-8000-00000000000b' }, // only the id differs
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_NOT_DISTINCT',
        details: { reason: 'duplicate_substance' },
      });
    });

    it('rejects two challenges that reuse the same challengeId', () => {
      const c = {
        ...base,
        challengeId: '00000000-0000-4000-8000-00000000000c',
        evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
      };
      const c2 = {
        ...base,
        challengeId: '00000000-0000-4000-8000-00000000000c', // same id
        claim: 'A different concrete claim about the retry path behavior.',
        evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt', attemptId: 'x' }],
      };
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 2,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [c, c2],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_NOT_DISTINCT',
        details: { reason: 'duplicate_challenge_id' },
      });
    });

    it('rejects a fresh challenge that reuses an ID from an earlier review iteration', () => {
      const challengeId = '00000000-0000-4000-8000-00000000000f';
      const result = validateChallengeConsistency({
        overallVerdict: 'changes_requested',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [
          {
            ...base,
            challengeId,
            evidenceRefs: [{ kind: 'implementation' }],
          },
        ],
        previouslyUsedChallengeIds: [challengeId],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_NOT_DISTINCT',
        details: { reason: 'historical_challenge_id_reused', challengeId },
      });
    });

    it('accepts a fresh challenge ID when earlier review IDs differ', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'changes_requested',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [
            {
              ...base,
              challengeId: '00000000-0000-4000-8000-000000000010',
              evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
            },
          ],
          previouslyUsedChallengeIds: ['00000000-0000-4000-8000-00000000000f'],
        }),
      ).toEqual({ ok: true });
    });

    it('accepts two substantively distinct challenges', () => {
      const c1 = {
        ...base,
        challengeId: '00000000-0000-4000-8000-00000000000d',
        evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
      };
      const c2 = {
        ...base,
        challengeId: '00000000-0000-4000-8000-00000000000e',
        claim: 'The concurrency guard does not cover the second writer.',
        locations: ['src/bar.ts:42'],
        evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt', attemptId: 'y' }],
      };
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 2,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [c1, c2],
        }),
      ).toEqual({ ok: true });
    });

    it('accepts two challenges that test the SAME claim/locations/evidence via DIFFERENT scenarios (#747)', () => {
      // #747 treats scenario as a first-class falsification property: two distinct
      // scenarios independently testing the same claim are NOT duplicates.
      const shared = {
        kind: 'implementation_challenge' as const,
        outcome: 'pass' as const,
        claim: 'Retry processing is idempotent.',
        locations: ['src/retry.ts:12'],
        evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
      };
      const scenarioA = {
        ...shared,
        challengeId: '00000000-0000-4000-8000-0000000000a1',
        scenario: 'A duplicate event arrives concurrently.',
      };
      const scenarioB = {
        ...shared,
        challengeId: '00000000-0000-4000-8000-0000000000a2',
        scenario: 'The process crashes after the side effect but before acknowledgement.',
      };
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 2,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [scenarioA, scenarioB],
        }),
      ).toEqual({ ok: true });
    });

    it('accepts a short but non-empty claim (no length-based policy in the consistency authority)', () => {
      // The old 12-char threshold was an unapproved review policy inside the
      // consistency authority (#747: requirements come from the frozen matrix).
      // A short, precise claim like "No rollback" must pass.
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [
            {
              ...base,
              claim: 'No rollback',
              evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
            },
          ],
        }),
      ).toEqual({ ok: true });
    });

    it('rejects a whitespace-only required field (structural placeholder floor)', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [
          {
            ...base,
            claim: '   ', // whitespace-only placeholder
            evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
          },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_INSUBSTANTIAL',
        details: { reason: 'empty_field', field: 'claim' },
      });
    });

    it('rejects a challenge whose locations contain a whitespace-only entry', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [
          {
            ...base,
            locations: ['   '],
            evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
          },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_CHALLENGE_INSUBSTANTIAL',
        details: { reason: 'empty_field', field: 'locations' },
      });
    });

    it('does not apply the floor when optional fields are absent (reduced callers/fixtures)', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [
            {
              kind: 'implementation_challenge',
              outcome: 'pass',
              evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
            },
          ],
        }),
      ).toEqual({ ok: true });
    });
  });

  describe('resolution verdict gating by overallVerdict', () => {
    const OPEN_ID = '00000000-0000-4000-8000-000000000001';
    const OTHER_ID = '00000000-0000-4000-8000-000000000002';
    const challenge = {
      kind: 'implementation_challenge' as const,
      evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
      outcome: 'pass' as const,
    };

    it('accepts unable_to_review with prior unresolved challenge and no resolution verdict', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'unable_to_review',
          requiredChallengeCount: 2,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
          unresolvedImplementationChallengeIds: [OPEN_ID],
        }),
      ).toEqual({ ok: true });
    });

    it('accepts unable_to_review with prior unresolved challenge and not_verified verdict', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'unable_to_review',
          requiredChallengeCount: 2,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
          unresolvedImplementationChallengeIds: [OPEN_ID],
          resolutionVerdicts: [{ challengeId: OPEN_ID, verdict: 'not_verified' }],
        }),
      ).toEqual({ ok: true });
    });

    it.each(['resolved', 'still_failing'])(
      'rejects unable_to_review with a %s resolution verdict',
      (verdict) => {
        expect(
          validateChallengeConsistency({
            overallVerdict: 'unable_to_review',
            requiredChallengeCount: 2,
            requiredChallengeKind: 'implementation_challenge',
            challenges: [],
            unresolvedImplementationChallengeIds: [OPEN_ID],
            resolutionVerdicts: [{ challengeId: OPEN_ID, verdict }],
          }),
        ).toMatchObject({
          ok: false,
          code: 'SUBAGENT_RESOLUTION_VERDICT_INCOHERENT',
          details: { challengeId: OPEN_ID, overallVerdict: 'unable_to_review', verdict },
        });
      },
    );

    it('accepts changes_requested with prior unresolved challenge and still_failing verdict', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'changes_requested',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
          unresolvedImplementationChallengeIds: [OPEN_ID],
          resolutionVerdicts: [{ challengeId: OPEN_ID, verdict: 'still_failing' }],
        }),
      ).toEqual({ ok: true });
    });

    it('rejects changes_requested when prior unresolved challenge has no verdict', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'changes_requested',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
          unresolvedImplementationChallengeIds: [OPEN_ID],
        }).ok,
      ).toBe(false);
    });

    it('rejects accept with prior unresolved challenge and still_failing verdict', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [challenge],
        unresolvedImplementationChallengeIds: [OPEN_ID],
        resolutionVerdicts: [{ challengeId: OPEN_ID, verdict: 'still_failing' }],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
        details: { verdict: 'still_failing' },
      });
    });

    it('rejects accept with prior unresolved challenge and no verdict', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [challenge],
        unresolvedImplementationChallengeIds: [OPEN_ID],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
        details: { reason: 'no resolution verdict' },
      });
    });

    it('accepts when a prior unresolved challenge has an independent resolved verdict', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [challenge],
          unresolvedImplementationChallengeIds: [OPEN_ID],
          resolutionVerdicts: [{ challengeId: OPEN_ID, verdict: 'resolved' }],
        }),
      ).toEqual({ ok: true });
    });

    it('accepts when there are no prior unresolved challenges (early-return path)', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [challenge],
          unresolvedImplementationChallengeIds: [],
        }),
      ).toEqual({ ok: true });
    });

    // ── #747 exact/unique/scope-bound resolution gating (Blocker 1) ──

    it('rejects a duplicate resolution verdict for the same challenge id', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'changes_requested',
        requiredChallengeCount: 0,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [],
        unresolvedImplementationChallengeIds: [OPEN_ID],
        resolutionVerdicts: [
          { challengeId: OPEN_ID, verdict: 'still_failing' },
          { challengeId: OPEN_ID, verdict: 'resolved' },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_RESOLUTION_VERDICT_DUPLICATE',
        details: { challengeId: OPEN_ID },
      });
    });

    it('rejects a resolution verdict for an unknown / out-of-scope challenge id', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'changes_requested',
        requiredChallengeCount: 0,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [],
        unresolvedImplementationChallengeIds: [OPEN_ID],
        resolutionVerdicts: [
          { challengeId: OPEN_ID, verdict: 'still_failing' },
          { challengeId: OTHER_ID, verdict: 'resolved' }, // not an open challenge
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_RESOLUTION_VERDICT_UNKNOWN',
        details: { challengeId: OTHER_ID },
      });
    });

    it('rejects an unable_to_review verdict that references an unknown challenge id', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'unable_to_review',
        requiredChallengeCount: 0,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [],
        unresolvedImplementationChallengeIds: [OPEN_ID],
        resolutionVerdicts: [{ challengeId: OTHER_ID, verdict: 'resolved' }],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_RESOLUTION_VERDICT_UNKNOWN',
        details: { challengeId: OTHER_ID },
      });
    });

    it('rejects resolution verdicts when there is no open challenge at all', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [challenge],
        unresolvedImplementationChallengeIds: [],
        resolutionVerdicts: [{ challengeId: OPEN_ID, verdict: 'resolved' }],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_RESOLUTION_VERDICT_UNEXPECTED',
        details: { supplied: 1 },
      });
    });
  });

  describe('prior-failure gate — author resolution never acts as closure (#747)', () => {
    const OPEN_ID = '00000000-0000-4000-8000-000000000001';
    const UNADDRESSED = '00000000-0000-4000-8000-0000000000f0';

    it('blocks accept while a prior failing challenge has no author resolution', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 0,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [],
        unresolvedImplementationChallengeIds: [],
        unaddressedPriorFailIds: [UNADDRESSED],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED',
        details: { unaddressed: 1, challengeId: UNADDRESSED },
      });
    });

    it('allows changes_requested while a prior failing challenge is unaddressed (loop stays open)', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'changes_requested',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
          unresolvedImplementationChallengeIds: [],
          unaddressedPriorFailIds: [UNADDRESSED],
        }),
      ).toEqual({ ok: true });
    });

    it('allows unable_to_review while a prior failing challenge is unaddressed', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'unable_to_review',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
          unresolvedImplementationChallengeIds: [],
          unaddressedPriorFailIds: [UNADDRESSED],
        }),
      ).toEqual({ ok: true });
    });

    it('blocks accept even when the addressed challenge carries a resolved verdict, if another prior fail is unaddressed', () => {
      // The author resolved OPEN_ID (→ targeted, reviewer says resolved) but a
      // second prior failure remains unaddressed: acceptance must still fail closed.
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 0,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [],
        unresolvedImplementationChallengeIds: [OPEN_ID],
        unaddressedPriorFailIds: [UNADDRESSED],
        resolutionVerdicts: [{ challengeId: OPEN_ID, verdict: 'resolved' }],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED',
      });
    });

    it('allows accept when all prior failures are addressed and the targeted challenge is independently resolved', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
          unresolvedImplementationChallengeIds: [OPEN_ID],
          unaddressedPriorFailIds: [],
          resolutionVerdicts: [{ challengeId: OPEN_ID, verdict: 'resolved' }],
        }),
      ).toEqual({ ok: true });
    });
  });
});
