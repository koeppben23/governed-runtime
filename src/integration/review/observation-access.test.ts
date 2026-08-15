/**
 * @module integration/review/observation-access.test
 * @description Unit + prompt coverage for the observation-access SSOT and the
 *              authority-bound capability minting.
 *
 * Invariant under test:
 *   attempt.observationCapability exists
 *   IFF at least one frozen revision resolves via resolveFrozenRevisionTarget
 *   for the owning obligation.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';
import type { ReviewObligation, ReviewAttempt } from '../../state/evidence.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createAttemptForExistingObligation,
  createObligationAndAttempt,
  createReviewObligation,
} from './assurance.js';
import { createReviewAttempt, mintObservationCapability } from './attempt-lifecycle.js';
import {
  resolveObservationRevisions,
  resolveRepositoryObservationAccess,
} from './observation-access.js';
import { renderRepositoryObservationContract } from './observation-contract-prompt.js';
import { renderReviewerTaskPrompt } from './prompt-builders.js';

const NOW = '2026-08-15T10:00:00.000Z';
const LOCAL_IDENTITY = { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'a'.repeat(64) };
const SHA = 'b'.repeat(40);

function contextObligation(
  overrides: Partial<Parameters<typeof createReviewObligation>[0]> = {},
): ReviewObligation {
  return createReviewObligation({
    obligationType: 'architecture',
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'adr-digest',
    reviewSubjectScope: artifactReviewSubjectScope(
      'adr',
      '## Context\nA\n## Decision\nB',
      'adr-digest',
    ),
    repositoryAuthority: {
      kind: 'context',
      context: { kind: 'commit', repositoryIdentity: LOCAL_IDENTITY, objectSha: SHA },
    },
    ...overrides,
  });
}

function candidatePairObligation(): ReviewObligation {
  return createReviewObligation({
    obligationType: 'implement',
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'impl-digest',
    changedFiles: ['src/foo.ts'],
    repositoryAuthority: {
      kind: 'candidate_pair',
      base: { kind: 'commit', repositoryIdentity: LOCAL_IDENTITY, objectSha: SHA },
      head: { kind: 'tree', repositoryIdentity: LOCAL_IDENTITY, objectSha: SHA },
    },
  });
}

function standaloneRepositoryObligation(): ReviewObligation {
  return createReviewObligation({
    obligationType: 'review',
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'review-digest',
    reviewSubject: {
      kind: 'repository_change',
      source: { kind: 'branch', branch: 'topic' },
      baseRepository: LOCAL_IDENTITY,
      baseSha: SHA,
      headSha: SHA,
      changedPaths: ['src/foo.ts'],
      materialDigest: 'sha256:' + 'c'.repeat(64),
      subjectDigest: 'review-digest',
    },
  });
}

function artifactOnlyObligation(): ReviewObligation {
  return createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'plan-digest',
    reviewSubjectScope: artifactReviewSubjectScope('plan', '## Approach\nPlan body', 'plan-digest'),
  });
}

function attemptFor(obligation: ReviewObligation, capability: string | null): ReviewAttempt {
  return createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    ordinal: 1,
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    observationCapability: capability,
    now: NOW,
  });
}

describe('resolveObservationRevisions', () => {
  it('context authority → ["head"] only', () => {
    expect(resolveObservationRevisions(contextObligation())).toEqual(['head']);
  });

  it('candidate_pair authority → ["base", "head"]', () => {
    expect(resolveObservationRevisions(candidatePairObligation())).toEqual(['base', 'head']);
  });

  it('repository_change fallback with full SHAs → ["base", "head"]', () => {
    expect(resolveObservationRevisions(standaloneRepositoryObligation())).toEqual(['base', 'head']);
  });

  it('artifact-only obligation without authority → []', () => {
    expect(resolveObservationRevisions(artifactOnlyObligation())).toEqual([]);
  });
});

describe('resolveRepositoryObservationAccess', () => {
  it('HAPPY: capability + resolvable revisions → available with exact revisions', () => {
    const obligation = contextObligation();
    const access = resolveRepositoryObservationAccess(
      obligation,
      attemptFor(obligation, mintObservationCapability()),
    );
    expect(access.available).toBe(true);
    if (access.available) {
      expect(access.revisions).toEqual(['head']);
      expect(access.capability).toMatch(/^fgc_/);
    }
  });

  it('BAD: missing capability → unavailable even with authority (attempt_capability_unavailable)', () => {
    const obligation = contextObligation();
    const access = resolveRepositoryObservationAccess(obligation, attemptFor(obligation, null));
    expect(access.available).toBe(false);
    if (!access.available) expect(access.reason).toBe('attempt_capability_unavailable');
  });

  it('BAD: forged capability without obligation authority → unavailable (defense-in-depth)', () => {
    const obligation = artifactOnlyObligation();
    const access = resolveRepositoryObservationAccess(
      obligation,
      attemptFor(obligation, mintObservationCapability()),
    );
    expect(access.available).toBe(false);
    if (!access.available) expect(access.reason).toBe('no_frozen_authority');
  });
});

describe('authority-bound capability minting', () => {
  it('appendObligationWithAttempt mints for context authority', () => {
    const obligation = contextObligation();
    const result = appendObligationWithAttempt(undefined, obligation, NOW);
    const attempt = result.assurance.attempts.find(
      (a) => a.obligationId === obligation.obligationId,
    );
    expect(attempt?.observationCapability).toMatch(/^fgc_/);
  });

  it('appendObligationWithAttempt mints nothing for artifact-only obligations', () => {
    const obligation = artifactOnlyObligation();
    const result = appendObligationWithAttempt(undefined, obligation, NOW);
    const attempt = result.assurance.attempts.find(
      (a) => a.obligationId === obligation.obligationId,
    );
    expect(attempt).toBeDefined();
    expect(attempt?.observationCapability).toBeUndefined();
  });

  it('createObligationAndAttempt mints based on the created obligation', () => {
    const withAuthority = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'architecture',
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'adr-digest',
        reviewSubjectScope: artifactReviewSubjectScope(
          'adr',
          '## Context\nA\n## Decision\nB',
          'adr-digest',
        ),
        repositoryAuthority: {
          kind: 'context',
          context: { kind: 'commit', repositoryIdentity: LOCAL_IDENTITY, objectSha: SHA },
        },
      },
      NOW,
    );
    expect(withAuthority.attempt.observationCapability).toMatch(/^fgc_/);

    const withoutAuthority = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'plan',
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'plan-digest',
        reviewSubjectScope: artifactReviewSubjectScope(
          'plan',
          '## Approach\nPlan body',
          'plan-digest',
        ),
      },
      NOW,
    );
    expect(withoutAuthority.attempt.observationCapability).toBeUndefined();
  });

  it('createAttemptForExistingObligation re-derives from the obligation', () => {
    const obligation = contextObligation();
    const reissue = createAttemptForExistingObligation(undefined, obligation, undefined, NOW, {
      origin: {
        kind: 'output_repair',
        predecessorAttemptId: '00000000-0000-4000-8000-0000000000ff',
        triggerReason: 'schema_invalid',
      },
      repositoryDiscovery: { kind: 'not_applicable' },
    });
    expect(reissue.attempt.observationCapability).toMatch(/^fgc_/);

    const artifactOnly = artifactOnlyObligation();
    const noCapability = createAttemptForExistingObligation(
      undefined,
      artifactOnly,
      undefined,
      NOW,
      {
        origin: {
          kind: 'output_repair',
          predecessorAttemptId: '00000000-0000-4000-8000-0000000000fe',
          triggerReason: 'schema_invalid',
        },
        repositoryDiscovery: { kind: 'not_applicable' },
      },
    );
    expect(noCapability.attempt.observationCapability).toBeUndefined();
  });
});

describe('renderRepositoryObservationContract', () => {
  it('HAPPY: context authority → capability + single revision "head"', () => {
    const lines = renderRepositoryObservationContract('fgc_cap', ['head']);
    const text = lines.join('\n');
    expect(text).toContain('flowguard_observe_repository');
    expect(text).toContain('revision: "head"');
    expect(text).not.toContain('<base|head>');
  });

  it('HAPPY: candidate_pair → revision <base|head>', () => {
    const text = renderRepositoryObservationContract('fgc_cap', ['base', 'head']).join('\n');
    expect(text).toContain('revision: <base|head>');
  });

  it('BAD: capability without revisions → NO authority branch', () => {
    const text = renderRepositoryObservationContract('fgc_cap', []).join('\n');
    expect(text).toContain('NO frozen repository observation authority');
    expect(text).not.toContain('flowguard_observe_repository');
  });

  it('BAD: revisions without capability → NO authority branch', () => {
    const text = renderRepositoryObservationContract(undefined, ['head']).join('\n');
    expect(text).toContain('NO frozen repository observation authority');
  });
});

describe('canonical reviewer Task prompt', () => {
  function canonicalPrompt(
    capability: string | undefined,
    revisions: readonly ('base' | 'head')[],
  ): string {
    return renderReviewerTaskPrompt({
      iteration: 0,
      planVersion: 1,
      obligationId: '00000000-0000-4000-8000-000000000001',
      mandateDigest: 'mandate-digest',
      criteriaVersion: 'criteria-v1',
      subjectLabel: 'the artifact under review',
      observationCapability: capability,
      observationRevisions: revisions,
    });
  }

  it('HAPPY: context authority advertises only revision "head"', () => {
    const prompt = canonicalPrompt('fgc_cap', ['head']);
    expect(prompt).toContain('flowguard_observe_repository');
    expect(prompt).toContain('revision: "head"');
    expect(prompt).not.toContain('<base|head>');
  });

  it('BAD: forged capability with no obligation authority → explicit unavailable, no executable observation contract', () => {
    const prompt = canonicalPrompt('fgc_forged_capability', []);
    expect(prompt).toContain('NO frozen repository observation authority');
    expect(prompt).not.toContain('flowguard_observe_repository({');
  });
});
