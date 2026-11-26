/**
 * Frozen implementation review material is the single canonical carrier of
 * host-executed verification evidence for the native reviewer transport: the
 * attempt identity and its execution-continuity observation must reach the
 * reviewer through this persisted material, not through a mutable re-read.
 */

import { describe, expect, it } from 'vitest';

import { IMPL_EVIDENCE, VALIDATION_PASSED, makeState } from '../../../fixtures.js';
import { renderPlanClaimDeclarations } from '../../../presentation/index.js';
import {
  indexMarkdownSections,
  markdownSectionPathsEqual,
} from '../../../shared/markdown-sections.js';
import { artifactReviewSubjectScopeFromSections } from './subject-scope.js';
import {
  buildFrozenArtifactReviewMaterial,
  buildFrozenReviewMaterialContent,
} from './reviewer-context.js';

const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const OBSERVED_DIGEST = 'b'.repeat(64);
const PRE_COMMIT_DIGEST = 'c'.repeat(64);

function implementationState(executionObservation: {
  executionObservedStateDigest: string;
  preCommitStateDigest: string;
}) {
  return makeState('IMPL_REVIEW', {
    implementation: IMPL_EVIDENCE,
    validationAttempts: [
      {
        attemptId: ATTEMPT_ID,
        scope: 'implementation',
        implementationId: '00000000-0000-4000-8000-0000000000aa',
        implementationDigest: IMPL_EVIDENCE.digest,
        executionObservation,
        result: VALIDATION_PASSED[0]!,
      },
    ] as never,
  });
}

describe('buildFrozenReviewMaterialContent', () => {
  it('binds the executed attempt and its observed state digests into reviewer material', () => {
    const content = buildFrozenReviewMaterialContent({
      obligationType: 'implement',
      renderPlanClaimDeclarations,
      state: implementationState({
        executionObservedStateDigest: OBSERVED_DIGEST,
        preCommitStateDigest: PRE_COMMIT_DIGEST,
      }),
      artifact: 'the diff',
    });

    expect(content).toContain('Verification Evidence (host-executed)');
    expect(content).toContain(ATTEMPT_ID);
    expect(content).toContain(VALIDATION_PASSED[0]!.executedAt);
    expect(content).toContain(OBSERVED_DIGEST);
    expect(content).toContain(PRE_COMMIT_DIGEST);
    expect(content).toContain('"stateChangedDuringExecution":true');
  });

  it('derives an unchanged continuity projection from equal digests', () => {
    const content = buildFrozenReviewMaterialContent({
      obligationType: 'implement',
      renderPlanClaimDeclarations,
      state: implementationState({
        executionObservedStateDigest: OBSERVED_DIGEST,
        preCommitStateDigest: OBSERVED_DIGEST,
      }),
      artifact: 'the diff',
    });

    expect(content).toContain('"stateChangedDuringExecution":false');
  });

  it('carries no verification evidence for plan material', () => {
    const content = buildFrozenReviewMaterialContent({
      obligationType: 'plan',
      renderPlanClaimDeclarations,
      state: makeState('PLAN_REVIEW'),
      artifact: '# Plan\n\nBody.',
    });

    expect(content).not.toContain('Verification Evidence (host-executed)');
  });

  it('freezes plan claims with role labels and without a per-claim role rule', () => {
    const content = buildFrozenReviewMaterialContent({
      obligationType: 'plan',
      renderPlanClaimDeclarations,
      state: makeState('PLAN_REVIEW'),
      artifact: '# Plan\n\nBody.',
      planClaimDeclarations: {
        flow: 'plan',
        version: 'v2',
        claims: [
          {
            claimId: '11111111-1111-4111-8111-111111111111',
            statement: 'The store rejects writes without ownership.',
            critical: true,
            authoritySectionId: 'Invariant',
            claimScope: 'specific_behavior',
            expectedCheckId: 'test',
            counterexampleRequirement: {
              kind: 'assertion',
              checkId: 'build',
              assertion: { providerId: 'junit', localId: 'fixture.ProbeTest#rejects' },
            },
          },
        ],
      } as never,
    });

    expect(content).toContain('Positive evidence check: test');
    expect(content).toContain('Counterexample (adversarial) check: build;');
    expect(content).not.toContain('Evidence roles');
  });
});

