/**
 * @module integration/tools/review-validation-byte-test-fixtures
 * @description Scenario corpus for the byte-exact envelope comparison between
 * the pre-refactor and post-refactor review validation boundaries.
 *
 * Test-support only: the corpus uses only APIs that exist unchanged before and
 * after the refactor, so the same module can drive the base-commit capture and
 * the head comparison. The hash authority is injected because its location
 * moved (`evidence/findings-hash.ts` -> `findings-hash.ts`).
 */

import type {
  ReviewAssuranceState,
  ReviewInvocationEvidence,
  ReviewObligation,
} from '../../state/evidence.js';
import type { ReviewFindings } from '../../state/evidence.js';
import type { ReviewFindingsValidationContext } from '../review/validation/review-validation.js';
import {
  artifactReviewSubjectScope,
  buildInvocationEvidence,
  createReviewObligation,
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../review/obligations/assurance.js';
import { createReviewAttempt } from '../review/obligations/attempt-lifecycle.js';

const NOW = '2026-05-10T12:00:00.000Z';
const PARENT_SESSION = 'ses_parent';
const CHILD_SESSION = 'ses_child';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
const UPSTREAM = { host: 'github.com', owner: 'upstream', name: 'repo' };
const HEAD_SHA = 'c'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

export type HashFindings = (findings: Record<string, unknown>) => string;

export interface ByteValidationScenario {
  readonly id: string;
  /** Expected final blocked code — proves the scenario reaches its intended path. */
  readonly expectedCode: string;
  readonly findings: ReviewFindings;
  readonly ctx: unknown;
}

export interface ByteResolutionScenario {
  readonly id: string;
  readonly expectedCode: string;
  readonly resolution: Record<string, unknown>;
  readonly diagnostics: readonly Record<string, unknown>[];
}

export interface ByteEffectiveScenario {
  readonly id: string;
  readonly expectedCode: string;
  readonly ctx: Record<string, unknown>;
}

export interface ByteCorpus {
  readonly validation: readonly ByteValidationScenario[];
  readonly resolution: readonly ByteResolutionScenario[];
  readonly effective: readonly ByteEffectiveScenario[];
}

function implementationRelation(locations: readonly unknown[]): unknown {
  return {
    subjectAnchors: [{ kind: 'implementation', implementationDigest: 'impl-digest' }],
    evidenceLocations: [...locations],
  };
}

function buildBaseFindings(overrides: Record<string, unknown> = {}): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    reviewedBy: { sessionId: CHILD_SESSION },
    reviewedAt: NOW,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: OBLIGATION_ID,
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  } as unknown as ReviewFindings;
}

