import { describe, it, expect } from 'vitest';
import {
  validateChallengeConsistency,
  validateReviewFindingsConsistency,
} from './findings-consistency.js';

// F12: canonical verdict/blocking-issues coherence invariant (strict emptiness).
// This is the single source of truth for the rule; both ingestion boundaries
// delegate here. The matrix below fully pins the rule so a refactor cannot
// silently narrow or widen it.
describe('review/enforcement/findings-consistency', () => {
  describe('BAD — accept with any blocking issue is incoherent (strict emptiness)', () => {
    it('accept + 1 blocking issue → incoherent', () => {
      const result = validateReviewFindingsConsistency({
        overallVerdict: 'accept',
        blockingIssueCount: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected incoherent');
      expect(result.code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');
      expect(result.details).toEqual({ overallVerdict: 'accept', blockingIssueCount: 1 });
    });

    it('accept + many blocking issues → incoherent, count preserved', () => {
      const result = validateReviewFindingsConsistency({
        overallVerdict: 'accept',
        blockingIssueCount: 4,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected incoherent');
      expect(result.details.blockingIssueCount).toBe(4);
    });
  });

  describe('HAPPY — coherent combinations pass', () => {
    it('accept + 0 blocking issues → ok', () => {
      expect(
        validateReviewFindingsConsistency({ overallVerdict: 'accept', blockingIssueCount: 0 }),
      ).toEqual({ ok: true });
    });

    it('changes_requested + blocking issues → ok (non-accept verdicts are unconstrained)', () => {
      expect(
        validateReviewFindingsConsistency({
          overallVerdict: 'changes_requested',
          blockingIssueCount: 3,
        }),
      ).toEqual({ ok: true });
    });

    it('changes_requested + 0 blocking issues → ok', () => {
      expect(
        validateReviewFindingsConsistency({
          overallVerdict: 'changes_requested',
          blockingIssueCount: 0,
        }),
      ).toEqual({ ok: true });
    });

    it('unable_to_review + 0 blocking issues → ok (own SSOT path, not this rule)', () => {
      expect(
        validateReviewFindingsConsistency({
          overallVerdict: 'unable_to_review',
          blockingIssueCount: 0,
        }),
      ).toEqual({ ok: true });
    });
  });

  describe('GUARD — rule keys ONLY on blocking issues, not on other findings', () => {
    it('the check receives only verdict + blocking count; advisory data elsewhere cannot trip it', () => {
      // The input contract deliberately excludes majorRisks/missingVerification/etc.
      // so "accept must be findings-free" can never be implemented by accident.
      expect(
        validateReviewFindingsConsistency({ overallVerdict: 'accept', blockingIssueCount: 0 }),
      ).toEqual({ ok: true });
    });
  });

  describe('challenge matrix', () => {
    const implementationChallenge = {
      kind: 'implementation_challenge',
      evidenceRefs: [{ kind: 'implementation' }, { kind: 'validation_attempt' }],
      outcome: 'pass',
    };

    it('accepts the required HIGH-RISK implementation coverage', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 2,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [implementationChallenge, implementationChallenge],
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
      // Count matches and evidence is otherwise fine: only the obligation binding
      // is wrong, isolating the expectedObligationId guard.
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
      // Positive control for the obligation guard: identical id must pass, so a
      // guard mutated to always-fail is killed.
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
      // Count matches (1 === 1) so execution reaches the kind guard in isolation.
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
      // requiredChallengeCount=0 with a single non-matching-kind challenge whose
      // count still equals the requirement is impossible; instead prove the
      // count-gate by supplying zero challenges (kind guard must not fire).
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
        }),
      ).toEqual({ ok: true });
    });

    it('rejects a passing implementation challenge whose only evidence is non-validation-attempt', () => {
      // outcome === 'pass' and evidenceRefs present but WITHOUT a validation_attempt
      // ref: isolates the validation-attempt requirement branch (line 127/128).
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
      // Positive control: outcome !== 'pass' must skip the validation-attempt
      // requirement, so mutating `outcome === 'pass'` to a constant is killed.
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
      // Count matches (1) and evidence is valid; only outcome=fail under accept
      // trips the unresolved guard (line 144/146) in isolation.
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

  describe('resolution verdict gating by overallVerdict', () => {
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
          unresolvedImplementationChallengeIds: ['00000000-0000-4000-8000-000000000001'],
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
          unresolvedImplementationChallengeIds: ['00000000-0000-4000-8000-000000000001'],
          resolutionVerdicts: [
            { challengeId: '00000000-0000-4000-8000-000000000001', verdict: 'not_verified' },
          ],
        }),
      ).toEqual({ ok: true });
    });

    it('accepts changes_requested with prior unresolved challenge and still_failing verdict', () => {
      expect(
        validateChallengeConsistency({
          overallVerdict: 'changes_requested',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [],
          unresolvedImplementationChallengeIds: ['00000000-0000-4000-8000-000000000001'],
          resolutionVerdicts: [
            { challengeId: '00000000-0000-4000-8000-000000000001', verdict: 'still_failing' },
          ],
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
          unresolvedImplementationChallengeIds: ['00000000-0000-4000-8000-000000000001'],
        }).ok,
      ).toBe(false);
    });

    it('rejects accept with prior unresolved challenge and still_failing verdict', () => {
      const result = validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'implementation_challenge',
        challenges: [challenge],
        unresolvedImplementationChallengeIds: ['00000000-0000-4000-8000-000000000001'],
        resolutionVerdicts: [
          { challengeId: '00000000-0000-4000-8000-000000000001', verdict: 'still_failing' },
        ],
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
        unresolvedImplementationChallengeIds: ['00000000-0000-4000-8000-000000000001'],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
        details: { reason: 'no resolution verdict' },
      });
    });

    it('accepts when a prior unresolved challenge has an independent resolved verdict', () => {
      // Positive control that pins `verdict === 'resolved'` under accept: the
      // ONLY verdict that lets acceptance through. A mutation of that equality
      // (e.g. to `true`) would wrongly accept still_failing/not_verified and is
      // caught by the negative tests; this test kills the inverse mutation that
      // would wrongly reject the legitimate `resolved` path.
      expect(
        validateChallengeConsistency({
          overallVerdict: 'accept',
          requiredChallengeCount: 1,
          requiredChallengeKind: 'implementation_challenge',
          challenges: [challenge],
          unresolvedImplementationChallengeIds: ['00000000-0000-4000-8000-000000000001'],
          resolutionVerdicts: [
            { challengeId: '00000000-0000-4000-8000-000000000001', verdict: 'resolved' },
          ],
        }),
      ).toEqual({ ok: true });
    });

    it('accepts when there are no prior unresolved challenges (early-return path)', () => {
      // Pins the `unresolvedIds.length === 0` early return: with an empty
      // unresolved list and no verdicts, acceptance must pass. A mutation to
      // `if (false)` would fall through to the verdict loop and change behavior.
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
  });
});
