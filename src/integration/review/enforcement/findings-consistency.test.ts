import { describe, expect, it } from 'vitest';
import {
  artifactScopeSubjectIdentityMatches,
  validateReviewFindingsConsistency,
  validateReviewFindingsScope,
} from './findings-consistency.js';
import type { ReviewObligation } from '../../../state/evidence.js';

const REPOSITORY_SCOPE = {
  kind: 'repository_change' as const,
  paths: ['src/foo.ts'],
  revisions: ['base', 'head'] as const,
};
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REPOSITORY_PROVENANCE = { kind: 'available' as const, headSha: HEAD_SHA, baseSha: BASE_SHA };
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

  describe('artifactScopeSubjectIdentityMatches', () => {
    const baseObligation = {
      obligationId: '22222222-2222-4222-8222-222222222222',
      iteration: 0,
      planVersion: 1,
      criteriaVersion: 'p41-v1',
      mandateDigest: 'mandate-digest',
      maxReviewerOutputRepairAttempts: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      pluginHandshakeAt: null,
      status: 'pending',
      invocationId: null,
      blockedCode: null,
      fulfilledAt: null,
      consumedAt: null,
      subjectDigest: 'artifact-digest',
      reviewMaterial: {
        content: '# Plan\nBody',
        materialDigest: 'md',
        subjectDigest: 'artifact-digest',
      },
    } as const;

    it('accepts a plan obligation with a bound plan artifact scope', () => {
      const obligation: ReviewObligation = {
        ...baseObligation,
        obligationType: 'plan',
        reviewSubjectScope: {
          kind: 'artifact',
          artifact: {
            kind: 'plan',
            digest: 'artifact-digest',
            sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }]],
          },
        },
      };
      expect(artifactScopeSubjectIdentityMatches(obligation)).toBe(true);
    });

    it('rejects a plan obligation whose persisted scope was replaced by repository_change', () => {
      const obligation: ReviewObligation = {
        ...baseObligation,
        obligationType: 'plan',
        reviewSubjectScope: {
          kind: 'repository_change',
          paths: ['src/foo.ts'],
          revisions: ['base', 'head'],
        },
      };
      expect(artifactScopeSubjectIdentityMatches(obligation)).toBe(false);
    });

    it('rejects an architecture obligation with a plan-kind artifact scope', () => {
      const obligation: ReviewObligation = {
        ...baseObligation,
        obligationType: 'architecture',
        reviewSubjectScope: {
          kind: 'artifact',
          artifact: {
            kind: 'plan',
            digest: 'artifact-digest',
            sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }]],
          },
        },
      };
      expect(artifactScopeSubjectIdentityMatches(obligation)).toBe(false);
    });

    it('rejects a non-artifact obligation type carrying an artifact scope', () => {
      const obligation: ReviewObligation = {
        ...baseObligation,
        obligationType: 'implement',
        reviewSubjectScope: {
          kind: 'artifact',
          artifact: {
            kind: 'plan',
            digest: 'artifact-digest',
            sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }]],
          },
        },
      };
      expect(artifactScopeSubjectIdentityMatches(obligation)).toBe(false);
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
          findings: [
            {
              relation: {
                ...repositoryRelation,
                evidenceLocations: [{ path: 'docs/evidence.md', revision: 'head', line: 2 }],
              },
            },
          ],
          reviewSubjectScope: REPOSITORY_SCOPE,
          repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
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
        repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
        details: { outOfScopeFindingIndexes: [0] },
      });
    });

    const validationPath = [{ headingDepth: 1, siblingIndex: 1, headingText: 'Validation' }];
    const unitTestsPath = [
      ...validationPath,
      { headingDepth: 2, siblingIndex: 1, headingText: 'Unit tests' },
    ];

    it('matches an artifact section only when its path is explicitly scoped', () => {
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
                    sectionPath: validationPath,
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
              sectionPaths: [validationPath],
            },
          },
          repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
        }),
      ).toEqual({ ok: true });
    });

    it('rejects an artifact descendant unless that path is explicitly scoped', () => {
      const relation = {
        subjectAnchors: [
          {
            kind: 'artifact_section' as const,
            artifactKind: 'plan' as const,
            artifactDigest: 'plan-digest',
            sectionPath: unitTestsPath,
          },
        ],
        evidenceLocations: [],
      };
      const scope = {
        kind: 'artifact' as const,
        artifact: { kind: 'plan' as const, digest: 'plan-digest', sectionPaths: [validationPath] },
      };
      expect(
        validateReviewFindingsScope({
          findings: [{ relation }],
          reviewSubjectScope: scope,
          repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
        }),
      ).toMatchObject({
        code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
      });
      expect(
        validateReviewFindingsScope({
          findings: [{ relation }],
          reviewSubjectScope: {
            ...scope,
            artifact: { ...scope.artifact, sectionPaths: [validationPath, unitTestsPath] },
          },
          repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
        }),
      ).toEqual({ ok: true });
    });

    it('fails closed for unavailable scope', () => {
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
          reviewSubjectScope: { kind: 'unavailable', reason: 'scope lookup failed' },
          repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
        }),
      ).toMatchObject({ code: 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE' });
    });

    it('identifies evidence locations that escape the repository when the subject anchor is valid', () => {
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
          repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
        }),
      ).toMatchObject({ code: 'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY' });
    });

    it.each(['/etc/passwd', 'file:///tmp/evidence.ts'])(
      'identifies generic invalid evidence location %s when the subject anchor is valid',
      (path) => {
        expect(
          validateReviewFindingsScope({
            findings: [
              {
                relation: {
                  ...repositoryRelation,
                  evidenceLocations: [{ path, revision: 'head', line: 1 }],
                },
              },
            ],
            reviewSubjectScope: REPOSITORY_SCOPE,
            repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
          }),
        ).toMatchObject({ code: 'REVIEW_EVIDENCE_LOCATION_INVALID' });
      },
    );

    it('keeps missing or malformed subject anchors anchor-required', () => {
      expect(
        validateReviewFindingsScope({
          findings: [{ relation: { ...repositoryRelation, subjectAnchors: [] } }],
          reviewSubjectScope: REPOSITORY_SCOPE,
          repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
        }),
      ).toMatchObject({ code: 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED' });
      expect(
        validateReviewFindingsScope({
          findings: [
            {
              relation: {
                ...repositoryRelation,
                subjectAnchors: [
                  { kind: 'not_an_anchor' },
                ] as unknown as typeof repositoryRelation.subjectAnchors,
              },
            },
          ],
          reviewSubjectScope: REPOSITORY_SCOPE,
          repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
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
          repositoryRevisionProvenance: REPOSITORY_PROVENANCE,
        }),
      ).toMatchObject({ code: 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE' });
    });

    it('accepts a head location with a frozen head revision', () => {
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
          reviewSubjectScope: REPOSITORY_SCOPE,
          repositoryRevisionProvenance: { kind: 'available', headSha: HEAD_SHA },
        }),
      ).toEqual({ ok: true });
    });

    it('rejects a base location without a frozen base revision', () => {
      expect(
        validateReviewFindingsScope({
          findings: [{ relation: repositoryRelation }],
          reviewSubjectScope: REPOSITORY_SCOPE,
          repositoryRevisionProvenance: { kind: 'available', headSha: HEAD_SHA },
        }),
      ).toMatchObject({ code: 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE' });
    });

    it('rejects repository locations when legacy provenance is absent', () => {
      expect(
        validateReviewFindingsScope({
          findings: [{ relation: repositoryRelation }],
          reviewSubjectScope: REPOSITORY_SCOPE,
        }),
      ).toMatchObject({ code: 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE' });
    });
  });
});
