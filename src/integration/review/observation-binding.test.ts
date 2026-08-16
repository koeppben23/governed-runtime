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
import { assuranceWith as fixtureAssuranceWith } from '../../fixtures.js';
import {
  bindRepositoryEvidenceLocations,
  type BindingFindingRelation,
} from './observation-binding.js';
import {
  artifactReviewSubjectScope,
  createReviewAttempt,
  createReviewObligation,
  ensureReviewAssurance,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './assurance.js';
import { mintObservationCapability } from './attempt-lifecycle.js';
import { buildHostTaskEvidence } from './evidence-binding.js';
import { validateReviewFindings } from '../tools/review-validation.js';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from './enforcement/enforcement.js';
import {
  modeAResponse,
  validPrompt,
  NOW,
  LATER,
  SESSION_ID,
  CHILD_SESSION_ID,
} from '../plugin-host-task-diagnostics-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import type {
  RepositoryObservation,
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewObligation,
} from '../../state/evidence.js';
import type { ReviewFindings } from '../../state/evidence.js';

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
    obligationType,
    iteration: 0,
    planVersion: 1,
    now: NOW_ISO,
    subjectDigest: 'impl-digest',
    ...(obligationType === 'plan'
      ? {
          reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'impl-digest'),
        }
      : {
          reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
        }),
    changedFiles: ['src/foo.ts'],
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
  return { ...base, ...overrides } as RepositoryObservation;
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
    drift: { status: 'clean', drifted: false, changedCollectorNames: [], notVerified: [] },
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

const assuranceWith = (
  obligation: ReviewObligation,
  attempt: ReviewAttempt | null,
): ReviewAssuranceState => fixtureAssuranceWith({ obligation, attempts: attempt ? [attempt] : [] });

