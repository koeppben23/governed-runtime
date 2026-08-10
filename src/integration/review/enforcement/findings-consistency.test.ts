import { describe, expect, it } from 'vitest';
import {
  validateReviewFindingsConsistency,
  validateReviewFindingsScope,
} from './findings-consistency.js';

const REPOSITORY_SCOPE = {
  kind: 'repository_change' as const,
  paths: ['src/foo.ts'],
  revisions: ['base', 'head'] as const,
};
const repositoryRelation = {
  subjectAnchors: [
    {
      kind: 'repository_location' as const,
      location: { path: 'src/foo.ts', revision: 'head' as const, line: 10 },
    },
  ],
  evidenceLocations: [{ path: 'docs/evidence.md', revision: 'base' as const, line: 2 }],
};

describe('review/enforcement/findings-consistency', () => {
  it('rejects accept with blocking findings', () => {
    expect(
      validateReviewFindingsConsistency({ overallVerdict: 'accept', blockingIssueCount: 1 }),
    ).toEqual({
      ok: false,
      code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
      details: { overallVerdict: 'accept', blockingIssueCount: 1 },
    });
  });

  it('accepts a coherent verdict', () => {
    expect(
      validateReviewFindingsConsistency({ overallVerdict: 'accept', blockingIssueCount: 0 }),
    ).toEqual({ ok: true });
  });

  describe('structured subject scope', () => {
    it('accepts a subject anchor in the repository-change paths and external evidence', () => {
      expect(
        validateReviewFindingsScope({
          findings: [{ relation: repositoryRelation }],
          reviewSubjectScope: REPOSITORY_SCOPE,
        }),
      ).toEqual({ ok: true });
    });

    it('rejects a finding without a subject anchor in the repository-change paths', () => {
      const result = validateReviewFindingsScope({
        findings: [
          {
            relation: {
              ...repositoryRelation,
              subjectAnchors: [
                {
                  kind: 'repository_location' as const,
                  location: { path: 'src/other.ts', revision: 'head' as const, line: 10 },
                },
              ],
            },
          },
        ],
        reviewSubjectScope: REPOSITORY_SCOPE,
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
        details: { outOfScopeFindingIndexes: [0] },
      });
    });

    it('matches an artifact section and its descendant sections', () => {
      expect(
        validateReviewFindingsScope({
          findings: [
            {
              relation: {
                subjectAnchors: [
                  {
                    kind: 'artifact_section',
                    artifactKind: 'plan',
                    artifactDigest: 'plan-digest',
                    sectionPath: [
                      { headingDepth: 1, siblingIndex: 1, headingText: 'Validation' },
                      { headingDepth: 2, siblingIndex: 1, headingText: 'Unit tests' },
                    ],
                  },
                ],
                evidenceLocations: [{ path: 'docs/plan.md', revision: 'head', line: 8 }],
              },
            },
          ],
          reviewSubjectScope: {
            kind: 'artifact',
            artifact: {
              kind: 'plan',
              digest: 'plan-digest',
              sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Validation' }]],
            },
          },
        }),
      ).toEqual({ ok: true });
    });

    it('fails closed for unavailable scope or malformed external evidence', () => {
      expect(
        validateReviewFindingsScope({
          findings: [{ relation: repositoryRelation }],
          reviewSubjectScope: { kind: 'unavailable', reason: 'scope lookup failed' },
        }),
      ).toMatchObject({ code: 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE' });
      expect(
        validateReviewFindingsScope({
          findings: [
            {
              relation: {
                ...repositoryRelation,
                evidenceLocations: [{ path: '../outside.ts', revision: 'head', line: 1 }],
              },
            },
          ],
          reviewSubjectScope: REPOSITORY_SCOPE,
        }),
      ).toMatchObject({ code: 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED' });
    });

    it('rejects repository locations at revisions unavailable to the scope', () => {
      expect(
        validateReviewFindingsScope({
          findings: [
            {
              relation: {
                ...repositoryRelation,
                evidenceLocations: [{ path: 'docs/evidence.md', revision: 'head', line: 2 }],
              },
            },
          ],
          reviewSubjectScope: { ...REPOSITORY_SCOPE, revisions: ['base'] },
        }),
      ).toMatchObject({ code: 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE' });
    });
  });
});
