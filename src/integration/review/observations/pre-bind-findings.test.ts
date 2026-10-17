/**
 * @module integration/review/pre-bind-findings.test
 * @description Candidate findings are admissible for binding ONLY when every
 * frozen finding invariant holds against the exact created attempt.
 *
 * This does not grant `created` attempts general evidence authority: the
 * validator runs inside the serialized evidence mutation on the binding tuple
 * (obligation, attempt, child session, candidate findings) and never persists
 * evidence on its own.
 */

import { describe, expect, it } from 'vitest';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
} from '../obligations/assurance.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { validatePreBindFindings } from './pre-bind-findings.js';
import type { ReviewAttempt, ReviewObligation } from '../../../state/evidence.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CHILD = 'child-session-pre-bind';
const SUBJECT = 'a'.repeat(64);
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);
const REPOSITORY_IDENTITY = { host: 'github.com', owner: 'upstream', name: 'repo' };

function planFixture(
  repositoryEvidenceFreeze: ReviewObligation['repositoryEvidenceFreeze'] = {
    kind: 'unavailable',
    reason: 'repository_unavailable',
  },
): { obligation: ReviewObligation; attempt: ReviewAttempt } {
  const frozen = '# Plan\n\nBody text.';
  const obligation = createReviewObligation({
    obligationType: 'plan',
    reviewCycle: 1,
    iteration: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: SUBJECT,
    reviewMaterial: freezeReviewMaterial(frozen, SUBJECT),
    reviewSubjectScope: artifactReviewSubjectScope('plan', frozen, SUBJECT),
    changedFiles: ['docs/test.md'],
    ...(repositoryEvidenceFreeze.kind === 'available'
      ? {
          repositoryAuthority: {
            kind: 'candidate_pair' as const,
            base: {
              kind: 'commit' as const,
              repositoryIdentity: REPOSITORY_IDENTITY,
              objectSha: BASE_SHA,
            },
            head: {
              kind: 'commit' as const,
              repositoryIdentity: REPOSITORY_IDENTITY,
              objectSha: HEAD_SHA,
            },
          },
        }
      : {}),
    repositoryEvidenceFreeze,
  });
  const minted = appendObligationWithAttempt(ensureReviewAssurance(undefined), obligation, NOW);
  const attempt = minted.assurance.attempts.find((item) => item.attemptId === minted.attemptId);
  if (!attempt) throw new Error('FAIL_CLOSED: fixture attempt missing');
  return { obligation, attempt };
}

function artifactRelation(artifactDigest: string, evidenceLocations: unknown[] = []) {
  return {
    subjectAnchors: [
      {
        kind: 'artifact_section',
        artifactKind: 'plan',
        artifactDigest,
        sectionPath: [{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }],
      },
    ],
    evidenceLocations,
  };
}

function repositoryChangeFixture(): { obligation: ReviewObligation; attempt: ReviewAttempt } {
  const changedFiles = [
    'src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java',
    'src/main/java/com/example/taskmanager/model/Task.java',
  ];
  const obligation = createReviewObligation({
    obligationType: 'review',
    reviewCycle: 1,
    iteration: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: SUBJECT,
    reviewMaterial: freezeReviewMaterial('frozen review material', SUBJECT),
    reviewSubjectScope: {
      kind: 'repository_change',
      paths: changedFiles,
      revisions: ['base', 'head'],
    },
    changedFiles,
    repositoryAuthority: {
      kind: 'candidate_pair' as const,
      base: {
        kind: 'commit' as const,
        repositoryIdentity: REPOSITORY_IDENTITY,
        objectSha: BASE_SHA,
      },
      head: {
        kind: 'commit' as const,
        repositoryIdentity: REPOSITORY_IDENTITY,
        objectSha: HEAD_SHA,
      },
    },
  });
  const minted = appendObligationWithAttempt(ensureReviewAssurance(undefined), obligation, NOW);
  const attempt = minted.assurance.attempts.find((item) => item.attemptId === minted.attemptId);
  if (!attempt) throw new Error('FAIL_CLOSED: fixture attempt missing');
  return { obligation, attempt };
}

function repositoryRelation(subjectPath: string, evidencePath: string) {
  return {
    subjectAnchors: [
      { kind: 'repository_location', location: { path: subjectPath, revision: 'head' } },
    ],
    evidenceLocations: [{ path: evidencePath, revision: 'head' }],
  };
}

describe('validatePreBindFindings', () => {
  it('admits findings with no relations against the frozen attempt', () => {
    const { obligation, attempt } = planFixture();

    const result = validatePreBindFindings({
      findings: { blockingIssues: [], majorRisks: [] },
      obligation,
      attempt,
      childSessionId: CHILD,
    });

    expect(result).toEqual({ ok: true });
  });

  it('reports the frozen allowed subject paths for a missing-change finding anchored outside the changed files', () => {
    const { obligation, attempt } = repositoryChangeFixture();
    const changed = 'src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java';
    const unchanged = 'src/main/java/com/example/taskmanager/service/TaskService.java';

    const result = validatePreBindFindings({
      findings: {
        blockingIssues: [
          {
            severity: 'critical',
            message: 'The introduced dueDate is not processed by TaskService.',
            relation: repositoryRelation(unchanged, unchanged),
          },
        ],
        majorRisks: [],
      },
      obligation,
      attempt,
      childSessionId: CHILD,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
      details: {
        findingIndex: '0',
        allowedSubjectPaths: [changed, 'src/main/java/com/example/taskmanager/model/Task.java'],
      },
    });
  });

  it('admits a missing-change finding anchored at the changed location that introduces it', () => {
    const { obligation, attempt } = repositoryChangeFixture();
    const changed = 'src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java';

    const result = validatePreBindFindings({
      findings: {
        blockingIssues: [
          {
            severity: 'critical',
            message: 'The introduced dueDate is not processed by TaskService.',
            // Evidence-bearing unchanged files are checked by the observation
            // authority; the scope layer only requires the subject anchor to
            // sit in the reviewed change.
            relation: { ...repositoryRelation(changed, changed), evidenceLocations: [] },
          },
        ],
        majorRisks: [],
      },
      obligation,
      attempt,
      childSessionId: CHILD,
    });

    expect(result).toEqual({ ok: true });
  });

  it('rejects an out-of-scope finding before any binding can occur', () => {
    const { obligation, attempt } = planFixture();

    const result = validatePreBindFindings({
      findings: {
        blockingIssues: [
          {
            severity: 'critical',
            message: 'Out-of-scope finding.',
            relation: artifactRelation('other-artifact-digest'),
          },
        ],
        majorRisks: [],
      },
      obligation,
      attempt,
      childSessionId: CHILD,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
    });
  });

  it('rejects repository evidence without an authoritative observation', () => {
    const { obligation, attempt } = planFixture({ kind: 'available' });

    const result = validatePreBindFindings({
      findings: {
        blockingIssues: [
          {
            severity: 'critical',
            message: 'Unobserved citation.',
            relation: artifactRelation(SUBJECT, [{ path: 'src/foo.ts', revision: 'head' }]),
          },
        ],
        majorRisks: [],
      },
      obligation,
      attempt,
      childSessionId: CHILD,
    });

    expect(result).toMatchObject({ ok: false, code: 'REVIEW_EVIDENCE_NOT_OBSERVED' });
  });
});