describe('buildFrozenArtifactReviewMaterial', () => {
  const PLAN_INPUT = {
    obligationType: 'plan' as const,
    state: makeState('PLAN_REVIEW'),
    artifact: '# Implementation Plan\n\n## Goal\n\nBody text.',
    renderPlanClaimDeclarations,
  };

  it('keeps the delivered content byte-identical to the canonical material builder', () => {
    const parts = buildFrozenArtifactReviewMaterial(PLAN_INPUT);

    expect(parts.content).toBe(buildFrozenReviewMaterialContent(PLAN_INPUT));
    expect(parts.content).toContain('## Ticket Under Review (originating request)');
    expect(parts.content).toContain('## Plan Artifact');
  });

  it('derives the subject section paths from the material and includes the claims section', () => {
    const parts = buildFrozenArtifactReviewMaterial(PLAN_INPUT);

    const headings = parts.subjectSectionPaths.map((path) => path.at(-1)?.headingText);
    expect(headings).toContain('Implementation Plan');
    expect(headings).toContain('Goal');
    expect(headings).toContain('Plan Claim Declarations Under Review');
    expect(headings).not.toContain('Ticket Under Review (originating request)');
    expect(headings).not.toContain('Plan Artifact');
    expect(parts.subjectSectionPaths.at(0)?.at(-1)?.headingText).toBe('Implementation Plan');
    expect(parts.subjectSectionPaths.at(-1)?.at(-1)?.headingText).toBe(
      'Plan Claim Declarations Under Review',
    );
  });

  it('fails closed for a plan artifact without ATX headings even though claims are appended', () => {
    let failure: { code?: string; message?: string } | null = null;
    try {
      buildFrozenArtifactReviewMaterial({
        obligationType: 'plan',
        state: makeState('PLAN_REVIEW'),
        artifact: 'No headings at all.',
        renderPlanClaimDeclarations,
      });
    } catch (error) {
      failure = error as { code?: string; message?: string };
    }
    expect(failure?.code).toBe('REVIEW_ARTIFACT_SUBJECT_SECTIONS_MISSING');
    expect(failure?.message).toContain('FAIL_CLOSED');
  });

  it('fails closed for an ADR artifact without ATX headings', () => {
    let failure: { code?: string; message?: string } | null = null;
    try {
      buildFrozenArtifactReviewMaterial({
        obligationType: 'architecture',
        state: makeState('ARCHITECTURE'),
        artifact: 'plain text only',
        renderPlanClaimDeclarations,
      });
    } catch (error) {
      failure = error as { code?: string; message?: string };
    }
    expect(failure?.code).toBe('REVIEW_ARTIFACT_SUBJECT_SECTIONS_MISSING');
    expect(failure?.message).toContain('FAIL_CLOSED');
  });

  it('indexes the frozen anchor whitelist from the same sections the material carries', () => {
    const parts = buildFrozenArtifactReviewMaterial(PLAN_INPUT);
    const scope = artifactReviewSubjectScopeFromSections(
      'plan',
      parts.subjectSectionPaths,
      'a'.repeat(64),
    );
    if (scope.kind !== 'artifact') throw new Error('expected artifact scope');

    const materialSections = indexMarkdownSections(parts.content);
    for (const allowed of scope.artifact.sectionPaths) {
      expect(
        materialSections.some((section) => markdownSectionPathsEqual(allowed, section.sectionPath)),
        JSON.stringify(allowed.at(-1)?.headingText),
      ).toBe(true);
    }
  });

  it('keeps subject identities material-relative for H2-rooted artifacts', () => {
    const parts = buildFrozenArtifactReviewMaterial({
      obligationType: 'plan',
      state: makeState('PLAN_REVIEW'),
      // Ticket and wrapper precede the artifact as top-level H2 sections, so
      // the artifact's own H2s carry shifted sibling indexes in the material.
      artifact: '## Plan\n\nBody text.',
      renderPlanClaimDeclarations,
    });

    const claimsPath = parts.subjectSectionPaths.find(
      (path) => path.at(-1)?.headingText === 'Plan Claim Declarations Under Review',
    );
    expect(claimsPath).toMatchObject([
      { headingDepth: 2, siblingIndex: 4, headingText: 'Plan Claim Declarations Under Review' },
    ]);
    for (const allowed of parts.subjectSectionPaths) {
      expect(
        indexMarkdownSections(parts.content).some((section) =>
          markdownSectionPathsEqual(allowed, section.sectionPath),
        ),
        JSON.stringify(allowed),
      ).toBe(true);
    }
  });

  it('binds architecture material to the ADR artifact without ticket authority', () => {
    const parts = buildFrozenArtifactReviewMaterial({
      obligationType: 'architecture',
      state: makeState('ARCHITECTURE'),
      artifact: '# ADR-1 Title\n\n## Decision\n\nBody.',
      renderPlanClaimDeclarations,
    });
    const scope = artifactReviewSubjectScopeFromSections(
      'adr',
      parts.subjectSectionPaths,
      'a'.repeat(64),
    );
    if (scope.kind !== 'artifact') throw new Error('expected artifact scope');

    expect(parts.content).toContain('## Ticket Under Review (originating request)');
    const headings = parts.subjectSectionPaths.map((path) => path.at(-1)?.headingText);
    expect(headings).not.toContain('Ticket Under Review (originating request)');
    expect(headings).not.toContain('Architecture Decision Artifact');
    for (const allowed of scope.artifact.sectionPaths) {
      expect(
        indexMarkdownSections(parts.content).some((section) =>
          markdownSectionPathsEqual(allowed, section.sectionPath),
        ),
        JSON.stringify(allowed),
      ).toBe(true);
    }
  });
});
