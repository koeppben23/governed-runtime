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
  });
});