interface StrictFixture {
  readonly obligation: ReviewObligation;
  readonly invocation: ReviewInvocationEvidence;
  readonly assurance: ReviewAssuranceState;
  readonly ctx: unknown;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function implementationObligation(): ReviewObligation {
  return {
    ...createReviewObligation({
      obligationType: 'implement',
      iteration: 0,
      reviewCycle: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'impl-digest',
      reviewMaterial: freezeReviewMaterial('frozen review material', 'impl-digest'),
      reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
      changedFiles: ['docs/test.md'],
      repositoryAuthority: {
        kind: 'candidate_pair',
        base: { kind: 'commit', repositoryIdentity: UPSTREAM, objectSha: BASE_SHA },
        head: { kind: 'commit', repositoryIdentity: UPSTREAM, objectSha: HEAD_SHA },
      },
    }),
    obligationId: OBLIGATION_ID,
  };
}

function buildStrictFixture(
  hashFindings: HashFindings,
  mutate: (fixture: {
    obligation: Mutable<ReviewObligation>;
    invocation: Mutable<ReviewInvocationEvidence>;
    findings: ReviewFindings;
  }) => void = () => {},
): StrictFixture {
  const findings = buildBaseFindings();
  const obligation = {
    ...implementationObligation(),
    status: 'fulfilled' as const,
    invocationId: INVOCATION_ID,
    fulfilledAt: NOW,
  };
  const invocation: ReviewInvocationEvidence = {
    ...buildInvocationEvidence({
      obligationId: obligation.obligationId,
      obligationType: obligation.obligationType,
      mandateDigest: obligation.mandateDigest,
      criteriaVersion: obligation.criteriaVersion,
      parentSessionId: PARENT_SESSION,
      childSessionId: CHILD_SESSION,
      promptHash: 'a'.repeat(64),
      findingsHash: hashFindings(findings),
      invokedAt: NOW,
      fulfilledAt: NOW,
      capturedRawFindings: findings,
      attemptId: ATTEMPT_ID,
    }),
    invocationId: INVOCATION_ID,
  };
  const attempt = {
    ...createReviewAttempt({
      obligationId: obligation.obligationId,
      obligationType: obligation.obligationType,
      subjectDigest: obligation.subjectDigest,
      ordinal: 1,
      childSessionId: CHILD_SESSION,
      origin: { kind: 'initial' },
      repositoryDiscovery: { kind: 'not_applicable' },
      observationCapability: null,
      now: NOW,
    }),
    status: 'bound' as const,
  };
  const context = {
    obligation: obligation as Mutable<ReviewObligation>,
    invocation: invocation as Mutable<ReviewInvocationEvidence>,
    findings,
  };
  mutate(context);

  const assurance = {
    assuranceSchemaVersion: 'review-assurance.v6' as const,
    obligations: [context.obligation],
    invocations: [context.invocation],
    attempts: [attempt],
    dispatches: [],
  } as unknown as ReviewAssuranceState;
  const ctx: ReviewFindingsValidationContext = {
    expectedPlanVersion: 1,
    expectedIteration: 0,
    assurance,
    obligationType: 'implement',
    expectedObligationId: context.obligation.obligationId,
  };
  return { obligation: context.obligation, invocation: context.invocation, assurance, ctx };
}

function structuredObligation(): ReviewObligation {
  return {
    ...createReviewObligation({
      obligationType: 'plan',
      iteration: 0,
      reviewCycle: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'plan-digest',
      reviewMaterial: freezeReviewMaterial('frozen review material', 'plan-digest'),
      reviewSubjectScope: artifactReviewSubjectScope('plan', '## Approach\nBody', 'plan-digest'),
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    }),
    obligationId: OBLIGATION_ID,
  };
}

export function buildByteCorpus(hashFindings: HashFindings): ByteCorpus {
  const validation: ByteValidationScenario[] = [];

  validation.push({
    id: 'validation.mode-self',
    expectedCode: 'REVIEW_MODE_SELF_NOT_ALLOWED',
    findings: buildBaseFindings({ reviewMode: 'self' }),
    ctx: {},
  });
  validation.push({
    id: 'validation.unable-to-review',
    expectedCode: 'SUBAGENT_UNABLE_TO_REVIEW',
    findings: buildBaseFindings({ overallVerdict: 'unable_to_review' }),
    ctx: {},
  });
  validation.push({
    id: 'validation.verdict-blocking-incoherent',
    expectedCode: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
    findings: buildBaseFindings({
      overallVerdict: 'accept',
      blockingIssues: [
        {
          severity: 'major',
          category: 'correctness',
          message: 'drift',
          relation: implementationRelation([]),
        },
      ],
    }),
    ctx: {},
  });
  validation.push({
    id: 'validation.plan-version-mismatch',
    expectedCode: 'REVIEW_PLAN_VERSION_MISMATCH',
    findings: buildBaseFindings({ planVersion: 7 }),
    ctx: {},
  });
  validation.push({
    id: 'validation.iteration-mismatch',
    expectedCode: 'REVIEW_ITERATION_MISMATCH',
    findings: buildBaseFindings({ iteration: 9 }),
    ctx: { expectedPlanVersion: 1, expectedIteration: 0 },
  });
  validation.push({
    id: 'validation.strict-assurance-missing',
    expectedCode: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    findings: buildBaseFindings(),
    ctx: { expectedPlanVersion: 1, expectedIteration: 0 },
  });
  validation.push({
    id: 'validation.strict-obligation-missing',
    expectedCode: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    findings: buildBaseFindings(),
    ctx: {
      expectedPlanVersion: 1,
      expectedIteration: 0,
      assurance: {
        assuranceSchemaVersion: 'review-assurance.v6',
        obligations: [],
        invocations: [],
        attempts: [],
        dispatches: [],
      } as unknown as ReviewAssuranceState,
      obligationType: 'implement',
    },
  });
  validation.push({
    id: 'validation.scope-unavailable',
    expectedCode: 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE',
    findings: buildBaseFindings({
      blockingIssues: [
        {
          severity: 'major',
          category: 'correctness',
          message: 'scope drift',
          relation: implementationRelation([]),
        },
      ],
    }),
    ctx: { expectedPlanVersion: 1, expectedIteration: 0 },
  });
  validation.push({
    id: 'validation.evidence-not-observed',
    expectedCode: 'REVIEW_EVIDENCE_NOT_OBSERVED',
    findings: buildBaseFindings({
      blockingIssues: [
        {
          severity: 'major',
          category: 'correctness',
          message: 'cited',
          relation: implementationRelation([{ path: 'src/foo.ts', revision: 'head' }]),
        },
      ],
    }),
    ctx: buildStrictFixture(hashFindings).ctx,
  });
  validation.push({
    id: 'validation.strict-invocation-missing',
    expectedCode: 'SUBAGENT_EVIDENCE_MISSING',
    findings: buildBaseFindings(),
    ctx: buildStrictFixture(hashFindings, ({ invocation }) => {
      invocation.invocationId = '33333333-3333-4333-8333-333333333333';
    }).ctx,
  });
  validation.push({
    id: 'validation.strict-self-approval',
    expectedCode: 'REVIEW_SELF_APPROVAL_DENIED',
    findings: buildBaseFindings(),
    ctx: {
      ...(buildStrictFixture(hashFindings).ctx as Record<string, unknown>),
      reviewParentSessionId: CHILD_SESSION,
    },
  });
  validation.push({
    id: 'validation.strict-session-mismatch',
    expectedCode: 'REVIEW_FINDINGS_SESSION_MISMATCH',
    findings: buildBaseFindings({ reviewedBy: { sessionId: 'ses_other' } }),
    ctx: buildStrictFixture(hashFindings).ctx,
  });
  validation.push({
    id: 'validation.strict-hash-mismatch',
    expectedCode: 'REVIEW_FINDINGS_HASH_MISMATCH',
    findings: buildBaseFindings(),
    ctx: buildStrictFixture(hashFindings, ({ invocation }) => {
      invocation.findingsHash = 'not-the-findings-hash';
    }).ctx,
  });
  validation.push({
    id: 'validation.strict-attestation-missing',
    expectedCode: 'SUBAGENT_MANDATE_MISSING',
    findings: buildBaseFindings({ attestation: undefined }),
    ctx: buildStrictFixture(hashFindings).ctx,
  });
  validation.push({
    id: 'validation.strict-attestation-mismatch',
    expectedCode: 'SUBAGENT_MANDATE_MISMATCH',
    findings: buildBaseFindings({
      attestation: {
        mandateDigest: 'other-mandate',
        criteriaVersion: 'other-criteria',
        toolObligationId: OBLIGATION_ID,
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    }),
    ctx: buildStrictFixture(hashFindings).ctx,
  });
  validation.push({
    id: 'validation.strict-contract-missing',
    expectedCode: 'SUBAGENT_EVIDENCE_MISSING',
    findings: buildBaseFindings(),
    ctx: buildStrictFixture(hashFindings, ({ invocation }) => {
      (invocation as unknown as Record<string, unknown>).hostVisible = false;
    }).ctx,
  });

  const resolution: ByteResolutionScenario[] = [
    {
      id: 'resolution.rejected-blocked',
      expectedCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
      resolution: {
        kind: 'rejected',
        rejection: {
          reason: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
          status: 'blocked',
          obligationId: OBLIGATION_ID,
          blockedCode: 'REVIEWER_CONTEXT_UNAVAILABLE',
        },
      },
      diagnostics: [],
    },
    {
      id: 'resolution.rejected-consumed',
      expectedCode: 'SUBAGENT_EVIDENCE_REUSED',
      resolution: {
        kind: 'rejected',
        rejection: {
          reason: 'SUBAGENT_EVIDENCE_REUSED',
          status: 'consumed',
          obligationId: OBLIGATION_ID,
        },
      },
      diagnostics: [],
    },
    {
      id: 'resolution.rejected-invocation-consumed',
      expectedCode: 'SUBAGENT_EVIDENCE_REUSED',
      resolution: {
        kind: 'rejected',
        rejection: {
          reason: 'SUBAGENT_EVIDENCE_REUSED',
          status: 'invocation_consumed',
          invocationId: INVOCATION_ID,
          consumedBy: OBLIGATION_ID,
        },
      },
      diagnostics: [],
    },
    {
      id: 'resolution.incoherent-verdict',
      expectedCode: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
      resolution: {
        kind: 'incoherent',
        code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
        details: { overallVerdict: 'accept', blockingIssueCount: 2 },
        invocationId: INVOCATION_ID,
        attemptId: ATTEMPT_ID,
        blockingIssueCount: 2,
      },
      diagnostics: [],
    },
    {
      id: 'resolution.incoherent-challenge',
      expectedCode: 'SUBAGENT_CHALLENGE_COUNT_INCOHERENT',
      resolution: {
        kind: 'incoherent',
        code: 'SUBAGENT_CHALLENGE_COUNT_INCOHERENT',
        details: { requiredChallengeCount: 1, observedChallengeCount: 0, flag: true },
        invocationId: INVOCATION_ID,
        attemptId: ATTEMPT_ID,
      },
      diagnostics: [],
    },
    {
      id: 'resolution.attempt-lineage-unavailable',
      expectedCode: 'REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE',
      resolution: {
        kind: 'attempt_lineage_unavailable',
        invocationId: INVOCATION_ID,
        obligationId: OBLIGATION_ID,
      },
      diagnostics: [],
    },
    {
      id: 'resolution.unparseable',
      expectedCode: 'SUBAGENT_EVIDENCE_MISSING',
      resolution: {
        kind: 'unparseable',
        detail: 'findings.overallVerdict: Required; findings.iteration: Expected number',
        diagnostics: {
          obligationId: OBLIGATION_ID,
          invocationId: INVOCATION_ID,
          issues: ['findings.overallVerdict: Required'],
        },
      },
      diagnostics: [
        {
          obligationId: OBLIGATION_ID,
          invocationId: INVOCATION_ID,
          issues: ['findings.overallVerdict: Required'],
        },
      ],
    },
    {
      id: 'resolution.not-found',
      expectedCode: 'SUBAGENT_EVIDENCE_MISSING',
      resolution: { kind: 'not_found' },
      diagnostics: [],
    },
    {
      id: 'resolution.invalid-hash-mismatch',
      expectedCode: 'REVIEW_FINDINGS_HASH_MISMATCH',
      resolution: {
        kind: 'invalid',
        code: 'REVIEW_FINDINGS_HASH_MISMATCH',
        obligationId: OBLIGATION_ID,
      },
      diagnostics: [],
    },
    {
      id: 'resolution.invalid-evidence-missing',
      expectedCode: 'SUBAGENT_EVIDENCE_MISSING',
      resolution: {
        kind: 'invalid',
        code: 'SUBAGENT_EVIDENCE_MISSING',
        obligationId: OBLIGATION_ID,
      },
      diagnostics: [],
    },
  ];

  const withInvocations = structuredObligation();
  const effective: ByteEffectiveScenario[] = [
    {
      id: 'effective.reviewer-unavailable-misuse',
      expectedCode: 'INVALID_REVIEW_TOOL_SEQUENCE',
      ctx: {
        pendingObligation: withInvocations,
        expected: { obligationType: 'plan', iteration: 0, planVersion: 1 },
        input: { reviewerUnavailable: true },
        state: {
          assurance: {
            assuranceSchemaVersion: 'review-assurance.v6',
            obligations: [withInvocations],
            invocations: [
              buildInvocationEvidence({
                obligationId: withInvocations.obligationId,
                obligationType: withInvocations.obligationType,
                mandateDigest: withInvocations.mandateDigest,
                criteriaVersion: withInvocations.criteriaVersion,
                parentSessionId: PARENT_SESSION,
                childSessionId: CHILD_SESSION,
                promptHash: 'a'.repeat(64),
                findingsHash: 'irrelevant',
                invokedAt: NOW,
                fulfilledAt: NOW,
                capturedRawFindings: {},
                attemptId: ATTEMPT_ID,
              }),
            ],
            attempts: [],
            dispatches: [],
          },
          sessionId: PARENT_SESSION,
        },
      },
    },
    {
      id: 'effective.reviewer-unavailable-strict',
      expectedCode: 'REVIEWER_UNAVAILABLE_STRICT',
      ctx: {
        pendingObligation: structuredObligation(),
        expected: { obligationType: 'plan', iteration: 0, planVersion: 1 },
        input: { reviewerUnavailable: true },
        state: {
          assurance: {
            assuranceSchemaVersion: 'review-assurance.v6',
            obligations: [],
            invocations: [],
            attempts: [],
            dispatches: [],
          },
          sessionId: PARENT_SESSION,
        },
      },
    },
  ];

  return { validation, resolution, effective };
}
