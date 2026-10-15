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
import { renderPlanClaimDeclarations } from '../../../presentation/index.js';
import { makePlanRevision } from '../../../state/evidence-test-constants.js';
import { markdownSectionPathsEqual } from '../../../shared/markdown-sections.js';
import { validateReviewFindingsScope } from '../enforcement/findings-consistency.js';
import { buildFrozenArtifactReviewMaterial } from '../context/reviewer-context.js';
import { artifactReviewSubjectScopeFromSections } from '../context/subject-scope.js';
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
        reviewFindings: [],
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

  it('offers only subject refs inside the frozen anchor whitelist and binds the claims section', () => {
    const state = makeState('PLAN_REVIEW');
    // Mirrors the RCA shape: ten plan sections, then the appended claims
    // section as the eleventh H2 sibling.
    const planSections = Array.from(
      { length: 10 },
      (_unused, index) => `## Section ${index + 1}\n\nBody ${index + 1}.`,
    );
    const parts = buildFrozenArtifactReviewMaterial({
      obligationType: 'plan',
      state,
      artifact: ['# Implementation Plan', '', ...planSections].join('\n\n'),
      renderPlanClaimDeclarations,
    });
    const obligation = createReviewObligation({
      obligationType: 'plan',
      reviewCycle: 1,
      iteration: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: SUBJECT,
      reviewMaterial: freezeReviewMaterial(parts.content, SUBJECT),
      reviewSubjectScope: artifactReviewSubjectScopeFromSections(
        'plan',
        parts.subjectSectionPaths,
        SUBJECT,
      ),
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      changedFiles: ['src/example.ts'],
    });
    const scope = obligation.reviewSubjectScope;
    if (scope.kind !== 'artifact') throw new Error('expected artifact scope');

    const refs = buildReviewChallengeContract(state, obligation)?.evidenceRefs ?? [];
    expect(refs.length).toBeGreaterThan(0);
    type SectionPath = readonly {
      headingDepth: number;
      siblingIndex: number;
      headingText: string;
    }[];
    for (const ref of refs) {
      const sectionPath = ref.sectionPath as SectionPath;
      expect(
        scope.artifact.sectionPaths.some((allowed) =>
          markdownSectionPathsEqual(allowed, sectionPath),
        ),
        JSON.stringify(sectionPath),
      ).toBe(true);
    }

    const claimsPath = refs
      .map((ref) => ref.sectionPath as SectionPath)
      .find((path) => path.at(-1)?.headingText === 'Plan Claim Declarations Under Review');
    if (!claimsPath) throw new Error('expected a claims-section evidence ref');
    expect(claimsPath.at(-1)).toMatchObject({
      headingDepth: 2,
      siblingIndex: 11,
      headingText: 'Plan Claim Declarations Under Review',
    });

    // RCA regression: a finding anchored to the exact claims section binds
    // under the frozen digest instead of being rejected as out-of-scope.
    expect(
      validateReviewFindingsScope({
        findings: [
          {
            relation: {
              subjectAnchors: [
                {
                  kind: 'artifact_section',
                  artifactKind: 'plan',
                  artifactDigest: SUBJECT,
                  sectionPath: claimsPath,
                },
              ],
              evidenceLocations: [],
            },
          },
        ],
        reviewSubjectScope: scope,
      }),
    ).toEqual({ ok: true });

    // A foreign artifact digest is still rejected for the same section.
    expect(
      validateReviewFindingsScope({
        findings: [
          {
            relation: {
              subjectAnchors: [
                {
                  kind: 'artifact_section',
                  artifactKind: 'plan',
                  artifactDigest: 'b'.repeat(64),
                  sectionPath: claimsPath,
                },
              ],
              evidenceLocations: [],
            },
          },
        ],
        reviewSubjectScope: scope,
      }),
    ).toMatchObject({ ok: false, code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE' });

    // Context sections in the material never become subject authority.
    expect(
      validateReviewFindingsScope({
        findings: [
          {
            relation: {
              subjectAnchors: [
                {
                  kind: 'artifact_section',
                  artifactKind: 'plan',
                  artifactDigest: SUBJECT,
                  sectionPath: [
                    {
                      headingDepth: 2,
                      siblingIndex: 1,
                      headingText: 'Ticket Under Review (originating request)',
                    },
                  ],
                },
              ],
              evidenceLocations: [],
            },
          },
        ],
        reviewSubjectScope: scope,
      }),
    ).toMatchObject({ ok: false, code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE' });

    const headings = refs.flatMap((ref) =>
      (ref.sectionPath as SectionPath).map((part) => part.headingText),
    );
    expect(headings).not.toContain('Ticket Under Review (originating request)');
    expect(headings).not.toContain('Plan Artifact');
  });

  it('keeps ADR evidence refs and the frozen scope consistent', () => {
    const state = makeState('ARCHITECTURE');
    const parts = buildFrozenArtifactReviewMaterial({
      obligationType: 'architecture',
      state,
      artifact: '# ADR-1 Title\n\n## Decision\n\nBody.',
      renderPlanClaimDeclarations,
    });
    const obligation = createReviewObligation({
      obligationType: 'architecture',
      reviewCycle: 1,
      iteration: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: SUBJECT,
      reviewMaterial: freezeReviewMaterial(parts.content, SUBJECT),
      reviewSubjectScope: artifactReviewSubjectScopeFromSections(
        'adr',
        parts.subjectSectionPaths,
        SUBJECT,
      ),
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      changedFiles: ['src/example.ts'],
    });
    const scope = obligation.reviewSubjectScope;
    if (scope.kind !== 'artifact') throw new Error('expected artifact scope');

    const refs = buildReviewChallengeContract(state, obligation)?.evidenceRefs ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const sectionPath = ref.sectionPath as readonly {
        headingDepth: number;
        siblingIndex: number;
        headingText: string;
      }[];
      expect(
        scope.artifact.sectionPaths.some((allowed) =>
          markdownSectionPathsEqual(allowed, sectionPath),
        ),
        JSON.stringify(sectionPath),
      ).toBe(true);
    }
  });
});
