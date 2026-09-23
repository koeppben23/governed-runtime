/**
 * @module integration/review/observations/review-validation-evidence.test
 * @description Direct characterization of repository evidence authorization for
 * directly submitted findings.
 *
 * Covers every domain path of `evaluateRepositoryEvidenceBinding` (missing
 * obligation, missing child session, missing/unbound attempt, missing
 * observation, valid observation) and the adapter-boundary serialization of
 * its failure through the shared review-validation serializer.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';

import type {
  RepositoryObservation,
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewFindings,
  ReviewObligation,
} from '../../../state/evidence.js';
import {
  createReviewObligation,
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from '../obligations/assurance.js';
import { createReviewAttempt } from '../obligations/attempt-lifecycle.js';
import { validateReviewFindings } from '../validation/review-validation.js';
import { formatReviewValidationFailure } from '../validation/review-validation-failure.js';
import { evaluateRepositoryEvidenceBinding } from './review-validation-evidence.js';

const NOW_ISO = '2026-05-10T12:00:00.000Z';
const CHILD_SESSION_ID = 'ses_child_direct';
/** candidate_pair requires ONE repository identity for both revisions. */
const REPOSITORY = { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' };
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);

function candidateObligation(): ReviewObligation {
  return createReviewObligation({
    obligationType: 'implement',
    iteration: 0,
    reviewCycle: 1,
    planVersion: 1,
    now: NOW_ISO,
    subjectDigest: 'impl-digest',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'impl-digest'),
    reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
    changedFiles: ['docs/test.md'],
    repositoryAuthority: {
      kind: 'candidate_pair',
      base: { kind: 'commit', repositoryIdentity: REPOSITORY, objectSha: BASE_SHA },
      head: { kind: 'commit', repositoryIdentity: REPOSITORY, objectSha: HEAD_SHA },
    },
  });
}

function findingsWithLocations(
  obligationId: string,
  locations: readonly { path: string; revision: 'base' | 'head' }[],
): ReviewFindings {
  return {
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
          subjectAnchors: [{ kind: 'implementation', implementationDigest: 'impl-digest' }],
          evidenceLocations: locations.map((location) => ({ ...location })),
        },
      },
    ],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    reviewedBy: { sessionId: CHILD_SESSION_ID },
    reviewedAt: NOW_ISO,
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

function boundAttempt(obligation: ReviewObligation): ReviewAttempt {
  return {
    ...createReviewAttempt({
      obligationId: obligation.obligationId,
      obligationType: obligation.obligationType,
      subjectDigest: obligation.subjectDigest,
      ordinal: 1,
      childSessionId: CHILD_SESSION_ID,
      origin: { kind: 'initial' },
      repositoryDiscovery: { kind: 'not_applicable' },
      observationCapability: null,
      now: NOW_ISO,
    }),
    status: 'bound',
  };
}

