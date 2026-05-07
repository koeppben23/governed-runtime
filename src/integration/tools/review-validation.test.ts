import { describe, it, expect } from 'vitest';
import {
  validateReviewFindings,
  requireReviewFindings,
  type ReviewFindingsValidationContext,
} from './review-validation.js';
import type { ReviewFindings } from '../../state/evidence.js';
import {
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../review-assurance.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function makeFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
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
    reviewedBy: { sessionId: 'ses_test' },
    reviewedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<ReviewFindingsValidationContext> = {},
): ReviewFindingsValidationContext {
  return {
    subagentEnabled: true,
    fallbackToSelf: false,
    expectedPlanVersion: 1,
    expectedIteration: 0,
    ...overrides,
  };
}

function parseBlocked(result: string): { code: string; error: boolean } {
  return JSON.parse(result) as { code: string; error: boolean };
}

function strictFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return makeFindings({
    reviewedBy: { sessionId: 'ses_child' },
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: '11111111-1111-4111-8111-111111111111',
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  });
}

function strictAssuranceFixture(findings: ReviewFindings = strictFindings()) {
  return {
    obligations: [
      {
        obligationId: '11111111-1111-4111-8111-111111111111',
        obligationType: 'plan' as const,
        iteration: 0,
        planVersion: 1,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        createdAt: new Date().toISOString(),
        pluginHandshakeAt: new Date().toISOString(),
        status: 'fulfilled' as const,
        invocationId: '22222222-2222-4222-8222-222222222222',
        blockedCode: null,
        fulfilledAt: new Date().toISOString(),
        consumedAt: null,
      },
    ],
    invocations: [
      {
        invocationId: '22222222-2222-4222-8222-222222222222',
        obligationId: '11111111-1111-4111-8111-111111111111',
        obligationType: 'plan' as const,
        parentSessionId: 'ses_parent',
        childSessionId: 'ses_child',
        agentType: 'flowguard-reviewer' as const,
        promptHash: 'abc',
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        findingsHash: hashFindings(findings),
        invokedAt: new Date().toISOString(),
        fulfilledAt: new Date().toISOString(),
        consumedByObligationId: null,
      },
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// validateReviewFindings
// ═════════════════════════════════════════════════════════════════════════════

describe('validateReviewFindings', () => {
  // ── Happy Path ──────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('returns null for valid subagent findings (subagent enabled)', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'subagent' }),
        makeCtx({ subagentEnabled: true }),
      );
      expect(result).toBeNull();
    });

    it('returns null for iteration > 0 when expected', () => {
      const result = validateReviewFindings(
        makeFindings({ iteration: 3 }),
        makeCtx({ expectedIteration: 3 }),
      );
      expect(result).toBeNull();
    });

    it('returns null for planVersion > 1 when expected', () => {
      const result = validateReviewFindings(
        makeFindings({ planVersion: 5 }),
        makeCtx({ expectedPlanVersion: 5 }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Rule 1: mandatory subagent mode ────────────────────────────────────

  describe('Rule 1: mandatory subagent mode', () => {
    it('accepts subagent mode even when legacy subagentEnabled=false is supplied', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'subagent' }),
        makeCtx({ subagentEnabled: false }),
      );
      expect(result).toBeNull();
    });

    it('accepts subagent mode when subagentEnabled=true', () => {
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'subagent' }),
        makeCtx({ subagentEnabled: true }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Rule 3: planVersion binding ────────────────────────────────────────

  describe('Rule 3: planVersion binding', () => {
    it('blocks when planVersion too high', () => {
      const result = validateReviewFindings(
        makeFindings({ planVersion: 99 }),
        makeCtx({ expectedPlanVersion: 1 }),
      );
      expect(result).not.toBeNull();
      const parsed = parseBlocked(result!);
      expect(parsed.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('blocks when planVersion too low', () => {
      const result = validateReviewFindings(
        makeFindings({ planVersion: 1 }),
        makeCtx({ expectedPlanVersion: 3 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('accepts exact planVersion match', () => {
      const result = validateReviewFindings(
        makeFindings({ planVersion: 3 }),
        makeCtx({ expectedPlanVersion: 3 }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Rule 4: iteration binding ──────────────────────────────────────────

  describe('Rule 4: iteration binding', () => {
    it('blocks when iteration too high', () => {
      const result = validateReviewFindings(
        makeFindings({ iteration: 5 }),
        makeCtx({ expectedIteration: 0 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_ITERATION_MISMATCH');
    });

    it('blocks when iteration too low', () => {
      const result = validateReviewFindings(
        makeFindings({ iteration: 0 }),
        makeCtx({ expectedIteration: 2 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_ITERATION_MISMATCH');
    });

    it('accepts exact iteration match', () => {
      const result = validateReviewFindings(
        makeFindings({ iteration: 2 }),
        makeCtx({ expectedIteration: 2 }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('blocks on first failing rule (subagent before planVersion)', () => {
      // Legacy subagent-disabled is ignored; planVersion binding remains authoritative.
      const result = validateReviewFindings(
        makeFindings({ reviewMode: 'subagent', planVersion: 99 }),
        makeCtx({ subagentEnabled: false, expectedPlanVersion: 1 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('checks planVersion before iteration (rule order)', () => {
      // planVersion wrong AND iteration wrong — should hit Rule 3 (planVersion) first
      const result = validateReviewFindings(
        makeFindings({ planVersion: 99, iteration: 99 }),
        makeCtx({ expectedPlanVersion: 1, expectedIteration: 0 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('returns structured JSON with error=true on any block', () => {
      const result = validateReviewFindings(
        makeFindings({ planVersion: 99 }),
        makeCtx({ expectedPlanVersion: 1 }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBeTruthy();
      expect(parsed.message).toBeTruthy();
    });

    it('planVersion=0 never matches (positive integer required by schema)', () => {
      // Even if expectedPlanVersion=0 (shouldn't happen), validation checks equality
      const result = validateReviewFindings(
        makeFindings({ planVersion: 1 }),
        makeCtx({ expectedPlanVersion: 0 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });
  });

  // ── Corner: legacy policy combinations ─────────────────────────────────

  describe('policy matrix (legacy combinations all require subagent findings)', () => {
    const combinations = [
      { subagentEnabled: false, fallbackToSelf: false },
      { subagentEnabled: false, fallbackToSelf: true },
      { subagentEnabled: true, fallbackToSelf: false },
      { subagentEnabled: true, fallbackToSelf: true },
    ] as const;

    for (const combo of combinations) {
      it(`accepts subagent mode + subagent=${combo.subagentEnabled} fallback=${combo.fallbackToSelf}`, () => {
        const result = validateReviewFindings(
          makeFindings({ reviewMode: 'subagent' }),
          makeCtx(combo),
        );
        expect(result).toBeNull();
      });
    }
  });

  describe('strict assurance', () => {
    it('accepts when strict evidence and attestation match', () => {
      const findings = strictFindings();
      const result = validateReviewFindings(
        findings,
        makeCtx({
          subagentEnabled: true,
          strictEnforcement: true,
          assurance: strictAssuranceFixture(findings),
          obligationType: 'plan',
        }),
      );
      expect(result).toBeNull();
    });

    it('blocks when strict attestation is missing', () => {
      const findings = makeFindings({ reviewMode: 'subagent' });
      const result = validateReviewFindings(
        findings,
        makeCtx({
          subagentEnabled: true,
          strictEnforcement: true,
          assurance: strictAssuranceFixture(),
          obligationType: 'plan',
        }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('SUBAGENT_MANDATE_MISSING');
    });

    it('blocks when strict obligation is blocked', () => {
      const assurance = strictAssuranceFixture();
      assurance.obligations[0]!.status = 'blocked';
      assurance.obligations[0]!.blockedCode = 'STRICT_REVIEW_ORCHESTRATION_FAILED';
      const findings = strictFindings();
      const result = validateReviewFindings(
        findings,
        makeCtx({
          subagentEnabled: true,
          strictEnforcement: true,
          assurance,
          obligationType: 'plan',
        }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('STRICT_REVIEW_ORCHESTRATION_FAILED');
    });

    it('blocks stale findings before selecting a matching stale obligation', () => {
      const findings = strictFindings({ iteration: 1 });
      const result = validateReviewFindings(
        findings,
        makeCtx({
          expectedIteration: 0,
          strictEnforcement: true,
          assurance: strictAssuranceFixture(findings),
          obligationType: 'plan',
        }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_ITERATION_MISMATCH');
    });

    it('blocks when submitted findings content differs from invocation hash', () => {
      const original = strictFindings();
      const tampered = { ...original, overallVerdict: 'changes_requested' as const };
      const result = validateReviewFindings(
        tampered,
        makeCtx({
          strictEnforcement: true,
          assurance: strictAssuranceFixture(original),
          obligationType: 'plan',
        }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
    });

    it('blocks when submitted findings session differs from invocation child session', () => {
      const findings = strictFindings({ reviewedBy: { sessionId: 'ses_other' } });
      const result = validateReviewFindings(
        findings,
        makeCtx({
          strictEnforcement: true,
          assurance: strictAssuranceFixture(strictFindings()),
          obligationType: 'plan',
        }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_FINDINGS_SESSION_MISMATCH');
    });
  });

  // ─── P1.3 slice 4e: third-verdict tool-layer assertion ───────────────
  describe('Rule 5: overallVerdict=unable_to_review fails closed', () => {
    it('blocks with SUBAGENT_UNABLE_TO_REVIEW (HAPPY: third-verdict pin)', () => {
      // Even with otherwise-valid subagent findings, an
      // overallVerdict='unable_to_review' must fail closed at the tool
      // layer. The orchestrator (slice 4c) handles strict-mode by
      // routing BLOCKED before tools see findings; this tool-layer
      // guard catches the residual non-strict / submit-driven path.
      const findings = makeFindings({ overallVerdict: 'unable_to_review' });
      const result = validateReviewFindings(findings, makeCtx());
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });

    it('blocks before planVersion/iteration mismatch checks (CORNER: precedence)', () => {
      // Even when planVersion/iteration are wrong, unable_to_review
      // takes precedence — there is no convergence path regardless of
      // binding correctness, and the operator-facing recovery copy
      // (slice 2 reason) is the right starting point.
      const findings = makeFindings({
        overallVerdict: 'unable_to_review',
        planVersion: 999, // would otherwise trigger REVIEW_PLAN_VERSION_MISMATCH
        iteration: 999, // would otherwise trigger REVIEW_ITERATION_MISMATCH
      });
      const result = validateReviewFindings(findings, makeCtx());
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });

    it('blocks before strict-mode mandate checks (CORNER: precedence over strict)', () => {
      // unable_to_review must fail closed regardless of strict-mode
      // mandate state. Even if assurance is missing/inconsistent,
      // the unreviewable verdict is the dominant signal.
      const findings = makeFindings({ overallVerdict: 'unable_to_review' });
      const result = validateReviewFindings(
        findings,
        makeCtx({
          strictEnforcement: true,
          assurance: undefined, // would otherwise trigger PLUGIN_ENFORCEMENT_UNAVAILABLE
          obligationType: 'plan',
        }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });

    it('does NOT block when overallVerdict=approve (HAPPY: regression guard)', () => {
      // The new gate must NOT capture the normal path. With approve,
      // validation proceeds to existing rules; on a fully-valid
      // findings + ctx the result is null (validation pass).
      const findings = makeFindings({ overallVerdict: 'approve' });
      const result = validateReviewFindings(findings, makeCtx());
      expect(result).toBeNull();
    });

    it('does NOT block when overallVerdict=changes_requested (HAPPY: regression guard)', () => {
      // Symmetric guard for the second 2-valued LoopVerdict.
      const findings = makeFindings({ overallVerdict: 'changes_requested' });
      const result = validateReviewFindings(findings, makeCtx());
      expect(result).toBeNull();
    });
  });

  // ─── F13: architecture obligationType (slice 3) ──────────────
  describe('F13 architecture obligationType', () => {
    it("accepts obligationType: 'architecture' (non-strict path)", () => {
      const findings = makeFindings({ overallVerdict: 'approve' });
      const result = validateReviewFindings(
        findings,
        makeCtx({
          subagentEnabled: true,
          obligationType: 'architecture',
        }),
      );
      expect(result).toBeNull();
    });

    it("third-verdict precedence still wins for obligationType: 'architecture'", () => {
      const findings = makeFindings({ overallVerdict: 'unable_to_review' });
      const result = validateReviewFindings(
        findings,
        makeCtx({
          subagentEnabled: true,
          obligationType: 'architecture',
        }),
      );
      expect(result).not.toBeNull();
      const parsed = parseBlocked(result!);
      expect(parsed.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });

    it("strict assurance accepts obligationType: 'architecture' when attestation matches", () => {
      const findings = strictFindings();
      const archAssurance = {
        ...strictAssuranceFixture(findings),
        obligations: strictAssuranceFixture(findings).obligations.map((o) => ({
          ...o,
          obligationType: 'architecture' as const,
        })),
        invocations: strictAssuranceFixture(findings).invocations.map((i) => ({
          ...i,
          obligationType: 'architecture' as const,
        })),
      };
      const result = validateReviewFindings(
        findings,
        makeCtx({
          subagentEnabled: true,
          strictEnforcement: true,
          assurance: archAssurance,
          obligationType: 'architecture',
        }),
      );
      expect(result).toBeNull();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// requireReviewFindings
// ═════════════════════════════════════════════════════════════════════════════

describe('requireReviewFindings', () => {
  it('blocks when findings are missing', () => {
    const result = requireReviewFindings(false);
    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('returns null when findings are present', () => {
    expect(requireReviewFindings(true)).toBeNull();
  });

  it('returns structured JSON with error=true', () => {
    const result = requireReviewFindings(false);
    const parsed = JSON.parse(result!);
    expect(parsed.error).toBe(true);
    expect(parsed.recovery).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Anti-forgery: manual findings without persisted evidence
// ═════════════════════════════════════════════════════════════════════════════

describe('anti-forgery — manual findings without persisted evidence', () => {
  it('NOT_PROVIDED_BY_RUNTIME attestation values are rejected', () => {
    const findings = strictFindings({
      attestation: {
        mandateDigest: 'NOT_PROVIDED_BY_RUNTIME',
        criteriaVersion: 'NOT_PROVIDED_BY_RUNTIME',
        toolObligationId: 'NOT_PROVIDED_BY_RUNTIME',
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    });
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: strictAssuranceFixture(strictFindings()),
        obligationType: 'plan',
      }),
    );
    expect(result).not.toBeNull();
    const blocked = JSON.parse(result!);
    expect(blocked.code).toBe('SUBAGENT_MANDATE_MISMATCH');
  });

  it('correct-looking attestation without fulfilled obligation is rejected', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0]!.status = 'pending';
    assurance.obligations[0]!.invocationId = null;
    assurance.obligations[0]!.fulfilledAt = null;
    const result = validateReviewFindings(
      findings,
      makeCtx({ strictEnforcement: true, assurance, obligationType: 'plan' }),
    );
    expect(result).not.toBeNull();
    const blocked = JSON.parse(result!);
    expect(blocked.code).toBe('SUBAGENT_EVIDENCE_MISSING');
  });

  it('correct attestation without matching invocation evidence is rejected', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.invocations = [];
    const result = validateReviewFindings(
      findings,
      makeCtx({ strictEnforcement: true, assurance, obligationType: 'plan' }),
    );
    expect(result).not.toBeNull();
    const blocked = JSON.parse(result!);
    expect(blocked.code).toBe('SUBAGENT_EVIDENCE_MISSING');
  });

  it('accepts matching fulfilled obligation and matching invocation evidence', () => {
    const findings = strictFindings();
    const result = validateReviewFindings(
      findings,
      makeCtx({
        strictEnforcement: true,
        assurance: strictAssuranceFixture(findings),
        obligationType: 'plan',
      }),
    );
    expect(result).toBeNull();
  });
});