describe('pure binder — adversarial matrix', () => {
  it('HAPPY: matching frozen head observation binds', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    const observation = makeObservation(obligation, attempt);
    attempt.observations = [observation];
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
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.observations = [makeObservation(obligation, attempt, { revision: 'head' })];
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'base' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('BAD: attempt A observes, attempt B cites without observing — rejected', () => {
    const obligation = candidateObligation();
    const attemptA = attemptFor(obligation, 'session-A');
    attemptA.observations = [
      makeObservation(obligation, attemptA, { observedBySessionId: 'session-A' }),
    ];
    const attemptB = attemptFor(obligation, 'session-B');
    const result = bind(obligation, attemptB, 'session-B', [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('HAPPY: fork base/head are separated by repository identity', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.observations = [
      makeObservation(obligation, attempt, { revision: 'head', repositoryIdentity: FORK }),
      makeObservation(obligation, attempt, {
        revision: 'base',
        repositoryIdentity: UPSTREAM,
        resolvedObjectSha: BASE_SHA,
        observationId: '22222222-2222-4222-8222-222222222222',
      }),
    ];
    expect(
      bind(obligation, attempt, CHILD_SESSION_ID, [{ path: 'src/foo.ts', revision: 'head' }]),
    ).toEqual({ ok: true });
    expect(
      bind(obligation, attempt, CHILD_SESSION_ID, [{ path: 'src/foo.ts', revision: 'base' }]),
    ).toEqual({ ok: true });
  });

  it('BAD: same SHA in the WRONG repository is not authority (fork collapse)', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.observations = [
      makeObservation(obligation, attempt, { revision: 'base', repositoryIdentity: FORK }),
    ];
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'base' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('BAD: object kind mismatch is not a match (commit vs tree)', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.observations = [makeObservation(obligation, attempt, { resolvedObjectKind: 'tree' })];
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('HAPPY: binary observation binds without line citations', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    const binary = {
      ...makeObservation(obligation, attempt),
      representation: 'binary' as const,
      lineCount: undefined,
    };
    attempt.observations = [binary] as RepositoryObservation[];
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('BAD: binary + line citation fails closed', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    const binary = {
      ...makeObservation(obligation, attempt),
      representation: 'binary' as const,
      lineCount: undefined,
    };
    attempt.observations = [binary] as RepositoryObservation[];
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head', line: 4 },
    ]);
    expect(result.ok).toBe(false);
  });

  it('BAD: line beyond observed content is rejected; within is accepted', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.observations = [makeObservation(obligation, attempt, { lineCount: 12 })];
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
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.observations = [
      makeObservation(obligation, attempt, { observedBySessionId: 'parent-session' }),
    ];
    const result = bind(obligation, attempt, CHILD_SESSION_ID, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('BAD: reviewer observes X, finding cites Y — rejected', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.observations = [makeObservation(obligation, attempt, { path: 'src/foo.ts' })];
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

describe('host-task bind path', () => {
  function taskResultWithEvidence(obligationId: string, locations: unknown[]): string {
    return JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'changes_requested',
      blockingIssues: [
        {
          severity: 'major',
          category: 'correctness',
          message: 'flawed',
          relation: {
            // Plan reviews are artifact-scoped: the subject anchor targets the
            // plan artifact; repository evidenceLocations bind against the
            // attempt's authoritative observations.
            subjectAnchors: [
              {
                kind: 'artifact_section',
                artifactKind: 'plan',
                artifactDigest: 'impl-digest',
                sectionPath: [{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }],
              },
            ],
            evidenceLocations: locations,
          },
        },
      ],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      attestation: {
        toolObligationId: obligationId,
      },
    });
  }

  function hostTaskCycle(
    obligation: ReviewObligation,
    attempt: ReviewAttempt,
    locations: unknown[],
  ) {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      taskResultWithEvidence(obligation.obligationId, locations),
      LATER,
      { metadata: { sessionID: CHILD_SESSION_ID } },
    );
    return buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: [attempt],
    });
  }

  it('HAPPY: evidenceLocations bind against the attempt observations', () => {
    const obligation = candidateObligation('commit', 'plan');
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.observations = [makeObservation(obligation, attempt)];
    const result = hostTaskCycle(obligation, attempt, [{ path: 'src/foo.ts', revision: 'head' }]);
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence?.capturedVerdict).toBe('changes_requested');
  });

  it('BAD: evidenceLocations without observations -> repository_evidence_unbound (no repair)', () => {
    const obligation = candidateObligation('commit', 'plan');
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    const result = hostTaskCycle(obligation, attempt, [{ path: 'src/foo.ts', revision: 'head' }]);
    expect(result.bindOutcome).toBe('repository_evidence_unbound');
    expect(result.evidence).toBeNull();
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
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
    } as ReviewFindings;
  }

  function directCtx(assurance: ReviewAssuranceState, obligation: ReviewObligation) {
    return {
      subagentEnabled: true,
      fallbackToSelf: false,
      expectedPlanVersion: 1,
      expectedIteration: 0,
      strictEnforcement: false,
      assurance,
      obligationType: 'implement' as const,
      expectedObligationId: obligation.obligationId,
    };
  }

  it('HAPPY: submitted findings with matching attempt observations pass', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.status = 'bound';
    attempt.observations = [makeObservation(obligation, attempt)];
    const result = validateReviewFindings(
      directFindings(obligation.obligationId, [{ path: 'src/foo.ts', revision: 'head' }]),
      directCtx(assuranceWith(obligation, attempt), obligation),
    );
    expect(result).toBeNull();
  });

  it('BAD: rejected attempt observations are audit-only — direct findings cannot cite them', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.status = 'rejected';
    attempt.rejectionReason = 'schema_invalid';
    attempt.observations = [makeObservation(obligation, attempt)];
    const result = validateReviewFindings(
      directFindings(obligation.obligationId, [{ path: 'src/foo.ts', revision: 'head' }]),
      directCtx(assuranceWith(obligation, attempt), obligation),
    );
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).code).toBe('REVIEW_EVIDENCE_NOT_OBSERVED');
  });

  it('EDGE: reused child session resolves the BOUND attempt, never an older rejected one', () => {
    const obligation = candidateObligation();
    const rejected = attemptFor(obligation, CHILD_SESSION_ID);
    rejected.status = 'rejected';
    rejected.rejectionReason = 'schema_invalid';
    rejected.observations = [makeObservation(obligation, rejected, { path: 'src/foo.ts' })];
    const bound = attemptFor(obligation, CHILD_SESSION_ID);
    bound.ordinal = 2;
    bound.status = 'bound';
    bound.observations = [makeObservation(obligation, bound, { path: 'src/bar.ts' })];
    const assurance = {
      ...assuranceWith(obligation, null),
      attempts: [rejected, bound],
    };
    // Citation of the OLD rejected attempt's observation must fail...
    const staleCitation = validateReviewFindings(
      directFindings(obligation.obligationId, [{ path: 'src/foo.ts', revision: 'head' }]),
      directCtx(assurance, obligation),
    );
    expect(staleCitation).not.toBeNull();
    expect(JSON.parse(staleCitation!).code).toBe('REVIEW_EVIDENCE_NOT_OBSERVED');
    // ...while the BOUND attempt's observation authorizes.
    const freshCitation = validateReviewFindings(
      directFindings(obligation.obligationId, [{ path: 'src/bar.ts', revision: 'head' }]),
      directCtx(assurance, obligation),
    );
    expect(freshCitation).toBeNull();
  });

  it('BAD: submitted evidenceLocations without observations -> REVIEW_EVIDENCE_NOT_OBSERVED', () => {
    const obligation = candidateObligation();
    const attempt = attemptFor(obligation, CHILD_SESSION_ID);
    attempt.status = 'bound';
    const result = validateReviewFindings(
      directFindings(obligation.obligationId, [{ path: 'src/foo.ts', revision: 'head' }]),
      directCtx(assuranceWith(obligation, attempt), obligation),
    );
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).code).toBe('REVIEW_EVIDENCE_NOT_OBSERVED');
  });
});

void ensureReviewAssurance;
