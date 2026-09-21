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
import { ReviewAssuranceState } from '../../../state/evidence.js';
import type { ReviewObligation, ReviewAttempt } from '../../../state/evidence.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createAttemptForExistingObligation,
  createObligationAndAttempt,
  createReviewObligation,
  freezeReviewMaterial,
} from '../obligations/assurance.js';
import {
  createReviewAttempt,
  mintObservationCapability,
} from '../obligations/attempt-lifecycle.js';
import {
  resolveObservationRevisions,
  resolveRepositoryObservationAccess,
} from './observation-access.js';
import { renderRepositoryObservationContract } from '../prompting/observation-contract-prompt.js';
import { renderReviewerTaskPrompt } from '../prompting/prompt-builders.js';
import { repositoryDiscoveryContext } from '../../test-helpers.js';

const NOW = '2026-08-15T10:00:00.000Z';
const LOCAL_IDENTITY = { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'a'.repeat(64) };
const SHA = 'b'.repeat(40);

function contextObligation(
  overrides: Partial<Parameters<typeof createReviewObligation>[0]> = {},
): ReviewObligation {
  return createReviewObligation({
    obligationType: 'architecture',
    reviewCycle: 1,
    repositoryEvidenceFreeze: { kind: 'available' },
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'adr-digest',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'adr-digest'),
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
    reviewCycle: 1,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'impl-digest',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'impl-digest'),
    changedFiles: ['src/foo.ts'],
    reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
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
    reviewCycle: null,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'review-digest',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'review-digest'),
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
    reviewCycle: 1,
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'plan-digest',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'plan-digest'),
    reviewSubjectScope: artifactReviewSubjectScope('plan', '## Approach\nPlan body', 'plan-digest'),
  });
}

function attemptFor(
  obligation: ReviewObligation,
  capability: string | null,
  repositoryDiscovery: ReviewAttempt['repositoryDiscovery'] = { kind: 'not_applicable' },
): ReviewAttempt {
  return createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    ordinal: 1,
    origin: { kind: 'initial' },
    repositoryDiscovery,
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

  it('repository_change without explicit observation authority → []', () => {
    expect(resolveObservationRevisions(standaloneRepositoryObligation())).toEqual([]);
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

  it('BAD: repository-governed attempt without a capability is invalid state and fails closed', () => {
    const obligation = contextObligation();
    const attempt = attemptFor(obligation, null, repositoryDiscoveryContext(NOW));
    const parsed = ReviewAssuranceState.safeParse({
      assuranceSchemaVersion: 'review-assurance.v6',
      obligations: [obligation],
      invocations: [],
      attempts: [attempt],
      dispatches: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        `repository-governed attempt ${attempt.attemptId} requires an observation capability`,
      );
    }
    const access = resolveRepositoryObservationAccess(obligation, attempt);
    expect(access.available).toBe(false);
    if (!access.available) expect(access.reason).toBe('no_frozen_authority');
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
        reviewCycle: 1,
        repositoryEvidenceFreeze: { kind: 'available' },
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'adr-digest',
        reviewMaterial: freezeReviewMaterial('frozen review material', 'adr-digest'),
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
        reviewCycle: 1,
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'plan-digest',
        reviewMaterial: freezeReviewMaterial('frozen review material', 'plan-digest'),
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
        kind: 'dispatch_rearm',
        predecessorAttemptId: '00000000-0000-4000-8000-0000000000ff',
        triggerReason: 'interrupted',
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
          kind: 'dispatch_rearm',
          predecessorAttemptId: '00000000-0000-4000-8000-0000000000fe',
          triggerReason: 'spent',
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