function observation(
  obligation: ReviewObligation,
  attempt: ReviewAttempt,
  path = 'src/foo.ts',
): RepositoryObservation {
  return {
    observationId: '11111111-1111-4111-8111-111111111111',
    obligationId: obligation.obligationId,
    attemptId: attempt.attemptId,
    observedBySessionId: CHILD_SESSION_ID,
    path,
    revision: 'head',
    repositoryIdentity: REPOSITORY,
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
}

describe('evaluateRepositoryEvidenceBinding', () => {
  it('HAPPY: findings without repository evidence locations resolve without any authority', () => {
    const findings = findingsWithLocations('unused', []);
    expect(evaluateRepositoryEvidenceBinding(findings, null, {})).toEqual({ ok: true });
  });

  it('HAPPY: a matching observation of the bound attempt authorizes the citation', () => {
    const obligation = candidateObligation();
    const attempt = boundAttempt(obligation);
    const findings = findingsWithLocations(obligation.obligationId, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    expect(
      evaluateRepositoryEvidenceBinding(findings, obligation, {
        candidateAttempt: { ...attempt, observations: [observation(obligation, attempt)] },
      }),
    ).toEqual({ ok: true });
  });

  it('HAPPY: the ordinary assurance lookup path authorizes a bound observation', () => {
    const obligation = candidateObligation();
    const attempt = boundAttempt(obligation);
    const findings = findingsWithLocations(obligation.obligationId, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    const assurance: ReviewAssuranceState = {
      assuranceSchemaVersion: 'review-assurance.v6',
      obligations: [obligation],
      invocations: [],
      attempts: [{ ...attempt, observations: [observation(obligation, attempt)] }],
      dispatches: [],
    };
    expect(evaluateRepositoryEvidenceBinding(findings, obligation, { assurance })).toEqual({
      ok: true,
    });
  });

  it('BAD: no obligation resolves for the evidence-bearing findings', () => {
    const findings = findingsWithLocations('unused', [{ path: 'src/foo.ts', revision: 'head' }]);
    const result = evaluateRepositoryEvidenceBinding(findings, null, {
      expectedObligationId: 'expected-obligation',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('REVIEW_EVIDENCE_NOT_OBSERVED');
    expect(result.details).toEqual({
      obligationId: 'expected-obligation',
      reason: 'no review obligation resolves for these findings',
    });
  });

  it('BAD: findings without a reviewer child session identity cannot authorize evidence', () => {
    const obligation = candidateObligation();
    const findings = {
      ...findingsWithLocations(obligation.obligationId, [{ path: 'src/foo.ts', revision: 'head' }]),
      reviewedBy: { sessionId: '' },
    } as ReviewFindings;
    const result = evaluateRepositoryEvidenceBinding(findings, obligation, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details).toEqual({
      obligationId: obligation.obligationId,
      reason: 'findings carry no reviewer child session identity to authorize evidence against',
    });
  });

  it('BAD: an unbound attempt without observations fails the citation closed', () => {
    const obligation = candidateObligation();
    const findings = findingsWithLocations(obligation.obligationId, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    const result = evaluateRepositoryEvidenceBinding(findings, obligation, {
      candidateAttempt: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('REVIEW_EVIDENCE_NOT_OBSERVED');
    expect(String(result.details.findingIndexes)).toBe('0');
    expect(String(result.details.reason).length).toBeGreaterThan(0);
  });

  it('BAD: a bound attempt without a matching observation is not authority', () => {
    const obligation = candidateObligation();
    const attempt = boundAttempt(obligation);
    const findings = findingsWithLocations(obligation.obligationId, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    const result = evaluateRepositoryEvidenceBinding(findings, obligation, {
      candidateAttempt: {
        ...attempt,
        observations: [observation(obligation, attempt, 'src/other.ts')],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(String(result.details.findingIndexes)).toBe('0');
  });

  it('serializes the binding failure through the adapter boundary envelope', () => {
    const obligation = candidateObligation();
    const attempt = boundAttempt(obligation);
    const findings = findingsWithLocations(obligation.obligationId, [
      { path: 'src/foo.ts', revision: 'head' },
    ]);
    const failure = validateReviewFindings(findings, {
      expectedPlanVersion: 1,
      expectedIteration: 0,
      assurance: {
        assuranceSchemaVersion: 'review-assurance.v6',
        obligations: [obligation],
        invocations: [],
        attempts: [attempt],
        dispatches: [],
      },
      obligationType: 'implement',
      expectedObligationId: obligation.obligationId,
    });
    expect(failure).not.toBeNull();
    if (failure === null) return;
    const raw = formatReviewValidationFailure({ warn: () => {} }, failure);
    const parsed = JSON.parse(raw) as { code: string; error: boolean };
    expect(parsed.code).toBe('REVIEW_EVIDENCE_NOT_OBSERVED');
    expect(parsed.error).toBe(true);
    expect(raw).toContain('src/foo.ts');
  });
});
