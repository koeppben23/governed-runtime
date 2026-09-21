/**
 * @module integration/review/observation-binding.test
 * @description Adversarial matrix for canonical repository evidence binding.
 *
 * The binder never acquires anything: a valid evidenceLocation without a
 * matching authoritative Observation is `evidence_unavailable` — never
 * schema_invalid, never output-repairable. Covers the pure binder, the
 * host-task bind path, and the direct/submitted validator path.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';
import { assuranceWith as fixtureAssuranceWith } from '../../../fixtures.js';
import {
  bindRepositoryEvidenceLocations,
  type BindingFindingRelation,
} from './observation-binding.js';
import {
  artifactReviewSubjectScope,
  createReviewAttempt,
  createReviewObligation,
  ensureReviewAssurance,
  freezeReviewMaterial,
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../obligations/assurance.js';
import { mintObservationCapability } from '../obligations/attempt-lifecycle.js';
import { completedDispatchForInvocation } from '../../../state/evidence-test-constants.js';
import { validateReviewFindings } from '../review-validation.js';
import {
  NOW,
  SESSION_ID,
  CHILD_SESSION_ID,
} from '../../plugin-host-task-diagnostics-test-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type {
  RepositoryObservation,
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewInvocationEvidence,
  ReviewObligation,
} from '../../../state/evidence.js';
import type { ReviewFindings } from '../../../state/evidence.js';

const UPSTREAM = { host: 'github.com', owner: 'upstream', name: 'repo' };
const FORK = { host: 'github.com', owner: 'contributor', name: 'fork' };
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);
const TREE_SHA = 'd'.repeat(40);
const NOW_ISO = '2026-05-10T12:00:00.000Z';

function candidateObligation(
  headKind: 'commit' | 'tree' = 'commit',
  obligationType: 'plan' | 'implement' = 'implement',
): ReviewObligation {
  return createReviewObligation({
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerAttempts: 1,
    },
    obligationType,
    iteration: 0,
    reviewCycle: 1,
    planVersion: 1,
    now: NOW_ISO,
    subjectDigest: 'impl-digest',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'impl-digest'),
    ...(obligationType === 'plan'
      ? {
          reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'impl-digest'),
        }
      : {
          reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
        }),
    changedFiles: ['docs/test.md'],
    repositoryAuthority: {
      kind: 'candidate_pair',
      base: { kind: 'commit', repositoryIdentity: UPSTREAM, objectSha: BASE_SHA },
      head: { kind: headKind, repositoryIdentity: FORK, objectSha: HEAD_SHA },
    },
    ...(obligationType === 'plan' ? { repositoryEvidenceFreeze: { kind: 'available' } } : {}),
  });
}

function makeObservation(
  obligation: ReviewObligation,
  attempt: ReviewAttempt,
  overrides: Partial<RepositoryObservation> & { revision?: 'base' | 'head' } = {},
): RepositoryObservation {
  const base: RepositoryObservation = {
    observationId: '11111111-1111-4111-8111-111111111111',
    obligationId: obligation.obligationId,
    attemptId: attempt.attemptId,
    observedBySessionId: attempt.childSessionId ?? CHILD_SESSION_ID,
    path: 'src/foo.ts',
    revision: 'head',
    repositoryIdentity: FORK,
    resolvedObjectSha: HEAD_SHA,
    resolvedObjectKind: 'commit',
    contentDigest: 'sha256:' + 'a'.repeat(64),
    byteLength: 10,
    representation: 'utf8_text',
    lineCount: 12,
    capturedAt: NOW_ISO,
    boundAt: NOW_ISO,
    acquisition: { kind: 'local_git_object' },
  };
  return { ...base, ...overrides };
}

function attemptFor(obligation: ReviewObligation, sessionId: string): ReviewAttempt {
  return createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    ordinal: 1,
    childSessionId: sessionId,
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'repository', snapshot: snapshot() },
    observationCapability: mintObservationCapability(),
    now: NOW_ISO,
  });
}

function snapshot() {
  return {
    observedAt: NOW_ISO,
    discoveryDigest: null,
    workspaceFingerprint: null,
    health: {
      status: 'available',
      healthy: true,
      failedCollectorNames: [],
      hasBudgetExhaustion: false,
      ageWarning: null,
      notVerified: [],
    },
    drift: { status: 'clean', drifted: false, changedContributorNames: [], notVerified: [] },
    detectedStack: null,
    verificationCandidates: [],
    riskSurfaces: [],
    warnings: [],
    notVerified: [],
  } as ReviewAttempt['repositoryDiscovery'] extends infer R
    ? R extends { kind: 'repository'; snapshot: infer S }
      ? S
      : never
    : never;
}

function relationWith(
  locations: BindingFindingRelation['relation']['evidenceLocations'],
): BindingFindingRelation {
  return {
    relation: {
      evidenceLocations: locations,
    },
  };
}

function bind(
  obligation: ReviewObligation,
  attempt: ReviewAttempt | null,
  childSessionId: string,
  locations: BindingFindingRelation['relation']['evidenceLocations'],
) {
  return bindRepositoryEvidenceLocations({
    findings: [relationWith(locations)],
    obligation,
    attempt,
    childSessionId,
  });
}

describe('pure binder — adversarial matrix', () => {
  it('HAPPY: matching frozen head observation binds', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const observation = makeObservation(obligation, baseAttempt);
    const attempt: ReviewAttempt = { ...baseAttempt, observations: [observation] };
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('BAD: worktree-only read (no observation) cannot prove head evidence', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('evidence_unavailable');
  });

  it('BAD: base citation with only a head observation is rejected', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      observations: [makeObservation(obligation, baseAttempt, { revision: 'head' })],
    };
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'base' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('BAD: attempt A observes, attempt B cites without observing — rejected', () => {
    const obligation = candidateObligation();
    const baseAttemptA = attemptFor(obligation, 'session-A');
    const attemptA: ReviewAttempt = {
      ...baseAttemptA,
      observations: [
        makeObservation(obligation, baseAttemptA, { observedBySessionId: 'session-A' }),
      ],
    };
    const attemptB = attemptFor(obligation, 'session-B');
    const result = bind(obligation, attemptB, 'session-B', [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('HAPPY: fork base/head are separated by repository identity', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      observations: [
        makeObservation(obligation, baseAttempt, { revision: 'head', repositoryIdentity: FORK }),
        makeObservation(obligation, baseAttempt, {
          revision: 'base',
          repositoryIdentity: UPSTREAM,
          resolvedObjectSha: BASE_SHA,
          observationId: '22222222-2222-4222-8222-222222222222',
        }),
      ],
    };
    expect(
      bind(obligation, attempt, CHILD_SESSION_ID, [{ path: 'src/foo.ts', revision: 'head' }]),
    ).toEqual({ ok: true });
    expect(
      bind(obligation, attempt, CHILD_SESSION_ID, [{ path: 'src/foo.ts', revision: 'base' }]),
    ).toEqual({ ok: true });
  });

  it('BAD: same SHA in the WRONG repository is not authority (fork collapse)', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      observations: [
        makeObservation(obligation, baseAttempt, { revision: 'base', repositoryIdentity: FORK }),
      ],
    };
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'base' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('BAD: object kind mismatch is not a match (commit vs tree)', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      observations: [makeObservation(obligation, baseAttempt, { resolvedObjectKind: 'tree' })],
    };
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('HAPPY: binary observation binds without line citations', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const binary = {
      ...makeObservation(obligation, baseAttempt),
      representation: 'binary' as const,
      lineCount: undefined,
    };
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      observations: [binary] as RepositoryObservation[],
    };
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('BAD: binary + line citation fails closed', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const binary = {
      ...makeObservation(obligation, baseAttempt),
      representation: 'binary' as const,
      lineCount: undefined,
    };
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      observations: [binary] as RepositoryObservation[],
    };
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head', line: 4 },
    ]);
    expect(result.ok).toBe(false);
  });

  it('BAD: line beyond observed content is rejected; within is accepted', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      observations: [makeObservation(obligation, baseAttempt, { lineCount: 12 })],
    };
    expect(
      bind(obligation, attempt, CHILD_SESSION_ID, [
        { path: 'src/foo.ts', revision: 'head', line: 13 },
      ]),
      'line 13 in 12-line content',
    ).toMatchObject({ ok: false });
    expect(
      bind(obligation, attempt, CHILD_SESSION_ID, [
        { path: 'src/foo.ts', revision: 'head', line: 2, endLine: 20 },
      ]),
      'endLine 20 in 12-line content',
    ).toMatchObject({ ok: false });
    expect(
      bind(obligation, attempt, CHILD_SESSION_ID, [
        { path: 'src/foo.ts', revision: 'head', line: 2, endLine: 5 },
      ]),
    ).toEqual({ ok: true });
  });

  it('BAD: parent-side capture (session mismatch) can never bind', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      observations: [
        makeObservation(obligation, baseAttempt, { observedBySessionId: 'parent-session' }),
      ],
    };
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('BAD: reviewer observes X, finding cites Y — rejected', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      observations: [makeObservation(obligation, baseAttempt, { path: 'src/foo.ts' })],
    };
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/bar.ts', revision: 'head' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('BAD: no attempt-bound observations (SDK/manual) makes any evidence unavailable', () => {
    const obligation = candidateObligation();
    const result = bind(obligation, null, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('evidence_unavailable');
  });

  it('EDGE: empty evidenceLocations never bind and never fail', () => {
    const obligation = candidateObligation();
    const result = bind(obligation, null, CHILD_SESSION_ID, []);
    expect(result).toEqual({ ok: true });
  });
});

describe('direct/submitted validator path', () => {
  function directFindings(obligationId: string, locations: unknown[]): ReviewFindings {
    return {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'changes_requested',
      blockingIssues: [
        {
          severity: 'major' as const,
          category: 'correctness' as const,
          message: 'flawed',
          relation: {
            // Implementation reviews are digest-scoped: the subject anchor
            // targets the implementation subject; repository evidenceLocations
            // bind against the attempt's authoritative observations.
            subjectAnchors: [
              { kind: 'implementation' as const, implementationDigest: 'impl-digest' },
            ],
            evidenceLocations:
              locations as ReviewFindings['blockingIssues'][number]['relation']['evidenceLocations'],
          },
        },
      ],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      challenges: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
      attestation: {
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: obligationId,
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    };
  }

  function directAssurance(
    obligation: ReviewObligation,
    attempts: readonly ReviewAttempt[],
    findings: ReviewFindings,
  ): ReviewAssuranceState {
    const invocationId = '33333333-3333-4333-8333-333333333333';
    const attemptId = attempts[attempts.length - 1]!.attemptId;
    const boundObligation = {
      ...obligation,
      status: 'fulfilled' as const,
      invocationId,
      pluginHandshakeAt: NOW_ISO,
      fulfilledAt: NOW_ISO,
    };
    const invocation: ReviewInvocationEvidence = {
      invocationId,
      obligationId: obligation.obligationId,
      obligationType: obligation.obligationType,
      attemptId,
      parentSessionId: SESSION_ID,
      childSessionId: CHILD_SESSION_ID,
      agentType: REVIEWER_SUBAGENT_TYPE,
      invocationMode: 'native_task_structured_followup',
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
      hostVisible: true,
      transcriptNavigable: true,
      source: 'host-orchestrated',
      promptHash: 'a'.repeat(64),
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      findingsHash: hashFindings(findings),
      invokedAt: NOW_ISO,
      fulfilledAt: NOW_ISO,
      consumedByObligationId: null,
      capturedRawFindings: findings,
    };
    return fixtureAssuranceWith({
      obligation: boundObligation,
      attempts,
      invocations: [invocation],
      dispatches: [completedDispatchForInvocation(invocation)],
    });
  }

  function directCtx(assurance: ReviewAssuranceState, obligation: ReviewObligation) {
    return {
      expectedPlanVersion: 1,
      expectedIteration: 0,
      assurance,
      obligationType: 'implement' as const,
      expectedObligationId: obligation.obligationId,
    };
  }

  it('BAD: rejected attempt observations are audit-only — direct findings cannot cite them', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      status: 'rejected',
      rejectionReason: 'schema_invalid',
      observations: [makeObservation(obligation, baseAttempt)],
    };
    const findings = directFindings(obligation.obligationId, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    const result = validateReviewFindings(
      findings,
      directCtx(directAssurance(obligation, [attempt], findings), obligation),
    );
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).code).toBe('REVIEW_EVIDENCE_NOT_OBSERVED');
  });

  it('HAPPY: bound attempt observations authorize direct findings', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = {
      ...baseAttempt,
      status: 'bound',
      observations: [makeObservation(obligation, baseAttempt)],
    };
    const findings = directFindings(obligation.obligationId, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);

    expect(
      validateReviewFindings(
        findings,
        directCtx(directAssurance(obligation, [attempt], findings), obligation),
      ),
    ).toBeNull();
  });

  it('EDGE: only the current bound attempt authorizes a reused child session', () => {
    const obligation = candidateObligation();
    const baseRejected = attemptFor(obligation, CHILD_SESSION_ID);
    const rejected: ReviewAttempt = {
      ...baseRejected,
      status: 'rejected',
      rejectionReason: 'schema_invalid',
      observations: [makeObservation(obligation, baseRejected, { path: 'src/old.ts' })],
    };
    const baseBound = attemptFor(obligation, CHILD_SESSION_ID);
    const bound: ReviewAttempt = {
      ...baseBound,
      ordinal: 2,
      status: 'bound',
      observations: [makeObservation(obligation, baseBound, { path: 'src/current.ts' })],
    };

    const staleFindings = directFindings(obligation.obligationId, [
      { path: 'src/old.ts', revision: 'head' },
    ]);
    expect(
      validateReviewFindings(
        staleFindings,
        directCtx(directAssurance(obligation, [rejected, bound], staleFindings), obligation),
      ),
    ).toContain('REVIEW_EVIDENCE_NOT_OBSERVED');

    const freshFindings = directFindings(obligation.obligationId, [
      { path: 'src/current.ts', revision: 'head' },
    ]);
    expect(
      validateReviewFindings(
        freshFindings,
        directCtx(directAssurance(obligation, [rejected, bound], freshFindings), obligation),
      ),
    ).toBeNull();
  });

  it('BAD: submitted evidenceLocations without observations -> REVIEW_EVIDENCE_NOT_OBSERVED', () => {
    const obligation = candidateObligation();
    const baseAttempt = attemptFor(obligation, CHILD_SESSION_ID);
    const attempt: ReviewAttempt = { ...baseAttempt, status: 'bound' };
    const findings = directFindings(obligation.obligationId, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    const result = validateReviewFindings(
      findings,
      directCtx(directAssurance(obligation, [attempt], findings), obligation),
    );
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).code).toBe('REVIEW_EVIDENCE_NOT_OBSERVED');
  });
});

void ensureReviewAssurance;
