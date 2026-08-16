/**
 * @module integration/review/anchor-contract-lines.test
 * @description Unit tests for the host-enforced subject anchor contract lines
 *              (artifact and implementation) rendered into reviewer prompts.
 *
 * Acceptance criterion: the implementation evidence rule derives from the
 * SAME authority enforcement uses — the passed observation access record —
 * never from a scope-kind heuristic.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it } from 'vitest';
import {
  buildArtifactAnchorContractLines,
  buildImplementationAnchorContractLines,
} from './anchor-contract-lines.js';
import type { ReviewObligation } from '../../state/evidence.js';

function obligation(overrides: Partial<ReviewObligation>): ReviewObligation {
  return {
    obligationId: '00000000-0000-4000-8000-000000000000',
    obligationType: 'implement',
    iteration: 1,
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
    subjectDigest: 'impl-digest',
    reviewProfile: 'core',
    profileSource: 'policy_default',
    ...overrides,
  } as ReviewObligation;
}

describe('buildImplementationAnchorContractLines', () => {
  const implObligation = obligation({
    reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
  });

  it('renders the digest-bound anchor contract for implementation-scoped obligations', () => {
    const lines = buildImplementationAnchorContractLines(implObligation, null);
    expect(lines.join('\n')).toContain('subjectAnchors MUST use kind "implementation"');
    expect(lines.join('\n')).toContain('implementationDigest MUST be "impl-digest"');
    expect(lines.join('\n')).toContain('Repository paths are evidenceLocations only');
  });

  it('derives the evidence rule from observation access: authoritative ⇒ observation-only evidence', () => {
    const lines = buildImplementationAnchorContractLines(implObligation, {
      available: true,
      capability: 'fgc_abc',
      revisions: ['base', 'head'],
    });
    expect(lines.join('\n')).toContain('obtained through flowguard_observe_repository');
    expect(lines.join('\n')).not.toContain('evidenceLocations MUST be []');
  });

  it('derives the evidence rule from observation access: no authority ⇒ evidenceLocations MUST be []', () => {
    const lines = buildImplementationAnchorContractLines(implObligation, {
      available: false,
      revisions: [],
      reason: 'no_frozen_authority',
    });
    expect(lines.join('\n')).toContain('evidenceLocations MUST be []');
    expect(lines.join('\n')).toContain(
      'Do not convert working-tree reads into repository evidence',
    );
  });

  it('returns no lines for non-implement obligations or non-implementation scopes', () => {
    expect(
      buildImplementationAnchorContractLines(
        obligation({
          obligationType: 'plan',
          reviewSubjectScope: {
            kind: 'artifact',
            artifact: { kind: 'plan', digest: 'p', sectionPaths: [] },
          },
        }),
        null,
      ),
    ).toEqual([]);
    expect(
      buildImplementationAnchorContractLines(
        obligation({
          reviewSubjectScope: { kind: 'unavailable', reason: 'scope_not_resolved' },
        }),
        null,
      ),
    ).toEqual([]);
  });
});

describe('buildArtifactAnchorContractLines', () => {
  it('renders artifact contracts only for plan/architecture artifact scopes', () => {
    const adr = obligation({
      obligationType: 'architecture',
      reviewSubjectScope: {
        kind: 'artifact',
        artifact: {
          kind: 'adr',
          digest: 'adr-digest',
          sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Context' }]],
        },
      },
    });
    const lines = buildArtifactAnchorContractLines(adr);
    expect(lines.join('\n')).toContain('artifactDigest MUST be "adr-digest"');

    expect(buildArtifactAnchorContractLines(obligation({}))).toEqual([]);
  });
});
