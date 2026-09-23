import { describe, it, expect } from 'vitest';
import {
  resolveStructuredEffectiveFindings,
  validateReviewFindings,
  type ReviewFindingsValidationContext,
} from '../review/validation/review-validation.js';
import {
  formatReviewValidationFailure,
  structuredResolutionFailure,
} from '../review/validation/review-validation-failure.js';
import { resolveStructuredFindings } from '../review/validation/review-validation-structured-evidence.js';

const testLogger = { warn: () => {} };

/**
 * Adapter-boundary characterization: the domain validation returns a failure
 * verdict, the serializer renders the envelope under test.
 */
function serializedValidation(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): string | null {
  const failure = validateReviewFindings(findings, ctx);
  return failure === null ? null : formatReviewValidationFailure(testLogger, failure);
}
import type { ReviewFindings } from '../../state/evidence.js';
import type { ReviewChallenge } from '../../state/evidence-review.js';
import {
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../review/obligations/assurance.js';
import { hashFindings } from '../review/findings-hash.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function makeFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    reviewedBy: { sessionId: 'ses_test' },
    reviewedAt: new Date().toISOString(),
    ...overrides,
  };
}

type UndefinedableOverrides<T> = {
  [K in keyof T]?: T[K] | undefined;
};

function makeCtx(
  overrides: UndefinedableOverrides<ReviewFindingsValidationContext> = {},
): ReviewFindingsValidationContext {
  const context: ReviewFindingsValidationContext = {
    expectedPlanVersion: 1,
    expectedIteration: 0,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      Reflect.deleteProperty(context, key);
    } else {
      Object.assign(context, { [key]: value });
    }
  }
  return context;
}

function parseBlocked(result: string): { code: string; error: boolean; message: string } {
  return JSON.parse(result) as { code: string; error: boolean; message: string };
}

function findingRelation() {
  const location = { path: 'src/foo.ts', revision: 'head' as const, line: 1 };
  return {
    subjectAnchors: [{ kind: 'repository_location' as const, location }],
    evidenceLocations: [],
  };
}

function strictFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  const findings = makeFindings({
    reviewedBy: { sessionId: 'ses_child' },
    ...overrides,
  });
  return {
    ...findings,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: '11111111-1111-4111-8111-111111111111',
      iteration: findings.iteration,
      planVersion: findings.planVersion,
      reviewedBy: 'flowguard-reviewer',
    },
  };
}

