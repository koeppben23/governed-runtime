/**
 * @module integration/review/impl-review-prompt.test
 * @description Tests for the implementation review prompt builder: digest-bound
 *              subject anchor contract, observation-authority-derived evidence
 *              rule, and mandatory core-marker trailing content.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it } from 'vitest';
import { buildImplReviewPrompt, type ImplReviewPromptOpts } from './impl-review-prompt.js';
import { CORE_REVIEW_PROFILE_MARKER } from './prompt-sections.js';

const BASE: ImplReviewPromptOpts = {
  changedFiles: ['src/foo.ts'],
  planText: '## Plan\nFix auth',
  ticketText: '## Ticket\nTask',
  iteration: 0,
  planVersion: 1,
  obligationId: '11111111-1111-4111-8111-111111111111',
  criteriaVersion: 'p41-v1',
  mandateDigest: 'mandate-digest',
  discoveryContext: {
    health: null,
    drift: null,
    detectedStack: null,
    verificationCandidates: [],
    implementationGuidance: null,
    notVerified: [],
  },
} as const;

describe('buildImplReviewPrompt — implementation subject anchor contract', () => {
  it('renders the digest-bound anchor contract and the core marker as trailing content', () => {
    const prompt = buildImplReviewPrompt({ ...BASE, implementationDigest: 'impl-digest' });
    expect(prompt).toContain('## Implementation Subject Anchor Contract (host-enforced)');
    expect(prompt).toContain('subjectAnchors MUST use kind "implementation"');
    expect(prompt).toContain('implementationDigest MUST be "impl-digest"');
    expect(prompt).toContain('Repository paths are evidenceLocations only — never subjectAnchors.');
    expect(prompt.trimEnd().endsWith(CORE_REVIEW_PROFILE_MARKER)).toBe(true);
  });

  it('omits the anchor contract when no implementation digest is supplied', () => {
    const prompt = buildImplReviewPrompt(BASE);
    expect(prompt).not.toContain('## Implementation Subject Anchor Contract (host-enforced)');
  });

  it('derives the evidence rule from the observation capability: present ⇒ observation-only evidence', () => {
    const prompt = buildImplReviewPrompt({
      ...BASE,
      implementationDigest: 'impl-digest',
      observationCapability: 'fgc_abc',
      observationRevisions: ['base', 'head'],
    });
    expect(prompt).toContain('obtained through flowguard_observe_repository');
    expect(prompt).not.toContain('evidenceLocations MUST be []');
  });

  it('derives the evidence rule from the observation capability: absent ⇒ evidenceLocations MUST be []', () => {
    const prompt = buildImplReviewPrompt({ ...BASE, implementationDigest: 'impl-digest' });
    expect(prompt).toContain('evidenceLocations MUST be []');
    expect(prompt).toContain('Do not convert working-tree reads into repository evidence');
  });
});
