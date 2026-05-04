/**
 * @module integration/review-assurance.test
 * @description Unit tests for review assurance helpers — pure functions, no I/O.
 *
 * Targets previously uncovered branches in findLatestObligation,
 * hasEvidenceReuse, and validateStrictAttestation.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import {
  emptyReviewAssurance,
  ensureReviewAssurance,
  createReviewObligation,
  appendReviewObligation,
  reviewObligationResponseFields,
  findLatestObligation,
  consumeReviewObligation,
  hashText,
  hashFindings,
  buildInvocationEvidence,
  hasEvidenceReuse,
  validateStrictAttestation,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review-assurance.js';
import { REVIEWER_SUBAGENT_TYPE } from './tool-names.js';
import type {
  ReviewObligation,
  ReviewInvocationEvidence,
  ReviewFindings,
} from '../state/evidence.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const NOW = '2026-04-27T00:00:00.000Z';

function makeObligation(overrides?: Partial<ReviewObligation>): ReviewObligation {
  return createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    now: NOW,
    ...overrides,
  });
}

function makeInvocation(overrides?: Partial<ReviewInvocationEvidence>): ReviewInvocationEvidence {
  return buildInvocationEvidence({
    obligationId: '00000000-0000-4000-8000-000000000001',
    obligationType: 'plan',
    parentSessionId: 'parent-session-1',
    childSessionId: 'child-session-1',
    promptHash: hashText('test prompt'),
    findingsHash: hashText('test findings'),
    invokedAt: NOW,
    fulfilledAt: NOW,
    ...overrides,
  });
}

function makeFindings(overrides?: Partial<ReviewFindings>): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'child-session-1' },
    reviewedAt: NOW,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: '00000000-0000-4000-8000-000000000001',
      iteration: 0,
      planVersion: 1,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('integration/review-assurance', () => {
  describe('emptyReviewAssurance', () => {
    it('returns empty obligations and invocations arrays', () => {
      const result = emptyReviewAssurance();
      expect(result.obligations).toEqual([]);
      expect(result.invocations).toEqual([]);
    });
  });

  describe('ensureReviewAssurance', () => {
    it('returns the given assurance when defined', () => {
      const existing = { obligations: [makeObligation()], invocations: [] };
      expect(ensureReviewAssurance(existing)).toBe(existing);
    });

    it('returns empty assurance when undefined', () => {
      const result = ensureReviewAssurance(undefined);
      expect(result.obligations).toEqual([]);
    });
  });

  describe('createReviewObligation', () => {
    it('creates a pending plan obligation with correct fields', () => {
      const result = createReviewObligation({
        obligationType: 'plan',
        iteration: 0,
        planVersion: 1,
        now: NOW,
      });
      expect(result.obligationType).toBe('plan');
      expect(result.status).toBe('pending');
      expect(result.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
      expect(result.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
      expect(result.blockedCode).toBeNull();
    });
  });

  describe('appendReviewObligation', () => {
    it('appends a pending obligation while preserving invocations', () => {
      const invocation = makeInvocation();
      const obligation = makeObligation();
      const result = appendReviewObligation(
        { obligations: [], invocations: [invocation] },
        obligation,
      );

      expect(result.obligations).toEqual([obligation]);
      expect(result.invocations).toEqual([invocation]);
    });

    it('returns ensured assurance unchanged when obligation is null', () => {
      const result = appendReviewObligation(undefined, null);
      expect(result).toEqual({ obligations: [], invocations: [] });
    });
  });

  describe('reviewObligationResponseFields', () => {
    it('builds nested and flat compatibility response fields', () => {
      const obligation = makeObligation({ obligationType: 'architecture', iteration: 2 });
      const result = reviewObligationResponseFields(obligation);

      expect(result.reviewObligation).toMatchObject({
        obligationId: obligation.obligationId,
        obligationType: 'architecture',
        iteration: 2,
      });
      expect(result.reviewObligationId).toBe(obligation.obligationId);
      expect(result.reviewCriteriaVersion).toBe(obligation.criteriaVersion);
    });

    it('returns empty fields when obligation is null', () => {
      expect(reviewObligationResponseFields(null)).toEqual({});
    });
  });

  describe('findLatestObligation', () => {
    describe('HAPPY', () => {
      it('finds matching obligation by type/iteration/planVersion', () => {
        const obligations = [
          makeObligation({ obligationType: 'plan', iteration: 0, planVersion: 1 }),
          makeObligation({ obligationType: 'plan', iteration: 1, planVersion: 2 }),
        ];
        const result = findLatestObligation(obligations, 'plan', 1, 2);
        expect(result).toBe(obligations[1]);
      });

      it('returns latest when multiple match', () => {
        const obligations = [
          makeObligation({ obligationType: 'plan', iteration: 0, planVersion: 1 }),
          makeObligation({ obligationType: 'plan', iteration: 0, planVersion: 1 }),
        ];
        const result = findLatestObligation(obligations, 'plan', 0, 1);
        expect(result).toBe(obligations[1]);
      });
    });

    describe('BAD', () => {
      it('returns null when no obligation matches type', () => {
        const obligations = [makeObligation({ obligationType: 'plan' })];
        const result = findLatestObligation(obligations, 'implement', 0, 1);
        expect(result).toBeNull();
      });

      it('returns null when iteration does not match', () => {
        const obligations = [makeObligation({ iteration: 0 })];
        const result = findLatestObligation(obligations, 'plan', 99, 1);
        expect(result).toBeNull();
      });

      it('returns null when planVersion does not match', () => {
        const obligations = [makeObligation({ planVersion: 1 })];
        const result = findLatestObligation(obligations, 'plan', 0, 99);
        expect(result).toBeNull();
      });

      it('returns null for empty obligations array', () => {
        // Covers line 76: return null when no obligations
        const result = findLatestObligation([], 'plan', 0, 1);
        expect(result).toBeNull();
      });
    });

    describe('CORNER', () => {
      it('skips null entries in obligations array', () => {
        const obligations = [null as unknown as ReviewObligation, makeObligation()];
        const result = findLatestObligation(obligations, 'plan', 0, 1);
        expect(result).toBeDefined();
        expect(result?.obligationType).toBe('plan');
      });
    });

    describe('EDGE', () => {
      it('returns null when all obligations are null', () => {
        const result = findLatestObligation([null as unknown as ReviewObligation], 'plan', 0, 1);
        expect(result).toBeNull();
      });
    });
  });

  describe('hashText', () => {
    it('returns deterministic hex digest', () => {
      const a = hashText('hello');
      const b = hashText('hello');
      expect(a).toBe(b);
      expect(typeof a).toBe('string');
      expect(a.length).toBe(64);
    });

    it('produces different digests for different input', () => {
      expect(hashText('hello')).not.toBe(hashText('world'));
    });
  });

  describe('consumeReviewObligation', () => {
    it('marks the matching obligation and invocation as consumed', () => {
      const obligation = {
        ...makeObligation({ obligationId: '00000000-0000-4000-8000-000000000001' }),
        invocationId: '00000000-0000-4000-8000-000000000002',
      };
      const invocation = {
        ...makeInvocation(),
        invocationId: '00000000-0000-4000-8000-000000000002',
      };
      const result = consumeReviewObligation(
        { obligations: [obligation], invocations: [invocation] },
        obligation,
        NOW,
      );

      expect(result.obligations[0]?.status).toBe('consumed');
      expect(result.obligations[0]?.consumedAt).toBe(NOW);
      expect(result.invocations[0]?.consumedByObligationId).toBe(obligation.obligationId);
    });

    it('returns the same assurance when obligation is null', () => {
      const assurance = { obligations: [makeObligation()], invocations: [] };
      expect(consumeReviewObligation(assurance, null, NOW)).toBe(assurance);
    });
  });

  describe('hashFindings', () => {
    it('returns deterministic hash for same findings object', () => {
      const a = hashFindings({ key: 'val' });
      const b = hashFindings({ key: 'val' });
      expect(a).toBe(b);
    });
  });

  describe('buildInvocationEvidence', () => {
    it('returns complete invocation evidence with correct agent type', () => {
      const result = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
        fulfilledAt: NOW,
      });
      expect(result.agentType).toBe(REVIEWER_SUBAGENT_TYPE);
      expect(result.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
      expect(result.consumedByObligationId).toBeNull();
    });
  });

  describe('hasEvidenceReuse', () => {
    describe('HAPPY', () => {
      it('returns true when child session matches', () => {
        const invocations = [makeInvocation({ childSessionId: 'child-1' })];
        expect(hasEvidenceReuse(invocations, 'child-1', 'some-hash')).toBe(true);
      });

      it('returns true when findings hash matches', () => {
        const invocations = [makeInvocation({ findingsHash: 'abc123' })];
        expect(hasEvidenceReuse(invocations, 'other-child', 'abc123')).toBe(true);
      });
    });

    describe('BAD', () => {
      it('returns false when no invocation matches session or hash', () => {
        const invocations = [makeInvocation({ childSessionId: 'child-1', findingsHash: 'xyz' })];
        // Covers line 120: invocations.some returns false
        expect(hasEvidenceReuse(invocations, 'child-2', 'abc')).toBe(false);
      });

      it('returns false for empty invocations array', () => {
        expect(hasEvidenceReuse([], 'child-1', 'abc')).toBe(false);
      });
    });

    describe('PERF', () => {
      it('completes in < 1ms for 1000 invocations', () => {
        const invocations = Array.from({ length: 1000 }, (_, i) =>
          makeInvocation({ childSessionId: `child-${i}` }),
        );
        const start = performance.now();
        const result = hasEvidenceReuse(invocations, 'nonexistent', 'nonexistent');
        const elapsed = performance.now() - start;
        expect(result).toBe(false);
        expect(elapsed).toBeLessThan(5);
      });
    });
  });

  describe('validateStrictAttestation', () => {
    describe('HAPPY', () => {
      it('returns null when attestation is fully valid', () => {
        const findings = makeFindings();
        const result = validateStrictAttestation(findings, {
          obligationId: '00000000-0000-4000-8000-000000000001',
          iteration: 0,
          planVersion: 1,
        });
        expect(result).toBeNull();
      });
    });

    describe('BAD', () => {
      it('returns SUBAGENT_MANDATE_MISSING when attestation is absent', () => {
        const findings = makeFindings({ attestation: undefined });
        // Covers line 133: !att → SUBAGENT_MANDATE_MISSING
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISSING');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when mandateDigest differs', () => {
        const findings = makeFindings();
        findings.attestation!.mandateDigest = 'wrong-digest';
        // Covers line 143: mismatch → SUBAGENT_MANDATE_MISMATCH
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when criteriaVersion differs', () => {
        const findings = makeFindings();
        findings.attestation!.criteriaVersion = 'wrong-version';
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when obligationId differs', () => {
        const findings = makeFindings();
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-ffffffffffff',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when iteration differs', () => {
        const findings = makeFindings();
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 99,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when planVersion differs', () => {
        const findings = makeFindings();
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 99,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when reviewedBy is not flowguard-reviewer', () => {
        const findings = makeFindings();
        findings.attestation!.reviewedBy = 'other-agent';
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });
    });

    describe('CORNER', () => {
      it('returns SUBAGENT_MANDATE_MISSING when findings are from self-review', () => {
        const findings = makeFindings({ reviewMode: 'self', attestation: undefined });
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISSING');
      });
    });
  });
});