function strictAssuranceFixture(
  findings: ReviewFindings = strictFindings(),
): NonNullable<ReviewFindingsValidationContext['assurance']> {
  return {
    assuranceSchemaVersion: 'review-assurance.v6' as const,
    attempts: [
      {
        attemptId: '55555555-5555-4555-8555-555555555555',
        obligationId: '11111111-1111-4111-8111-111111111111',
        obligationType: 'plan' as const,
        subjectDigest: 'test-subject-digest',
        ordinal: 0,
        status: 'bound' as const,
        origin: { kind: 'initial' } as const,
        repositoryDiscovery: { kind: 'not_applicable' } as const,
        observations: [],
        createdAt: new Date().toISOString(),
      },
    ],
    dispatches: [],
    obligations: [
      {
        obligationId: '11111111-1111-4111-8111-111111111111',
        obligationType: 'plan' as const,
        reviewCycle: 1,
        requiredChallengeCount: 0,
        requiredChallengeKind: 'design_challenge' as const,
        challengePolicyVersion: 'challenge-policy.v1' as const,
        subjectDigest: 'test-subject-digest',
        iteration: findings.iteration,
        planVersion: findings.planVersion,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        maxReviewerAttempts: 1,
        reviewProfile: 'core' as const,
        profileSource: 'policy_default' as const,
        reviewMaterial: freezeReviewMaterial('frozen review material', 'test-subject-digest'),
        createdAt: new Date().toISOString(),
        pluginHandshakeAt: new Date().toISOString(),
        status: 'fulfilled' as const,
        invocationId: '22222222-2222-4222-8222-222222222222',
        blockedCode: null,
        fulfilledAt: new Date().toISOString(),
        consumedAt: null,
        reviewSubjectScope: {
          kind: 'repository_change' as const,
          paths: ['src/foo.ts'],
          revisions: ['base', 'head'] as const,
        },
        repositoryRevisionProvenance: {
          kind: 'available' as const,
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
        },
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
        attemptId: '55555555-5555-4555-8555-555555555555',
        invocationMode: 'native_task_structured_followup' as const,
        reviewOutputMode: 'structured_output' as const,
        structuredOutputUsed: true,
        reviewAssuranceLevel: 'structured_high' as const,
        hostVisible: true,
        transcriptNavigable: true,
        source: 'host-orchestrated' as const,
        promptHash: 'abc',
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        findingsHash: hashFindings(findings),
        capturedRawFindings: findings,
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
      const findings = strictFindings();
      const result = serializedValidation(
        findings,
        makeCtx({ assurance: strictAssuranceFixture(findings), obligationType: 'plan' }),
      );
      expect(result).toBeNull();
    });

    it('returns null for iteration > 0 when expected', () => {
      const findings = strictFindings({ iteration: 3 });
      const result = serializedValidation(
        findings,
        makeCtx({
          expectedIteration: 3,
          assurance: strictAssuranceFixture(findings),
          obligationType: 'plan',
        }),
      );
      expect(result).toBeNull();
    });

    it('returns null for planVersion > 1 when expected', () => {
      const findings = strictFindings({ planVersion: 5 });
      const result = serializedValidation(
        findings,
        makeCtx({
          expectedPlanVersion: 5,
          assurance: strictAssuranceFixture(findings),
          obligationType: 'plan',
        }),
      );
      expect(result).toBeNull();
    });
  });

  // ── F12: verdict/blocking-issues coherence (strict emptiness) ──────────

  describe('F12: verdict/blocking-issues coherence', () => {
    const criticalIssue = {
      severity: 'critical' as const,
      category: 'correctness' as const,
      message: 'contract drift',
      relation: findingRelation(),
    };
    const majorIssue = {
      severity: 'major' as const,
      category: 'risk' as const,
      message: 'silent data loss',
      relation: findingRelation(),
    };
    const minorIssue = {
      severity: 'minor' as const,
      category: 'quality' as const,
      message: 'stale comment',
      relation: findingRelation(),
    };

    it('blocks accept with a critical blocking issue', () => {
      const result = serializedValidation(
        makeFindings({ overallVerdict: 'accept', blockingIssues: [criticalIssue] }),
        makeCtx(),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');
    });

    it('blocks accept with a major blocking issue', () => {
      const result = serializedValidation(
        makeFindings({ overallVerdict: 'accept', blockingIssues: [majorIssue] }),
        makeCtx(),
      );
      expect(parseBlocked(result!).code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');
    });

    it('blocks accept with a MINOR blocking issue (strict emptiness — field name is the contract)', () => {
      const result = serializedValidation(
        makeFindings({ overallVerdict: 'accept', blockingIssues: [minorIssue] }),
        makeCtx(),
      );
      expect(parseBlocked(result!).code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');
    });

    it('allows accept with empty blockingIssues', () => {
      const findings = strictFindings({ overallVerdict: 'accept', blockingIssues: [] });
      const result = serializedValidation(
        findings,
        makeCtx({ assurance: strictAssuranceFixture(findings), obligationType: 'plan' }),
      );
      expect(result).toBeNull();
    });

    it('allows changes_requested with blocking issues', () => {
      const findings = strictFindings({
        overallVerdict: 'changes_requested',
        blockingIssues: [criticalIssue],
      });
      const result = serializedValidation(
        findings,
        makeCtx({ assurance: strictAssuranceFixture(findings), obligationType: 'plan' }),
      );
      expect(result).toBeNull();
    });

    it('allows changes_requested with empty blockingIssues', () => {
      const findings = strictFindings({ overallVerdict: 'changes_requested', blockingIssues: [] });
      const result = serializedValidation(
        findings,
        makeCtx({ assurance: strictAssuranceFixture(findings), obligationType: 'plan' }),
      );
      expect(result).toBeNull();
    });

    it('allows accept with advisory-only findings OUTSIDE blockingIssues (majorRisks/missingVerification)', () => {
      const findings = strictFindings({
        overallVerdict: 'accept',
        blockingIssues: [],
        majorRisks: [majorIssue],
        missingVerification: ['no integration test for the new path'],
      });
      const result = serializedValidation(
        findings,
        makeCtx({ assurance: strictAssuranceFixture(findings), obligationType: 'plan' }),
      );
      expect(result).toBeNull();
    });

    it('blocks material findings without a resolved review obligation scope', () => {
      const result = serializedValidation(
        makeFindings({ overallVerdict: 'changes_requested', blockingIssues: [majorIssue] }),
        makeCtx(),
      );
      expect(parseBlocked(result!).code).toBe('REVIEW_SUBJECT_SCOPE_UNAVAILABLE');
    });

    it('identifies the out-of-scope finding and active obligation in the block message', () => {
      const outOfScopeRisk = {
        ...majorIssue,
        relation: {
          subjectAnchors: [
            {
              kind: 'repository_location' as const,
              location: { path: 'src/outside.ts', revision: 'head' as const, line: 1 },
            },
          ],
          evidenceLocations: [],
        },
      };
      const result = serializedValidation(
        makeFindings({ overallVerdict: 'accept', majorRisks: [outOfScopeRisk] }),
        makeCtx({ assurance: strictAssuranceFixture(), obligationType: 'plan' }),
      );

      expect(result).not.toBeNull();
      const blocked = parseBlocked(result!);
      expect(blocked.code).toBe('REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE');
      expect(blocked.message).toContain('finding 0');
      expect(blocked.message).toContain('11111111-1111-4111-8111-111111111111');
    });

    it('reports unable_to_review via its own SSOT path, not the coherence rule', () => {
      const result = serializedValidation(
        makeFindings({ overallVerdict: 'unable_to_review', blockingIssues: [] }),
        makeCtx(),
      );
      expect(parseBlocked(result!).code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });
  });

  // ── Rule 1: mandatory subagent mode ────────────────────────────────────

  describe('Rule 1: mandatory subagent mode', () => {
    it('rejects self-review findings with the independent-review recovery message', () => {
      const result = serializedValidation(makeFindings({ reviewMode: 'self' }), makeCtx());

      expect(result).not.toBeNull();
      const blocked = parseBlocked(result!);
      expect(blocked).toMatchObject({ code: 'REVIEW_MODE_SELF_NOT_ALLOWED', error: true });
      expect(blocked.message).toContain('independent reviewer subagent');
      expect(blocked.message).toContain('reviewMode=self');
    });
  });

  // ── Rule 3: planVersion binding ────────────────────────────────────────

  describe('Rule 3: planVersion binding', () => {
    it('blocks when planVersion too high', () => {
      const result = serializedValidation(
        makeFindings({ planVersion: 99 }),
        makeCtx({ expectedPlanVersion: 1 }),
      );
      expect(result).not.toBeNull();
      const parsed = parseBlocked(result!);
      expect(parsed.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('blocks when planVersion too low', () => {
      const result = serializedValidation(
        makeFindings({ planVersion: 1 }),
        makeCtx({ expectedPlanVersion: 3 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('accepts exact planVersion match', () => {
      const findings = strictFindings({ planVersion: 3 });
      const result = serializedValidation(
        findings,
        makeCtx({
          expectedPlanVersion: 3,
          assurance: strictAssuranceFixture(findings),
          obligationType: 'plan',
        }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Rule 4: iteration binding ──────────────────────────────────────────

  describe('Rule 4: iteration binding', () => {
    it('blocks when iteration too high', () => {
      const result = serializedValidation(
        makeFindings({ iteration: 5 }),
        makeCtx({ expectedIteration: 0 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_ITERATION_MISMATCH');
    });

    it('blocks when iteration too low', () => {
      const result = serializedValidation(
        makeFindings({ iteration: 0 }),
        makeCtx({ expectedIteration: 2 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_ITERATION_MISMATCH');
    });

    it('accepts exact iteration match', () => {
      const findings = strictFindings({ iteration: 2 });
      const result = serializedValidation(
        findings,
        makeCtx({
          expectedIteration: 2,
          assurance: strictAssuranceFixture(findings),
          obligationType: 'plan',
        }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('blocks on first failing rule (subagent before planVersion)', () => {
      // Legacy subagent-disabled is ignored; planVersion binding remains authoritative.
      const result = serializedValidation(
        makeFindings({ reviewMode: 'subagent', planVersion: 99 }),
        makeCtx({ expectedPlanVersion: 1 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('checks planVersion before iteration (rule order)', () => {
      // planVersion wrong AND iteration wrong — should hit Rule 3 (planVersion) first
      const result = serializedValidation(
        makeFindings({ planVersion: 99, iteration: 99 }),
        makeCtx({ expectedPlanVersion: 1, expectedIteration: 0 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('returns structured JSON with error=true on any block', () => {
      const result = serializedValidation(
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
      const result = serializedValidation(
        makeFindings({ planVersion: 1 }),
        makeCtx({ expectedPlanVersion: 0 }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });
  });

  describe('strict assurance', () => {
    it('reports unavailable plugin enforcement when the strict assurance state is absent', () => {
      const result = serializedValidation(strictFindings(), makeCtx({ obligationType: 'plan' }));

      expect(result).not.toBeNull();
      const blocked = parseBlocked(result!);
      expect(blocked).toMatchObject({ code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE', error: true });
      expect(blocked.message).toContain('plugin enforcement hooks are not active');
    });

    it('accepts when strict evidence and attestation match', () => {
      const findings = strictFindings();
      const result = serializedValidation(
        findings,
        makeCtx({
          assurance: strictAssuranceFixture(findings),
          obligationType: 'plan',
        }),
      );
      expect(result).toBeNull();
    });

    it('blocks when strict attestation is missing', () => {
      const findings = makeFindings({ reviewMode: 'subagent' });
      const result = serializedValidation(
        findings,
        makeCtx({
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
      const result = serializedValidation(
        findings,
        makeCtx({
          assurance,
          obligationType: 'plan',
        }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('STRICT_REVIEW_ORCHESTRATION_FAILED');
    });

    it('blocks stale findings before selecting a matching stale obligation', () => {
      const findings = strictFindings({ iteration: 1 });
      const result = serializedValidation(
        findings,
        makeCtx({
          expectedIteration: 0,
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
      const result = serializedValidation(
        tampered,
        makeCtx({
          assurance: strictAssuranceFixture(original),
          obligationType: 'plan',
        }),
      );
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
    });

    it('blocks when submitted findings session differs from invocation child session', () => {
      const findings = strictFindings({ reviewedBy: { sessionId: 'ses_other' } });
      const result = serializedValidation(
        findings,
        makeCtx({
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
      const result = serializedValidation(findings, makeCtx());
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
      const result = serializedValidation(findings, makeCtx());
      expect(result).not.toBeNull();
      expect(parseBlocked(result!).code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });

    it('blocks before strict-mode mandate checks (CORNER: precedence over strict)', () => {
      // unable_to_review must fail closed regardless of strict-mode
      // mandate state. Even if assurance is missing/inconsistent,
      // the unreviewable verdict is the dominant signal.
      const findings = makeFindings({ overallVerdict: 'unable_to_review' });
      const result = serializedValidation(
        findings,
        makeCtx({
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
      const findings = strictFindings({ overallVerdict: 'accept' });
      const result = serializedValidation(
        findings,
        makeCtx({ assurance: strictAssuranceFixture(findings), obligationType: 'plan' }),
      );
      expect(result).toBeNull();
    });

    it('does NOT block when overallVerdict=changes_requested (HAPPY: regression guard)', () => {
      // Symmetric guard for the second 2-valued LoopVerdict.
      const findings = strictFindings({ overallVerdict: 'changes_requested' });
      const result = serializedValidation(
        findings,
        makeCtx({ assurance: strictAssuranceFixture(findings), obligationType: 'plan' }),
      );
      expect(result).toBeNull();
    });
  });

  // ─── F13: architecture obligationType (slice 3) ──────────────
  describe('F13 architecture obligationType', () => {
    it("third-verdict precedence still wins for obligationType: 'architecture'", () => {
      const findings = makeFindings({ overallVerdict: 'unable_to_review' });
      const result = serializedValidation(
        findings,
        makeCtx({
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
      const result = serializedValidation(
        findings,
        makeCtx({
          assurance: archAssurance,
          obligationType: 'architecture',
        }),
      );
      expect(result).toBeNull();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// implementation challenge freshness binding (Gap 2)
// ═════════════════════════════════════════════════════════════════════════════

describe('validateReviewFindings — implementation challenge freshness', () => {
  const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
  const FRESH_ATTEMPT_REF = {
    kind: 'validation_attempt',
    attemptId: '44444444-4444-4444-8444-444444444444',
  };
  const IMPL_REF = { kind: 'implementation', implementationDigest: 'current-digest' };

  function implObligation() {
    return {
      obligationId: OBLIGATION_ID,
      obligationType: 'implement' as const,
      subjectDigest: 'test-subject-digest',
      iteration: 0,
      reviewCycle: 1,
      planVersion: 1,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      maxReviewerAttempts: 1,
      reviewProfile: 'core' as const,
      profileSource: 'policy_default' as const,
      reviewMaterial: freezeReviewMaterial('frozen review material', 'test-subject-digest'),
      createdAt: new Date().toISOString(),
      pluginHandshakeAt: null,
      status: 'pending' as const,
      invocationId: null,
      blockedCode: null,
      fulfilledAt: null,
      consumedAt: null,
      requiredChallengeCount: 1,
      requiredChallengeKind: 'implementation_challenge' as const,
      challengePolicyVersion: 'challenge-policy.v1' as const,
      reviewSubjectScope: {
        kind: 'repository_change' as const,
        paths: ['src/foo.ts'],
        revisions: ['base', 'head'] as const,
      },
    };
  }

  function implChallenge(evidenceRefs: readonly unknown[]): ReviewChallenge {
    return {
      challengeId: '33333333-3333-4333-8333-333333333333',
      obligationId: OBLIGATION_ID,
      scenario: 'The change breaks the failing edge case.',
      claim: 'The new guard handles the null path.',
      locations: ['src/foo.ts:10'],
      kind: 'implementation_challenge' as const,
      evidenceRefs,
      outcome: 'pass' as const,
    } as ReviewChallenge;
  }

  function challengeCtx(
    overrides: UndefinedableOverrides<ReviewFindingsValidationContext> = {},
  ): ReviewFindingsValidationContext {
    return makeCtx({
      obligationType: 'implement',
      assurance: {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [implObligation()],
        invocations: [],
        attempts: [],
        dispatches: [],
      },
      allowedEvidenceRefs: [IMPL_REF, FRESH_ATTEMPT_REF],
      expectedObligationId: OBLIGATION_ID,
      ...overrides,
    });
  }

  function strictChallengeCtx(findings: ReviewFindings): ReviewFindingsValidationContext {
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      obligationType: 'implement',
      requiredChallengeCount: 1,
      requiredChallengeKind: 'implementation_challenge',
    };
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      obligationType: 'implement',
    };
    assurance.attempts[0] = {
      ...assurance.attempts[0]!,
      obligationType: 'implement',
    };
    return makeCtx({
      obligationType: 'implement',
      assurance,
      allowedEvidenceRefs: [IMPL_REF, FRESH_ATTEMPT_REF],
      expectedObligationId: OBLIGATION_ID,
    });
  }

  it('accepts a challenge citing a fresh, allowed validation attempt', () => {
    const findings = strictFindings({
      challenges: [implChallenge([IMPL_REF, FRESH_ATTEMPT_REF])],
    });

    expect(serializedValidation(findings, strictChallengeCtx(findings))).toBeNull();
  });

  it('rejects a challenge citing a validation attempt outside the allowed (fresh) set', () => {
    // The stale/foreign attempt ref is NOT in allowedEvidenceRefs — the exact
    // Gap 2 leak: previously accepted on the directly-submitted path because
    // allowedEvidenceRefs was never passed.
    const staleRef = {
      kind: 'validation_attempt',
      attemptId: '99999999-9999-4999-8999-999999999999',
    };
    const result = serializedValidation(
      makeFindings({ challenges: [implChallenge([IMPL_REF, staleRef])] }),
      challengeCtx(),
    );
    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('SUBAGENT_CHALLENGE_EVIDENCE_MISSING');
  });

  it('rejects a challenge whose obligationId does not match the active obligation', () => {
    const result = serializedValidation(
      makeFindings({
        challenges: [
          {
            ...implChallenge([IMPL_REF, FRESH_ATTEMPT_REF]),
            obligationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          },
        ],
      }),
      challengeCtx(),
    );
    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('SUBAGENT_CHALLENGE_EVIDENCE_MISSING');
  });

  it('falls back to the resolved obligation id when expectedObligationId is not supplied', () => {
    // Even without an explicit expectedObligationId in ctx, the resolved
    // obligation binds the challenge — a foreign obligationId still fails.
    const result = serializedValidation(
      makeFindings({
        challenges: [
          {
            ...implChallenge([IMPL_REF, FRESH_ATTEMPT_REF]),
            obligationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          },
        ],
      }),
      challengeCtx({ expectedObligationId: undefined }),
    );
    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('SUBAGENT_CHALLENGE_EVIDENCE_MISSING');
  });

  it('blocks an accept verdict while prior failing challenges are unaddressed', () => {
    const result = serializedValidation(
      makeFindings({ challenges: [implChallenge([IMPL_REF, FRESH_ATTEMPT_REF])] }),
      challengeCtx({
        unaddressedPriorFailIds: ['00000000-0000-4000-8000-000000000001'],
      }),
    );
    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED');
  });

  it('gates supplied resolution verdicts through the unresolved challenge ids', () => {
    const openId = '00000000-0000-4000-8000-000000000001';
    const result = serializedValidation(
      makeFindings({
        overallVerdict: 'changes_requested',
        challenges: [implChallenge([IMPL_REF, FRESH_ATTEMPT_REF])],
        challengeResolutionVerdicts: [{ challengeId: openId, verdict: 'resolved' }],
      }),
      challengeCtx({ unresolvedImplementationChallengeIds: [openId] }),
    );
    // The resolution verdict is coherent; the strict evidence gap is the next
    // (unrelated) gate. Dropping the unresolved ids would block earlier with
    // SUBAGENT_RESOLUTION_VERDICT_UNEXPECTED.
    expect(parseBlocked(result!).code).toBe('SUBAGENT_EVIDENCE_MISSING');
  });

  it('passes previously used challenge ids into distinctness validation', () => {
    const challenge = implChallenge([IMPL_REF, FRESH_ATTEMPT_REF]);
    const result = serializedValidation(
      makeFindings({ challenges: [challenge] }),
      challengeCtx({ previouslyUsedChallengeIds: [challenge.challengeId] }),
    );
    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('SUBAGENT_CHALLENGE_NOT_DISTINCT');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Admission hardening — branch and payload contracts
//
// These tests exercise the strict / structured-resolution branches that the
// flow suites never reach and pin the interpolated payload where the reason
// registry exposes it. They are the mutation-admission evidence for the
// relocated validation authority.
// ═════════════════════════════════════════════════════════════════════════════

describe('validateReviewFindings — branch and payload contracts', () => {
  const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
  const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';

  function blockedPayload(result: string): Record<string, unknown> {
    return JSON.parse(result) as Record<string, unknown>;
  }

  function issue(overrides: Record<string, unknown> = {}) {
    return {
      severity: 'critical' as const,
      category: 'correctness' as const,
      message: 'contract drift',
      relation: findingRelation(),
      ...overrides,
    };
  }

  it('blocks self-review with the independent-review contract', () => {
    const parsed = blockedPayload(
      serializedValidation(makeFindings({ reviewMode: 'self' }), makeCtx())!,
    );
    expect(parsed.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    expect(String(parsed.message)).toContain('reviewMode=self');
  });

  it('interpolates the unable_to_review obligation context', () => {
    const parsed = blockedPayload(
      serializedValidation(
        makeFindings({ overallVerdict: 'unable_to_review' }),
        makeCtx({ obligationType: 'architecture' }),
      )!,
    );
    expect(parsed.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    expect(String(parsed.message)).toContain('architecture');
  });

  it('interpolates the coherence block count', () => {
    const parsed = blockedPayload(
      serializedValidation(
        makeFindings({ overallVerdict: 'accept', blockingIssues: [issue()] }),
        makeCtx(),
      )!,
    );
    expect(parsed.code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');
    expect(String(parsed.message)).toContain('1 blocking issue');
  });

  it('interpolates the planVersion mismatch payload', () => {
    const parsed = blockedPayload(
      serializedValidation(makeFindings({ planVersion: 7 }), makeCtx())!,
    );
    expect(parsed.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    expect(String(parsed.message)).toContain('plan version 7');
    expect(String(parsed.message)).toContain('plan version 1');
  });

  it('interpolates the iteration mismatch payload', () => {
    const parsed = blockedPayload(serializedValidation(makeFindings({ iteration: 9 }), makeCtx())!);
    expect(parsed.code).toBe('REVIEW_ITERATION_MISMATCH');
    expect(String(parsed.message)).toContain('iteration 9');
    expect(String(parsed.message)).toContain('iteration 0');
  });

  it('interpolates the unresolvable scope payload', () => {
    const parsed = blockedPayload(
      serializedValidation(
        makeFindings({ overallVerdict: 'changes_requested', blockingIssues: [issue()] }),
        makeCtx(),
      )!,
    );
    expect(parsed.code).toBe('REVIEW_SUBJECT_SCOPE_UNAVAILABLE');
    expect(String(parsed.message)).toContain('unresolved');
  });

  it('blocks without strict assurance state', () => {
    const parsed = blockedPayload(
      serializedValidation(strictFindings(), makeCtx({ obligationType: 'plan' }))!,
    );
    expect(parsed.code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    expect(parsed.error).toBe(true);
  });

  it('blocks when no strict obligation matches the expected binding', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations.splice(0);
    const parsed = blockedPayload(
      serializedValidation(findings, makeCtx({ assurance, obligationType: 'plan' }))!,
    );
    expect(parsed.code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    expect(parsed.error).toBe(true);
  });

  it('resolves the strict invocation through the triple match without a bound invocationId', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = { ...assurance.obligations[0]!, invocationId: null };
    expect(
      serializedValidation(findings, makeCtx({ assurance, obligationType: 'plan' })),
    ).toBeNull();
  });

  it('interpolates the missing strict invocation obligation', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = { ...assurance.obligations[0]!, invocationId: null };
    assurance.invocations.splice(0);
    const parsed = blockedPayload(
      serializedValidation(findings, makeCtx({ assurance, obligationType: 'plan' }))!,
    );
    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(String(parsed.message)).toContain(OBLIGATION_ID);
  });

  it('blocks a strict self-session binding', () => {
    const findings = strictFindings({ reviewedBy: { sessionId: 'ses_parent' } });
    const assurance = strictAssuranceFixture(findings);
    const parsed = blockedPayload(
      serializedValidation(
        findings,
        makeCtx({ assurance, obligationType: 'plan', reviewParentSessionId: 'ses_parent' }),
      )!,
    );
    expect(parsed.code).toBe('REVIEW_SELF_APPROVAL_DENIED');
    expect(parsed.error).toBe(true);
  });

  it('blocks a strict attestation mismatch', () => {
    const findings = strictFindings();
    delete (findings as { attestation?: unknown }).attestation;
    const assurance = strictAssuranceFixture(findings);
    const parsed = blockedPayload(
      serializedValidation(findings, makeCtx({ assurance, obligationType: 'plan' }))!,
    );
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBeTruthy();
  });

  it('interpolates the invocation obligation mismatch', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      obligationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    };
    const parsed = blockedPayload(
      serializedValidation(findings, makeCtx({ assurance, obligationType: 'plan' }))!,
    );
    expect(parsed.code).toBe('SUBAGENT_MANDATE_MISMATCH');
    expect(String(parsed.message)).toContain(OBLIGATION_ID);
  });

  it('interpolates the invocation session mismatch', () => {
    const findings = strictFindings({ reviewedBy: { sessionId: 'ses_other' } });
    const assurance = strictAssuranceFixture(findings);
    const parsed = blockedPayload(
      serializedValidation(findings, makeCtx({ assurance, obligationType: 'plan' }))!,
    );
    expect(parsed.code).toBe('REVIEW_FINDINGS_SESSION_MISMATCH');
    expect(String(parsed.message)).toContain('ses_other');
    expect(String(parsed.message)).toContain('ses_child');
  });

  it('interpolates the findings-hash mismatch obligation', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.invocations[0] = { ...assurance.invocations[0]!, findingsHash: 'deadbeef' };
    const parsed = blockedPayload(
      serializedValidation(findings, makeCtx({ assurance, obligationType: 'plan' }))!,
    );
    expect(parsed.code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
    expect(String(parsed.message)).toContain(OBLIGATION_ID);
  });

  it('rejects a mismatched structured-contract parent session', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    const parsed = blockedPayload(
      serializedValidation(
        findings,
        makeCtx({ assurance, obligationType: 'plan', reviewParentSessionId: 'ses_elsewhere' }),
      )!,
    );
    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(String(parsed.message)).toContain(OBLIGATION_ID);
  });

  it('blocks reviewerUnavailable when a host-structured invocation already exists', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    const resolved = resolveStructuredEffectiveFindings({
      pendingObligation: assurance.obligations[0]!,
      expected: { obligationType: 'plan', iteration: 0, planVersion: 1 },
      input: { reviewerUnavailable: true },
      state: { assurance, sessionId: 'ses_parent' },
    });
    expect(resolved.kind).toBe('blocked');
    if (resolved.kind !== 'blocked') throw new Error('expected blocked resolution');
    const parsed = blockedPayload(formatReviewValidationFailure(testLogger, resolved.failure));
    expect(parsed.code).toBe('INVALID_REVIEW_TOOL_SEQUENCE');
    expect(String(parsed.message)).toContain(OBLIGATION_ID);
    expect(String(parsed.message)).toContain('reviewerUnavailable submitted');
  });

  it('blocks reviewerUnavailable without invocations through the strict reviewer recovery', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.invocations.splice(0);
    const resolved = resolveStructuredEffectiveFindings({
      pendingObligation: assurance.obligations[0]!,
      expected: { obligationType: 'plan', iteration: 0, planVersion: 1 },
      input: { reviewerUnavailable: true },
      state: { assurance, sessionId: 'ses_parent' },
    });
    expect(resolved.kind).toBe('blocked');
    if (resolved.kind !== 'blocked') throw new Error('expected blocked resolution');
    const parsed = blockedPayload(formatReviewValidationFailure(testLogger, resolved.failure));
    expect(parsed.code).toBe('REVIEWER_UNAVAILABLE_STRICT');
    expect(String(parsed.message)).toContain('reviewer unavailable');
    expect(String(parsed.recovery)).toContain('structured reviewer transport');
  });

  it('resolves captured evidence findings through the structured resolution', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.attempts[0] = { ...assurance.attempts[0]!, childSessionId: 'ses_child' };
    const resolved = resolveStructuredEffectiveFindings({
      pendingObligation: assurance.obligations[0]!,
      expected: { obligationType: 'plan', iteration: 0, planVersion: 1 },
      input: {},
      state: { assurance, sessionId: 'ses_parent' },
    });
    expect(resolved.kind).toBe('resolved');
    expect((resolved as { evidenceInvocationId: string }).evidenceInvocationId).toBe(INVOCATION_ID);
  });

  it('formats rejected structured resolutions through the acceptance authority', () => {
    const parsed = blockedPayload(
      formatReviewValidationFailure(
        testLogger,
        structuredResolutionFailure({
          kind: 'rejected',
          rejection: { reason: 'SUBAGENT_EVIDENCE_REUSED', status: 'invocation_consumed' },
        }),
      ),
    );
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_REUSED');
  });

  it('formats incoherent structured resolutions with stringified details', () => {
    const parsed = blockedPayload(
      formatReviewValidationFailure(
        testLogger,
        structuredResolutionFailure({
          kind: 'incoherent',
          code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
          details: { index: 1, flag: true },
          invocationId: INVOCATION_ID,
          attemptId: '55555555-5555-4555-8555-555555555555',
        }),
      ),
    );
    expect(parsed.code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');
  });

  it('formats attempt-lineage-unavailable structured resolutions', () => {
    const parsed = blockedPayload(
      formatReviewValidationFailure(
        testLogger,
        structuredResolutionFailure({
          kind: 'attempt_lineage_unavailable',
          invocationId: INVOCATION_ID,
          obligationId: OBLIGATION_ID,
        }),
      ),
    );
    expect(parsed.code).toBe('REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE');
    expect(String(parsed.message)).toContain(INVOCATION_ID);
    expect(String(parsed.message)).toContain(OBLIGATION_ID);
  });

  it('formats unparseable structured resolutions and keeps diagnostics out of the envelope', () => {
    const logged: Array<{ service: string; message: string; extra?: Record<string, unknown> }> = [];
    const logger = {
      warn: (service: string, message: string, extra?: Record<string, unknown>) => {
        logged.push(extra === undefined ? { service, message } : { service, message, extra });
      },
    };
    const failure = structuredResolutionFailure({
      kind: 'unparseable',
      detail: 'invalid JSON at 3',
      diagnostics: {
        obligationId: OBLIGATION_ID,
        invocationId: INVOCATION_ID,
        issues: ['findings.0.overallVerdict: Required'],
      },
    });
    const raw = formatReviewValidationFailure(logger, failure);
    const parsed = blockedPayload(raw);
    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(parsed.error).toBe(true);
    expect(raw).not.toContain(OBLIGATION_ID);
    expect(raw).not.toContain(INVOCATION_ID);
    expect(raw).not.toContain('findings.0.overallVerdict');
    expect(logged).toEqual([
      {
        service: 'flowguard_review',
        message: 'structured captured findings present but unparseable; treated as unparseable',
        extra: {
          obligationId: OBLIGATION_ID,
          invocationId: INVOCATION_ID,
          issues: ['findings.0.overallVerdict: Required'],
        },
      },
    ]);
  });

  it('formats not-found structured resolutions', () => {
    const parsed = blockedPayload(
      formatReviewValidationFailure(testLogger, structuredResolutionFailure({ kind: 'not_found' })),
    );
    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(parsed.error).toBe(true);
  });

  it('does not resolve a triple match whose child session differs', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = { ...assurance.obligations[0]!, invocationId: null };
    assurance.invocations[0] = { ...assurance.invocations[0]!, childSessionId: 'ses_other' };
    const parsed = blockedPayload(
      serializedValidation(findings, makeCtx({ assurance, obligationType: 'plan' }))!,
    );
    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(String(parsed.message)).toContain(OBLIGATION_ID);
  });

  it('does not resolve a triple match whose findings hash differs', () => {
    const findings = strictFindings();
    const assurance = strictAssuranceFixture(findings);
    assurance.obligations[0] = { ...assurance.obligations[0]!, invocationId: null };
    assurance.invocations[0] = { ...assurance.invocations[0]!, findingsHash: 'not-the-hash' };
    const parsed = blockedPayload(
      serializedValidation(findings, makeCtx({ assurance, obligationType: 'plan' }))!,
    );
    expect(parsed.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(String(parsed.message)).toContain(OBLIGATION_ID);
  });

  it('formats invalid structured resolutions with the obligation id', () => {
    const parsed = blockedPayload(
      formatReviewValidationFailure(
        testLogger,
        structuredResolutionFailure({
          kind: 'invalid',
          code: 'REVIEW_FINDINGS_HASH_MISMATCH',
          obligationId: OBLIGATION_ID,
        }),
      ),
    );
    expect(parsed.code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
    expect(String(parsed.message)).toContain(OBLIGATION_ID);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Structured evidence resolution — diagnostics and deferral merges
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveStructuredFindings — diagnostics and deferral merges', () => {
  const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
  const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
  const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';

  function findings() {
    return makeFindings({ reviewedBy: { sessionId: 'ses_child' } });
  }

  function assuranceFor(
    captured: ReviewFindings,
  ): NonNullable<ReviewFindingsValidationContext['assurance']> {
    return {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      attempts: [
        {
          attemptId: ATTEMPT_ID,
          obligationId: OBLIGATION_ID,
          obligationType: 'plan' as const,
          subjectDigest: 'test-subject-digest',
          ordinal: 0,
          status: 'bound' as const,
          origin: { kind: 'initial' } as const,
          repositoryDiscovery: { kind: 'not_applicable' } as const,
          observations: [],
          childSessionId: 'ses_child',
          createdAt: new Date().toISOString(),
        },
      ],
      dispatches: [],
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'plan' as const,
          reviewCycle: 1,
          requiredChallengeCount: 0,
          requiredChallengeKind: 'design_challenge' as const,
          challengePolicyVersion: 'challenge-policy.v1' as const,
          subjectDigest: 'test-subject-digest',
          iteration: 0,
          planVersion: 1,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          maxReviewerAttempts: 1,
          reviewProfile: 'core' as const,
          profileSource: 'policy_default' as const,
          reviewMaterial: freezeReviewMaterial('frozen review material', 'test-subject-digest'),
          createdAt: new Date().toISOString(),
          pluginHandshakeAt: new Date().toISOString(),
          status: 'fulfilled' as const,
          invocationId: INVOCATION_ID,
          blockedCode: null,
          fulfilledAt: new Date().toISOString(),
          consumedAt: null,
          reviewSubjectScope: {
            kind: 'repository_change' as const,
            paths: ['src/foo.ts'],
            revisions: ['base', 'head'] as const,
          },
          repositoryRevisionProvenance: {
            kind: 'available' as const,
            headSha: 'a'.repeat(40),
            baseSha: 'b'.repeat(40),
          },
        },
      ],
      invocations: [
        {
          invocationId: INVOCATION_ID,
          obligationId: OBLIGATION_ID,
          obligationType: 'plan' as const,
          parentSessionId: 'ses_parent',
          childSessionId: 'ses_child',
          agentType: 'flowguard-reviewer' as const,
          attemptId: ATTEMPT_ID,
          invocationMode: 'native_task_structured_followup' as const,
          reviewOutputMode: 'structured_output' as const,
          structuredOutputUsed: true,
          reviewAssuranceLevel: 'structured_high' as const,
          hostVisible: true,
          transcriptNavigable: true,
          source: 'host-orchestrated' as const,
          promptHash: 'abc',
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          findingsHash: hashFindings(captured),
          capturedRawFindings: captured,
          invokedAt: new Date().toISOString(),
          fulfilledAt: new Date().toISOString(),
          consumedByObligationId: null,
        },
      ],
    };
  }

  function resolveWith(
    captured: ReviewFindings,
    mutate: (assurance: ReturnType<typeof assuranceFor>) => void = () => {},
  ) {
    const assurance = assuranceFor(captured);
    mutate(assurance);
    return resolveStructuredFindings(
      assurance,
      assurance.obligations[0]!,
      undefined,
      undefined,
      undefined,
      undefined,
      'ses_parent',
    );
  }

  it('returns not_found when obligation or assurance is missing', () => {
    expect(
      resolveStructuredFindings(
        undefined,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).toEqual({ resolution: { kind: 'not_found' }, diagnostics: [] });
  });

  it('reports attempt_lineage_unavailable when no exact bound attempt exists', () => {
    const captured = findings();
    const { resolution } = resolveWith(captured, (assurance) => {
      assurance.attempts[0] = { ...assurance.attempts[0]!, childSessionId: 'ses_elsewhere' };
    });
    expect(resolution.kind).toBe('attempt_lineage_unavailable');
    if (resolution.kind !== 'attempt_lineage_unavailable') return;
    expect(resolution.invocationId).toBe(INVOCATION_ID);
    expect(resolution.obligationId).toBe(OBLIGATION_ID);
  });

  it('reports unparseable when captured findings fail schema validation', () => {
    const { resolution } = resolveWith({ nonsense: true } as unknown as ReviewFindings);
    expect(resolution.kind).toBe('unparseable');
    if (resolution.kind !== 'unparseable') return;
    expect(resolution.detail).not.toBe('unknown schema validation failure');
    expect(resolution.detail.length).toBeGreaterThan(0);
  });

  it('reports incoherent with the blocking issue count', () => {
    const captured = makeFindings({
      overallVerdict: 'accept',
      reviewedBy: { sessionId: 'ses_child' },
      blockingIssues: [
        {
          severity: 'critical' as const,
          category: 'correctness' as const,
          message: 'drift',
          relation: findingRelation(),
        },
      ],
    });
    const { resolution } = resolveWith(captured);
    expect(resolution.kind).toBe('incoherent');
    if (resolution.kind !== 'incoherent') return;
    expect(resolution.code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');
    expect(resolution.blockingIssueCount).toBe(1);
  });

  it('reports invalid when every matching invocation is skipped', () => {
    const captured = findings();
    const { resolution } = resolveWith(captured, (assurance) => {
      assurance.invocations[0] = { ...assurance.invocations[0]!, parentSessionId: 'ses_other' };
    });
    expect(resolution.kind).toBe('invalid');
    if (resolution.kind !== 'invalid') return;
    expect(resolution.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    expect(resolution.obligationId).toBe(OBLIGATION_ID);
  });

  it('reports invalid on a captured findings hash mismatch', () => {
    const captured = findings();
    const { resolution } = resolveWith(captured, (assurance) => {
      assurance.invocations[0] = { ...assurance.invocations[0]!, findingsHash: 'not-the-hash' };
    });
    expect(resolution.kind).toBe('invalid');
    if (resolution.kind !== 'invalid') return;
    expect(resolution.code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
  });

  it('prefers the lineage diagnostic when deferred diagnostics are merged', () => {
    const captured = findings();
    const { resolution } = resolveWith(captured, (assurance) => {
      const first = assurance.invocations[0]!;
      assurance.invocations.push({
        ...first,
        invocationId: '33333333-3333-4333-8333-333333333333',
        attemptId: '66666666-6666-4666-8666-666666666666',
        findingsHash: hashFindings(
          makeFindings({
            overallVerdict: 'accept',
            blockingIssues: [
              {
                severity: 'critical' as const,
                category: 'correctness' as const,
                message: 'drift',
                relation: findingRelation(),
              },
            ],
          }),
        ),
        capturedRawFindings: makeFindings({
          overallVerdict: 'accept',
          blockingIssues: [
            {
              severity: 'critical' as const,
              category: 'correctness' as const,
              message: 'drift',
              relation: findingRelation(),
            },
          ],
        }),
      });
      // First invocation: no bound attempt -> lineage diagnostic.
      assurance.attempts[0] = { ...assurance.attempts[0]!, childSessionId: 'ses_elsewhere' };
    });
    expect(resolution.kind).toBe('attempt_lineage_unavailable');
  });

  it('keeps the unparseable warning when a later capture resolves', () => {
    const captured = findings();
    const first = assuranceFor(captured).invocations[0]!;
    const unusable = {
      ...first,
      invocationId: '44444444-4444-4444-8444-444444444444',
      capturedRawFindings: { nonsense: true } as unknown as Record<string, unknown>,
      findingsHash: 'unusable-capture',
    };
    const { resolution, diagnostics } = resolveWith(captured, (assurance) => {
      assurance.invocations.unshift(unusable);
    });

    expect(resolution.kind).toBe('resolved');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.invocationId).toBe(unusable.invocationId);
    expect(diagnostics[0]?.issues.length).toBeGreaterThan(0);
  });
});
