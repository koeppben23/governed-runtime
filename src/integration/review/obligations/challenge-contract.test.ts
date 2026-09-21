/**
 * @module integration/review/challenge-contract.test
 * @description Frozen-authority projection of the reviewer challenge contract.
 *
 * The challenge contract may ONLY be derived from the frozen obligation:
 * the reviewed-content subject digest, the frozen review material, and the
 * frozen artifact subject scope. Mutable session state (workspace fingerprint,
 * `state.plan.current`) is never an evidence identity.
 */

import { describe, expect, it } from 'vitest';
import { makeState } from '../../../fixtures.js';
import { makePlanRevision } from '../../../state/evidence-test-constants.js';
import { buildReviewChallengeContract } from './challenge-contract.js';
import {
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
} from './assurance.js';

const NOW = '2026-01-01T00:00:00.000Z';
const SUBJECT = 'a'.repeat(64);
const WORKSPACE_FINGERPRINT = 'workspace-fingerprint-not-content';

function contentObligation() {
  return createReviewObligation({
    obligationType: 'review',
    reviewCycle: null,
    iteration: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: SUBJECT,
    reviewMaterial: freezeReviewMaterial('reviewed content', SUBJECT),
    reviewSubjectScope: { kind: 'content', subjectDigest: SUBJECT, lineCount: 1 },
    changedFiles: ['src/example.ts'],
    metadata: { fingerprint: WORKSPACE_FINGERPRINT },
  });
}

describe('buildReviewChallengeContract frozen authority', () => {
  it('binds standalone content challenges to the frozen reviewed-content digest, never the workspace fingerprint', () => {
    const contract = buildReviewChallengeContract(makeState('PEER_REVIEW'), contentObligation());

    expect(contract?.requiredChallengeCount).toBeGreaterThan(0);
    expect(contract?.requiredChallengeKind).toBe('content_challenge');
    expect(contract?.evidenceRefs).toEqual([{ kind: 'content', digest: SUBJECT }]);
    expect(contract?.evidenceRefs).not.toContainEqual({
      kind: 'content',
      digest: WORKSPACE_FINGERPRINT,
    });
  });

  it('fails closed when the frozen content scope digest diverges from the obligation subject digest', () => {
    const obligation = contentObligation();
    const diverged = {
      ...obligation,
      reviewSubjectScope: {
        kind: 'content' as const,
        subjectDigest: 'b'.repeat(64),
        lineCount: 1,
      },
    };

    const contract = buildReviewChallengeContract(makeState('PEER_REVIEW'), diverged);

    expect(contract?.requiredChallengeCount).toBeGreaterThan(0);
    expect(contract?.evidenceRefs).toBeUndefined();
  });

  it('derives plan evidence refs from the frozen material, not mutable session state', () => {
    const frozen = '# Frozen heading\n\nFrozen body text.';
    const obligation = createReviewObligation({
      obligationType: 'plan',
      reviewCycle: 1,
      iteration: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: SUBJECT,
      reviewMaterial: freezeReviewMaterial(frozen, SUBJECT),
      reviewSubjectScope: artifactReviewSubjectScope('plan', frozen, SUBJECT),
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      changedFiles: ['src/example.ts'],
    });
    const state = makeState('PLAN_REVIEW', {
      plan: {
        current: {
          ...makePlanRevision({ body: '# Live heading\n\nLive body text.', createdAt: NOW }),
          sections: ['## Live heading'],
        },
        history: [],
        reviewCompletion: 'pending',
      },
    });

    const contract = buildReviewChallengeContract(state, obligation);
    const refs = contract?.evidenceRefs ?? [];
    expect(refs.length).toBeGreaterThan(0);

    const headingTexts = refs.flatMap((ref) =>
      ((ref.sectionPath as readonly { headingText: string }[] | undefined) ?? []).map(
        (part) => part.headingText,
      ),
    );
    expect(headingTexts).toContain('Frozen heading');
    expect(headingTexts).not.toContain('Live heading');
    expect(refs.every((ref) => ref.artifactDigest === SUBJECT)).toBe(true);
  });

  it('binds repository-backed standalone challenges to the frozen review-subject digest', () => {
    const obligation = createReviewObligation({
      obligationType: 'review',
      reviewCycle: null,
      iteration: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: SUBJECT,
      reviewSubject: {
        kind: 'repository_change',
        source: { kind: 'branch', branch: 'feat/review' },
        baseRepository: { host: 'github.com', owner: 'upstream', name: 'repo' },
        headRepository: { host: 'github.com', owner: 'upstream', name: 'repo' },
        baseSha: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
        changedPaths: ['src/example.ts'],
        materialDigest: 'd'.repeat(64),
        subjectDigest: SUBJECT,
      },
      reviewMaterial: freezeReviewMaterial('diff material', SUBJECT),
      reviewSubjectScope: {
        kind: 'repository_change',
        paths: ['src/example.ts'],
        revisions: ['base', 'head'],
      },
      changedFiles: ['src/example.ts'],
      metadata: { fingerprint: WORKSPACE_FINGERPRINT },
    });

    const contract = buildReviewChallengeContract(makeState('PEER_REVIEW'), obligation);

    expect(contract?.requiredChallengeCount).toBeGreaterThan(0);
    expect(contract?.evidenceRefs).toEqual([{ kind: 'content', digest: SUBJECT }]);
  });

  it('fails closed for an unknown scope instead of reconstructing from state', () => {
    const obligation = contentObligation();
    const unknownScope = {
      ...obligation,
      reviewSubjectScope: { kind: 'unavailable' as const, reason: 'scope_not_resolved' },
    };

    const contract = buildReviewChallengeContract(makeState('PEER_REVIEW'), unknownScope);

    expect(contract?.requiredChallengeCount).toBeGreaterThan(0);
    expect(contract?.evidenceRefs).toBeUndefined();
  });
});
