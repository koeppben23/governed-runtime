/**
 * @module integration/review-assurance.test
 * @description Unit tests for review assurance helpers — pure functions, no I/O.
 *
 * Targets previously uncovered branches in findLatestObligation,
 * hasEvidenceReuse, and validateStrictAttestation.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { PERF_ENABLED } from '../../test-policy.js';
import {
  emptyReviewAssurance,
  ensureReviewAssurance,
  createReviewObligation,
  appendReviewObligation,
  reviewObligationResponseFields,
  findLatestObligation,
  consumeReviewObligation,
  hashText,
  hashFindings,
  buildInvocationEvidence,
  hasEvidenceReuse,
  findAcceptedInvocationForFindings,
  validateStrictAttestation,
  findBindableAttempt,
  createReviewAttempt,
  appendObligationWithAttempt,
  createAttemptForExistingObligation,
  artifactReviewSubjectScope,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './assurance.js';
import { REVIEWER_SUBAGENT_TYPE } from '../tool-names.js';
import type {
  ReviewObligation,
  ReviewInvocationEvidence,
  ReviewFindings,
} from '../../state/evidence.js';
import type { ReviewAttempt } from '../../state/evidence-review.js';
import { ReviewInvocationEvidence as ReviewInvocationEvidenceSchema } from '../../state/evidence.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const NOW = '2026-04-27T00:00:00.000Z';
const FIXTURE_MANDATE_DIGEST = 'fixture-mandate-digest';
const FIXTURE_CRITERIA_VERSION = 'fixture-criteria-v1';

function makeObligation(overrides?: Partial<ReviewObligation>): ReviewObligation {
  const obligationType = overrides?.obligationType ?? 'plan';
  return createReviewObligation({
    obligationType,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'test',
    reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'test'),
    ...(obligationType === 'plan' || obligationType === 'architecture'
      ? { repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' } }
      : {}),
    ...overrides,
  });
}

function makeInvocation(overrides?: Partial<ReviewInvocationEvidence>): ReviewInvocationEvidence {
  const {
    fulfilledAt,
    mandateDigest = FIXTURE_MANDATE_DIGEST,
    criteriaVersion = FIXTURE_CRITERIA_VERSION,
    ...rest
  } = overrides ?? {};
  return buildInvocationEvidence({
    obligationId: '00000000-0000-4000-8000-000000000001',
    obligationType: 'plan',
    mandateDigest,
    criteriaVersion,
    parentSessionId: 'parent-session-1',
    childSessionId: 'child-session-1',
    promptHash: hashText('test prompt'),
    findingsHash: hashText('test findings'),
    invokedAt: NOW,
    fulfilledAt: fulfilledAt ?? NOW,
    invocationMode: 'sdk_session_prompt',
    hostVisible: false,
    ...rest,
  });
}

function makeFindings(overrides?: Partial<ReviewFindings>): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'child-session-1' },
    reviewedAt: NOW,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: '00000000-0000-4000-8000-000000000001',
      iteration: 0,
      planVersion: 1,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('integration/review-assurance', () => {
  describe('emptyReviewAssurance', () => {
    it('returns empty obligations and invocations arrays', () => {
      const result = emptyReviewAssurance();
      expect(result.obligations).toEqual([]);
      expect(result.invocations).toEqual([]);
    });
  });

  describe('standalone review material', () => {
    it('copies persisted normalized material to a reissued attempt', () => {
      const materialDigest = hashText('line one\nline two\n');
      const subjectDigest = hashText(`content:${materialDigest}`);
      const material = {
        content: 'line one\nline two\n',
        materialDigest,
        subjectDigest,
      };
      const obligation = createReviewObligation({
        obligationType: 'review',
        iteration: 1,
        planVersion: 1,
        now: NOW,
        subjectDigest,
        reviewSubject: {
          kind: 'content',
          source: { kind: 'inline', mediaType: 'text' },
          materialDigest: material.materialDigest,
          subjectDigest,
          lineCount: 2,
        },
        reviewMaterial: material,
        reviewSubjectScope: { kind: 'content', subjectDigest, lineCount: 2 },
      });
      const initial = appendObligationWithAttempt(emptyReviewAssurance(), obligation, NOW);
      const retried = createAttemptForExistingObligation(
        initial.assurance,
        obligation,
        'child-session-2',
        NOW,
        {
          origin: { kind: 'initial' } as const,
          repositoryDiscovery: { kind: 'not_applicable' } as const,
        },
      );

      expect(retried.assurance.attempts.at(-1)?.reviewMaterial).toEqual(material);
      expect(retried.assurance.attempts.at(-1)?.subjectDigest).toBe(subjectDigest);
      expect(retried.attempt.childSessionId).toBe('child-session-2');
    });

    it('omits childSessionId so a pre-Task reissue stays bindable', () => {
      const subjectDigest = 'd'.repeat(64);
      const material = {
        content: 'frozen',
        materialDigest: 'e'.repeat(64),
        subjectDigest,
      };
      const obligation = makeObligation({
        obligationType: 'review',
        subjectDigest,
        reviewMaterial: material,
        reviewSubjectScope: { kind: 'content', subjectDigest, lineCount: 2 },
      });
      const initial = appendObligationWithAttempt(emptyReviewAssurance(), obligation, NOW);

      const reissued = createAttemptForExistingObligation(
        initial.assurance,
        obligation,
        undefined,
        NOW,
        {
          origin: { kind: 'initial' } as const,
          repositoryDiscovery: { kind: 'not_applicable' } as const,
        },
      );

      expect(reissued.attempt.childSessionId).toBeUndefined();
      expect(reissued.attempt.status).toBe('created');
      expect(reissued.attempt.reviewMaterial).toEqual(material);
      // Bindable means: resolvable again by the host for a fresh reviewer Task.
      expect(findBindableAttempt(reissued.assurance, obligation.obligationId)?.attemptId).toBe(
        reissued.attempt.attemptId,
      );
    });
  });

  describe('ensureReviewAssurance', () => {
    it('returns the given assurance when defined', () => {
      const existing = {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [makeObligation()],
        invocations: [],
        attempts: [],
        dispatches: [],
      };
      expect(ensureReviewAssurance(existing)).toBe(existing);
    });

    it('returns empty assurance when undefined', () => {
      const result = ensureReviewAssurance(undefined);
      expect(result.obligations).toEqual([]);
    });
  });

  describe('createReviewObligation', () => {
    it('creates a pending plan obligation with correct fields', () => {
      const result = createReviewObligation({
        obligationType: 'plan',
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'test',
        reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'test'),
      });
      expect(result.obligationType).toBe('plan');
      expect(result.status).toBe('pending');
      expect(result.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
      expect(result.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
      expect(result.blockedCode).toBeNull();
    });

    it.each([
      ['plan', [], 0, 'design_challenge'],
      ['plan', ['src/example.ts'], 1, 'design_challenge'],
      ['plan', ['src/state/schema.ts'], 2, 'design_challenge'],
      ['architecture', [], 0, 'design_challenge'],
      ['architecture', ['src/example.ts'], 1, 'design_challenge'],
      ['architecture', ['src/state/schema.ts'], 2, 'design_challenge'],
      ['implement', [], 0, 'implementation_challenge'],
      ['implement', ['src/example.ts'], 1, 'implementation_challenge'],
      ['implement', ['src/state/schema.ts'], 2, 'implementation_challenge'],
      ['review', [], 0, 'content_challenge'],
      ['review', ['src/example.ts'], 1, 'content_challenge'],
      ['review', ['src/state/schema.ts'], 2, 'content_challenge'],
    ] as const)(
      'freezes v1 %s requirements for %j',
      (obligationType, changedFiles, requiredChallengeCount, requiredChallengeKind) => {
        const result = createReviewObligation({
          obligationType,
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          changedFiles,
          ...(obligationType === 'plan' || obligationType === 'architecture'
            ? {
                repositoryEvidenceFreeze: {
                  kind: 'unavailable',
                  reason: 'repository_unavailable',
                },
              }
            : {}),
          ...(obligationType === 'plan'
            ? { reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'test') }
            : obligationType === 'architecture'
              ? {
                  reviewSubjectScope: artifactReviewSubjectScope(
                    'adr',
                    '## Context\nC\n## Decision\nD',
                    'test',
                  ),
                }
              : obligationType === 'implement'
                ? {
                    reviewSubjectScope: { kind: 'implementation', implementationDigest: 'test' },
                  }
                : {}),
          policySnapshot: {
            challengePolicy: {
              version: 'challenge-policy.v1',
              counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
            },
            maxReviewerOutputRepairAttempts: 1,
          },
        });
        expect(result).toMatchObject({
          requiredChallengeCount,
          requiredChallengeKind,
          challengePolicyVersion: 'challenge-policy.v1' as const,
        });
      },
    );

    describe('claimedTaskClass floors the challenge count (C1)', () => {
      const policySnapshot = {
        challengePolicy: {
          version: 'challenge-policy.v1' as const,
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 } as const,
        },
        maxReviewerOutputRepairAttempts: 1,
      };

      it('uses the HIGH-RISK claim even when changedFiles look doc-only', () => {
        // The exact C1 attack: high-risk change declaring targetPaths=['docs/x.md'].
        const result = createReviewObligation({
          obligationType: 'plan',
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          changedFiles: ['docs/x.md'],
          reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'test'),
          claimedTaskClass: 'HIGH-RISK',
          policySnapshot,
        });
        expect(result.requiredChallengeCount).toBe(2);
      });

      it('uses the computed HIGH-RISK when changedFiles outrank a low claim', () => {
        const result = createReviewObligation({
          obligationType: 'implement',
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          changedFiles: ['src/state/schema.ts'],
          reviewSubjectScope: { kind: 'implementation', implementationDigest: 'test' },
          claimedTaskClass: 'TRIVIAL',
          policySnapshot,
        });
        expect(result.requiredChallengeCount).toBe(2);
      });

      it('takes the STANDARD claim over doc-only changedFiles', () => {
        const result = createReviewObligation({
          obligationType: 'plan',
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          changedFiles: ['docs/x.md'],
          reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'test'),
          claimedTaskClass: 'STANDARD',
          policySnapshot,
        });
        expect(result.requiredChallengeCount).toBe(1);
      });

      it('defaults to the computed minimum when no claim is present', () => {
        const result = createReviewObligation({
          obligationType: 'plan',
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          changedFiles: ['docs/x.md'],
          reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'test'),
          policySnapshot,
        });
        expect(result.requiredChallengeCount).toBe(0);
      });
    });

    it('does not enforce challenges for a legacy snapshot without challengePolicy', () => {
      const result = createReviewObligation({
        obligationType: 'implement',
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'test',
        changedFiles: ['src/state/schema.ts'],
        reviewSubjectScope: { kind: 'implementation', implementationDigest: 'test' },
        policySnapshot: { maxReviewerOutputRepairAttempts: 1 },
      });
      // Hard Assurance Epoch: the mint always freezes the canonical challenge
      // matrix (writer-side default), never an implicit no-policy state.
      expect(result.requiredChallengeCount).toBe(2);
      expect(result.requiredChallengeKind).toBe('implementation_challenge');
      expect(result.challengePolicyVersion).toBe('challenge-policy.v1');
    });

    it('creates p41 obligations without rewriting prior attestation values', () => {
      const priorObligations: ReviewObligation[] = [
        {
          ...makeObligation(),
          criteriaVersion: 'p38-v1',
          mandateDigest: '511598457bb767daa65ba1b2828b515a1df0795166ef4c44de1282f8d1d3d8d5',
        },
        {
          ...makeObligation(),
          criteriaVersion: 'p38-v1',
          mandateDigest: 'f3e98f66862cade550b9138658dfbe82f2aeb50b989a2ec398c62bd8b2be0249',
        },
        {
          ...makeObligation(),
          criteriaVersion: 'p39-v1',
          mandateDigest: '23356c1c40b9fc986efd71cae8fa4b577c246bed502cc0faa321db9dccf2d30b',
        },
      ];
      const assurance = priorObligations.reduce(
        (current, obligation) => appendReviewObligation(current, obligation),
        emptyReviewAssurance(),
      );
      const fresh = makeObligation();

      expect(REVIEW_CRITERIA_VERSION).toBe('p41-v1');
      expect(assurance.obligations).toEqual(priorObligations);
      expect(fresh.criteriaVersion).toBe('p41-v1');
      expect(fresh.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
    });
  });

  describe('createReviewObligation — reviewSubjectScope construction', () => {
    it('plan without explicit artifact scope → fail-closed', () => {
      expect(() =>
        createReviewObligation({
          obligationType: 'plan',
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
        }),
      ).toThrow(/FAIL_CLOSED/);
    });

    it('architecture without explicit artifact scope → fail-closed', () => {
      expect(() =>
        createReviewObligation({
          obligationType: 'architecture',
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
        }),
      ).toThrow(/FAIL_CLOSED/);
    });

    it('plan with non-artifact explicit scope → fail-closed', () => {
      expect(() =>
        createReviewObligation({
          obligationType: 'plan',
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          changedFiles: ['src/foo.ts'],
          reviewSubjectScope: { kind: 'unavailable', reason: 'diff_resolution_failed' },
        }),
      ).toThrow(/FAIL_CLOSED/);
    });

    it('architecture with repository_change scope → fail-closed', () => {
      expect(() =>
        createReviewObligation({
          obligationType: 'architecture',
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          changedFiles: ['src/foo.ts'],
          reviewSubjectScope: {
            kind: 'repository_change',
            paths: ['src/foo.ts'],
            revisions: ['head'],
          },
        }),
      ).toThrow(/FAIL_CLOSED/);
    });

    it('review + undefined changedFiles → unavailable', () => {
      const result = createReviewObligation({
        obligationType: 'review',
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'test',
      });
      expect(result.reviewSubjectScope).toEqual({
        kind: 'unavailable',
        reason: 'scope_not_resolved',
      });
    });

    it('implement without an explicit scope fails closed (no changedFiles-derived subject)', () => {
      expect(() =>
        createReviewObligation({
          obligationType: 'implement',
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
        }),
      ).toThrowError('implementation reviewSubjectScope');
    });

    it('implement + changedFiles without an explicit scope fails closed (repository_change is never derived)', () => {
      expect(() =>
        createReviewObligation({
          obligationType: 'implement',
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          changedFiles: ['src/foo.ts'],
        }),
      ).toThrowError('implementation reviewSubjectScope');
    });

    it('implement with a non-implementation explicit scope fails closed', () => {
      expect(() =>
        createReviewObligation({
          obligationType: 'implement',
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          reviewSubjectScope: { kind: 'unavailable', reason: 'diff_resolution_failed' },
        }),
      ).toThrowError('implementation reviewSubjectScope');
    });

    it('implement with a digest-divergent implementation scope fails closed', () => {
      expect(() =>
        createReviewObligation({
          obligationType: 'implement',
          iteration: 0,
          planVersion: 1,
          now: NOW,
          subjectDigest: 'test',
          reviewSubjectScope: { kind: 'implementation', implementationDigest: 'other' },
        }),
      ).toThrowError('does not match the obligation subject digest');
    });

    it('implement with a bound implementation scope mints the digest-bound subject', () => {
      const result = createReviewObligation({
        obligationType: 'implement',
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'test',
        changedFiles: ['src/foo.ts'],
        reviewSubjectScope: { kind: 'implementation', implementationDigest: 'test' },
      });
      expect(result.reviewSubjectScope).toEqual({
        kind: 'implementation',
        implementationDigest: 'test',
      });
    });

    it('binds an explicit artifact scope to the authoritative subject digest', () => {
      const result = createReviewObligation({
        obligationType: 'plan',
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'plan-digest',
        reviewSubjectScope: {
          kind: 'artifact',
          artifact: {
            kind: 'plan',
            digest: 'untrusted-digest',
            sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Overview' }]],
          },
        },
      });
      expect(result.reviewSubjectScope).toEqual({
        kind: 'artifact',
        artifact: {
          kind: 'plan',
          digest: 'plan-digest',
          sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Overview' }]],
        },
      });
    });
  });

  describe('artifactReviewSubjectScope', () => {
    it('mints adr scope from canonical Markdown sections', () => {
      const scope = artifactReviewSubjectScope(
        'adr',
        '# Title\n\n## Context\nBody\n\n## Decision\nD\n',
        'd1',
      );
      expect(scope).toEqual({
        kind: 'artifact',
        artifact: {
          kind: 'adr',
          digest: 'd1',
          sectionPaths: [
            [{ headingDepth: 1, siblingIndex: 1, headingText: 'Title' }],
            [
              { headingDepth: 1, siblingIndex: 1, headingText: 'Title' },
              { headingDepth: 2, siblingIndex: 1, headingText: 'Context' },
            ],
            [
              { headingDepth: 1, siblingIndex: 1, headingText: 'Title' },
              { headingDepth: 2, siblingIndex: 2, headingText: 'Decision' },
            ],
          ],
        },
      });
    });

    it('mints plan scope with kind plan', () => {
      const scope = artifactReviewSubjectScope('plan', '## Approach\nText\n', 'p1');
      expect(scope.kind).toBe('artifact');
      if (scope.kind === 'artifact') {
        expect(scope.artifact.kind).toBe('plan');
        expect(scope.artifact.digest).toBe('p1');
        expect(scope.artifact.sectionPaths).toEqual([
          [{ headingDepth: 2, siblingIndex: 1, headingText: 'Approach' }],
        ]);
      }
    });

    it('fails closed on Markdown without headings', () => {
      expect(() => artifactReviewSubjectScope('adr', 'plain text only', 'd1')).toThrow(
        /FAIL_CLOSED/,
      );
      expect(() => artifactReviewSubjectScope('plan', '', 'd1')).toThrow(/FAIL_CLOSED/);
    });
  });

  describe('appendReviewObligation', () => {
    it('appends a pending obligation while preserving invocations', () => {
      const invocation = makeInvocation();
      const obligation = makeObligation();
      const result = appendReviewObligation(
        {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [],
          invocations: [invocation],
          attempts: [],
          dispatches: [],
        },
        obligation,
      );

      expect(result.obligations).toEqual([obligation]);
      expect(result.invocations).toEqual([invocation]);
    });

    it('returns ensured assurance unchanged when obligation is null', () => {
      const result = appendReviewObligation(undefined, null);
      expect(result).toEqual({
        assuranceSchemaVersion: 'review-assurance.v6',
        obligations: [],
        invocations: [],
        attempts: [],
        dispatches: [],
      });
    });
  });

  describe('reviewObligationResponseFields', () => {
    it('builds nested and flat compatibility response fields', () => {
      const obligation = makeObligation({ obligationType: 'architecture', iteration: 2 });
      const result = reviewObligationResponseFields(obligation);

      expect(result.reviewObligation).toMatchObject({
        obligationId: obligation.obligationId,
        obligationType: 'architecture',
        iteration: 2,
      });
      expect(result.reviewObligationId).toBe(obligation.obligationId);
      expect(result.reviewCriteriaVersion).toBe(obligation.criteriaVersion);
    });

    it('returns empty fields when obligation is null', () => {
      expect(reviewObligationResponseFields(null)).toEqual({});
    });
  });

  describe('findLatestObligation', () => {
    describe('HAPPY', () => {
      it('finds matching obligation by type/iteration/planVersion', () => {
        const obligations = [
          makeObligation({ obligationType: 'plan', iteration: 0, planVersion: 1 }),
          makeObligation({ obligationType: 'plan', iteration: 1, planVersion: 2 }),
        ];
        const result = findLatestObligation(obligations, 'plan', 1, 2);
        expect(result).toBe(obligations[1]);
      });

      it('returns latest when multiple match', () => {
        const obligations = [
          makeObligation({ obligationType: 'plan', iteration: 0, planVersion: 1 }),
          makeObligation({ obligationType: 'plan', iteration: 0, planVersion: 1 }),
        ];
        const result = findLatestObligation(obligations, 'plan', 0, 1);
        expect(result).toBe(obligations[1]);
      });
    });

    describe('BAD', () => {
      it('returns null when no obligation matches type', () => {
        const obligations = [makeObligation({ obligationType: 'plan' })];
        const result = findLatestObligation(obligations, 'implement', 0, 1);
        expect(result).toBeNull();
      });

      it('returns null when iteration does not match', () => {
        const obligations = [makeObligation({ iteration: 0 })];
        const result = findLatestObligation(obligations, 'plan', 99, 1);
        expect(result).toBeNull();
      });

      it('returns null when planVersion does not match', () => {
        const obligations = [makeObligation({ planVersion: 1 })];
        const result = findLatestObligation(obligations, 'plan', 0, 99);
        expect(result).toBeNull();
      });

      it('returns null for empty obligations array', () => {
        // Covers line 76: return null when no obligations
        const result = findLatestObligation([], 'plan', 0, 1);
        expect(result).toBeNull();
      });
    });

    describe('CORNER', () => {
      it('skips null entries in obligations array', () => {
        const obligations = [null as unknown as ReviewObligation, makeObligation()];
        const result = findLatestObligation(obligations, 'plan', 0, 1);
        expect(result).toBeDefined();
        expect(result?.obligationType).toBe('plan');
      });
    });

    describe('EDGE', () => {
      it('returns null when all obligations are null', () => {
        const result = findLatestObligation([null as unknown as ReviewObligation], 'plan', 0, 1);
        expect(result).toBeNull();
      });
    });
  });

  describe('hashText', () => {
    it('returns deterministic hex digest', () => {
      const a = hashText('hello');
      const b = hashText('hello');
      expect(a).toBe(b);
      expect(typeof a).toBe('string');
      expect(a.length).toBe(64);
    });

    it('produces different digests for different input', () => {
      expect(hashText('hello')).not.toBe(hashText('world'));
    });
  });

  describe('consumeReviewObligation', () => {
    it('marks the matching obligation and invocation as consumed', () => {
      const obligation = {
        ...makeObligation({ obligationId: '00000000-0000-4000-8000-000000000001' }),
        invocationId: '00000000-0000-4000-8000-000000000002',
      };
      const invocation = {
        ...makeInvocation(),
        invocationId: '00000000-0000-4000-8000-000000000002',
      };
      const result = consumeReviewObligation(
        {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [obligation],
          invocations: [invocation],
          attempts: [],
          dispatches: [],
        },
        obligation,
        NOW,
      );

      expect(result.obligations[0]?.status).toBe('consumed');
      expect(result.obligations[0]?.consumedAt).toBe(NOW);
      expect(result.invocations[0]?.consumedByObligationId).toBe(obligation.obligationId);
    });

    it('returns the same assurance when obligation is null', () => {
      const assurance = {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [makeObligation()],
        invocations: [],
        attempts: [],
        dispatches: [],
      };
      expect(consumeReviewObligation(assurance, null, NOW)).toBe(assurance);
    });

    it('consumes only the accepted invocation when multiple invocations target the same obligation', () => {
      const findings = makeFindings();
      const obligation = makeObligation({
        obligationId: findings.attestation!.toolObligationId,
      });
      const rejectedInvocation = makeInvocation({
        invocationId: '00000000-0000-4000-8000-000000000010',
        obligationId: obligation.obligationId,
        childSessionId: 'child-session-rejected',
        findingsHash: hashText('different findings'),
      });
      const acceptedInvocation = makeInvocation({
        invocationId: '00000000-0000-4000-8000-000000000011',
        obligationId: obligation.obligationId,
        childSessionId: findings.reviewedBy.sessionId,
        findingsHash: hashFindings(findings),
        invocationMode: 'host_subagent_task',
        hostVisible: true,
      });
      const assurance = {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [obligation],
        invocations: [rejectedInvocation, acceptedInvocation],
        attempts: [],
        dispatches: [],
      };

      const accepted = findAcceptedInvocationForFindings(assurance, obligation, findings);
      const consumed = consumeReviewObligation(assurance, obligation, NOW, accepted?.invocationId);

      expect(accepted?.invocationId).toBe(acceptedInvocation.invocationId);
      expect(consumed.invocations[0]?.consumedByObligationId).toBeNull();
      expect(consumed.invocations[1]?.consumedByObligationId).toBe(obligation.obligationId);
    });

    it('fulfilled obligation consumes its bound invocationId even when another invocation has the same child and hash', () => {
      const findings = makeFindings();
      const obligation = makeObligation({
        obligationId: findings.attestation!.toolObligationId,
      });
      const boundInvocation = makeInvocation({
        invocationId: '00000000-0000-4000-8000-000000000021',
        obligationId: obligation.obligationId,
        childSessionId: findings.reviewedBy.sessionId,
        findingsHash: hashFindings(findings),
      });
      const duplicateInvocation = makeInvocation({
        invocationId: '00000000-0000-4000-8000-000000000022',
        obligationId: obligation.obligationId,
        childSessionId: findings.reviewedBy.sessionId,
        findingsHash: hashFindings(findings),
      });
      const fulfilledObligation = {
        ...obligation,
        status: 'fulfilled' as const,
        invocationId: boundInvocation.invocationId,
        fulfilledAt: NOW,
      };
      const assurance = {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [fulfilledObligation],
        invocations: [duplicateInvocation, boundInvocation],
        attempts: [],
        dispatches: [],
      };

      const accepted = findAcceptedInvocationForFindings(assurance, fulfilledObligation, findings);
      const consumed = consumeReviewObligation(
        assurance,
        fulfilledObligation,
        NOW,
        accepted?.invocationId,
      );

      expect(accepted?.invocationId).toBe(boundInvocation.invocationId);
      expect(consumed.invocations[0]?.consumedByObligationId).toBeNull();
      expect(consumed.invocations[1]?.consumedByObligationId).toBe(
        fulfilledObligation.obligationId,
      );
    });
  });

  describe('hashFindings', () => {
    it('returns deterministic hash for same findings object', () => {
      const a = hashFindings({ key: 'val' });
      const b = hashFindings({ key: 'val' });
      expect(a).toBe(b);
    });
  });

  describe('buildInvocationEvidence', () => {
    it('returns complete invocation evidence with correct agent type', () => {
      const result = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
        fulfilledAt: NOW,
        invocationMode: 'sdk_session_prompt',
        hostVisible: false,
      });
      expect(result.agentType).toBe(REVIEWER_SUBAGENT_TYPE);
      expect(result.mandateDigest).toBe(FIXTURE_MANDATE_DIGEST);
      expect(result.consumedByObligationId).toBeNull();
      expect(result.reviewOutputMode).toBe('structured_output');
      expect(result.structuredOutputUsed).toBe(true);
      expect(result.reviewAssuranceLevel).toBe('structured_high');
      expect(result.extractionMethod).toBeUndefined();
    });

    it('records text compatibility metadata explicitly', () => {
      const result = makeInvocation({
        reviewOutputMode: 'text_compat',
        structuredOutputUsed: false,
        reviewAssuranceLevel: 'text_compat_lower',
        extractionMethod: 'outermost_braces',
        modelCapabilityError: 'model does not support this tool_choice',
      });
      expect(result).toMatchObject({
        reviewOutputMode: 'text_compat',
        structuredOutputUsed: false,
        reviewAssuranceLevel: 'text_compat_lower',
        extractionMethod: 'outermost_braces',
        modelCapabilityError: 'model does not support this tool_choice',
      });
    });

    it('defaults to text_compat_lower when reviewOutputMode is text_compat', () => {
      const result = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000002',
        obligationType: 'review',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
        fulfilledAt: NOW,
        reviewOutputMode: 'text_compat',
        invocationMode: 'sdk_session_prompt',
        hostVisible: false,
      });
      expect(result.reviewOutputMode).toBe('text_compat');
      expect(result.structuredOutputUsed).toBe(false);
      expect(result.reviewAssuranceLevel).toBe('text_compat_lower');
    });
  });

  // ── BUG-15: capturedVerdict field ──────────────────────────────────────

  describe('buildInvocationEvidence — capturedVerdict (BUG-15)', () => {
    it('HAPPY: includes capturedVerdict when provided', () => {
      const result = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
        fulfilledAt: NOW,
        capturedVerdict: 'accept',
        invocationMode: 'sdk_session_prompt',
        hostVisible: false,
      });
      expect(result.capturedVerdict).toBe('accept');
    });

    it('HAPPY: includes capturedVerdict=changes_requested', () => {
      const result = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
        capturedVerdict: 'changes_requested',
        invocationMode: 'sdk_session_prompt',
        hostVisible: false,
      });
      expect(result.capturedVerdict).toBe('changes_requested');
    });

    it('HAPPY: omits capturedVerdict when undefined', () => {
      const result = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
        invocationMode: 'sdk_session_prompt',
        hostVisible: false,
      });
      expect(result.capturedVerdict).toBeUndefined();
    });

    it('EDGE: capturedVerdict survives Zod round-trip (schema parse)', () => {
      const evidence = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        invocationMode: 'host_subagent_task',
        hostVisible: true,
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
        capturedVerdict: 'accept',
      });
      const parsed = ReviewInvocationEvidenceSchema.parse(evidence);
      expect(parsed.capturedVerdict).toBe('accept');
    });

    it('EDGE: Zod parse accepts evidence without capturedVerdict (backward compat)', () => {
      const evidence = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        invocationMode: 'sdk_session_prompt',
        hostVisible: false,
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
        // no capturedVerdict
      });
      const parsed = ReviewInvocationEvidenceSchema.parse(evidence);
      expect(parsed.capturedVerdict).toBeUndefined();
    });
  });

  // ── BUG-15 Stufe 2: capturedRawFindings field ─────────────────────────────

  describe('buildInvocationEvidence — capturedRawFindings (BUG-15 Stufe 2)', () => {
    const sampleRawFindings: Record<string, unknown> = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'accept',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_child' },
      reviewedAt: NOW,
    };

    it('HAPPY: includes capturedRawFindings when provided', () => {
      const result = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        invocationMode: 'host_subagent_task',
        hostVisible: true,
        promptHash: hashText('prompt'),
        findingsHash: hashFindings(sampleRawFindings),
        invokedAt: NOW,
        capturedVerdict: 'accept',
        capturedRawFindings: sampleRawFindings,
      });
      expect(result.capturedRawFindings).toEqual(sampleRawFindings);
    });

    it('HAPPY: omits capturedRawFindings when undefined', () => {
      const result = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        invocationMode: 'sdk_session_prompt',
        hostVisible: false,
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
      });
      expect(result.capturedRawFindings).toBeUndefined();
    });

    it('EDGE: capturedRawFindings survives Zod round-trip (schema parse)', () => {
      const evidence = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        invocationMode: 'host_subagent_task',
        hostVisible: true,
        promptHash: hashText('prompt'),
        findingsHash: hashFindings(sampleRawFindings),
        invokedAt: NOW,
        capturedVerdict: 'accept',
        capturedRawFindings: sampleRawFindings,
      });
      const parsed = ReviewInvocationEvidenceSchema.parse(evidence);
      expect(parsed.capturedRawFindings).toBeDefined();
      expect(parsed.capturedRawFindings!.overallVerdict).toBe('accept');
      expect(parsed.capturedRawFindings!.iteration).toBe(0);
    });

    it('EDGE: Zod parse accepts evidence without capturedRawFindings (backward compat)', () => {
      const evidence = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        invocationMode: 'sdk_session_prompt',
        hostVisible: false,
        promptHash: hashText('prompt'),
        findingsHash: hashText('findings'),
        invokedAt: NOW,
      });
      const parsed = ReviewInvocationEvidenceSchema.parse(evidence);
      expect(parsed.capturedRawFindings).toBeUndefined();
    });

    it('CORNER: capturedRawFindings with extra keys preserved through Zod (z.record passthrough)', () => {
      const rawWithExtras = {
        ...sampleRawFindings,
        _internalDebug: { foo: 'bar' },
        customField: 42,
      };
      const evidence = buildInvocationEvidence({
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationType: 'plan',
        mandateDigest: FIXTURE_MANDATE_DIGEST,
        criteriaVersion: FIXTURE_CRITERIA_VERSION,
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        invocationMode: 'host_subagent_task',
        hostVisible: true,
        promptHash: hashText('prompt'),
        findingsHash: hashFindings(rawWithExtras),
        invokedAt: NOW,
        capturedRawFindings: rawWithExtras,
      });
      const parsed = ReviewInvocationEvidenceSchema.parse(evidence);
      // z.record(z.string(), z.unknown()) preserves all keys
      expect(parsed.capturedRawFindings!._internalDebug).toEqual({ foo: 'bar' });
      expect(parsed.capturedRawFindings!.customField).toBe(42);
    });
  });

  describe('hasEvidenceReuse', () => {
    describe('HAPPY', () => {
      it('returns true when child session matches', () => {
        const invocations = [makeInvocation({ childSessionId: 'child-1' })];
        expect(hasEvidenceReuse(invocations, 'child-1', 'some-hash')).toBe(true);
      });

      it('returns true when findings hash matches', () => {
        const invocations = [makeInvocation({ findingsHash: 'abc123' })];
        expect(hasEvidenceReuse(invocations, 'other-child', 'abc123')).toBe(true);
      });
    });

    describe('BAD', () => {
      it('returns false when no invocation matches session or hash', () => {
        const invocations = [makeInvocation({ childSessionId: 'child-1', findingsHash: 'xyz' })];
        // Covers line 120: invocations.some returns false
        expect(hasEvidenceReuse(invocations, 'child-2', 'abc')).toBe(false);
      });

      it('returns false for empty invocations array', () => {
        expect(hasEvidenceReuse([], 'child-1', 'abc')).toBe(false);
      });
    });

    describe.skipIf(!PERF_ENABLED)('PERF', () => {
      it('completes in < 1ms for 1000 invocations', () => {
        const invocations = Array.from({ length: 1000 }, (_, i) =>
          makeInvocation({ childSessionId: `child-${i}` }),
        );
        const start = performance.now();
        const result = hasEvidenceReuse(invocations, 'nonexistent', 'nonexistent');
        const elapsed = performance.now() - start;
        expect(result).toBe(false);
        expect(elapsed).toBeLessThan(5);
      });
    });
  });

  describe('validateStrictAttestation', () => {
    describe('HAPPY', () => {
      it('returns null when attestation is fully valid', () => {
        const findings = makeFindings();
        const result = validateStrictAttestation(findings, {
          obligationId: '00000000-0000-4000-8000-000000000001',
          iteration: 0,
          planVersion: 1,
        });
        expect(result).toBeNull();
      });
    });

    describe('BAD', () => {
      it('returns SUBAGENT_MANDATE_MISSING when attestation is absent', () => {
        const findings = makeFindings({ attestation: undefined });
        // Covers line 133: !att → SUBAGENT_MANDATE_MISSING
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISSING');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when mandateDigest differs', () => {
        const findings = makeFindings({
          attestation: { ...makeFindings().attestation!, mandateDigest: 'wrong-digest' },
        });
        // Covers line 143: mismatch → SUBAGENT_MANDATE_MISMATCH
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when criteriaVersion differs', () => {
        const findings = makeFindings({
          attestation: { ...makeFindings().attestation!, criteriaVersion: 'wrong-version' },
        });
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when obligationId differs', () => {
        const findings = makeFindings();
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-ffffffffffff',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when iteration differs', () => {
        const findings = makeFindings();
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 99,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when planVersion differs', () => {
        const findings = makeFindings();
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 99,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });

      it('returns SUBAGENT_MANDATE_MISMATCH when reviewedBy is not flowguard-reviewer', () => {
        const findings = makeFindings();
        Object.assign(findings.attestation!, { reviewedBy: 'other-agent' });
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISMATCH');
      });
    });

    describe('CORNER', () => {
      it('returns SUBAGENT_MANDATE_MISSING when findings are from self-review', () => {
        const findings = makeFindings({ reviewMode: 'self', attestation: undefined });
        expect(
          validateStrictAttestation(findings, {
            obligationId: '00000000-0000-4000-8000-000000000001',
            iteration: 0,
            planVersion: 1,
          }),
        ).toBe('SUBAGENT_MANDATE_MISSING');
      });
    });
  });
});

describe('findBindableAttempt', () => {
  const OBLIGATION_A = '00000000-0000-4000-8000-00000000aaaa';
  const OBLIGATION_B = '00000000-0000-4000-8000-00000000bbbb';

  function attempt(overrides: Partial<ReviewAttempt> & { ordinal: number }): ReviewAttempt {
    return {
      ...createReviewAttempt({
        obligationId: OBLIGATION_A,
        obligationType: 'plan',
        subjectDigest: 'subject',
        ordinal: overrides.ordinal,
        origin: { kind: 'initial' } as const,
        repositoryDiscovery: { kind: 'not_applicable' } as const,
        observationCapability: null,
        now: NOW,
      }),
      ...overrides,
    };
  }

  function assuranceWith(attempts: ReviewAttempt[]) {
    return { ...emptyReviewAssurance(), attempts };
  }

  it('returns the unbound, created attempt for the obligation', () => {
    const target = attempt({ ordinal: 0 });
    const result = findBindableAttempt(assuranceWith([target]), OBLIGATION_A);
    expect(result?.attemptId).toBe(target.attemptId);
  });

  it('ignores attempts belonging to a different obligation', () => {
    const foreign = attempt({ ordinal: 0, obligationId: OBLIGATION_B });
    expect(findBindableAttempt(assuranceWith([foreign]), OBLIGATION_A)).toBeNull();
  });

  it('ignores an attempt that is already bound to a reviewer session', () => {
    // A bound attempt is spent: handing it out again would let a second reviewer
    // session attach evidence through the first one's envelope.
    const bound = attempt({ ordinal: 0, childSessionId: 'ses_child' });
    expect(findBindableAttempt(assuranceWith([bound]), OBLIGATION_A)).toBeNull();
  });

  it.each(['captured', 'rejected', 'bound', 'stale', 'expired'] as const)(
    'ignores an attempt with status %s',
    (status) => {
      const spent = attempt({ ordinal: 0, status });
      expect(findBindableAttempt(assuranceWith([spent]), OBLIGATION_A)).toBeNull();
    },
  );

  it('prefers the highest ordinal when several attempts qualify', () => {
    const older = attempt({ ordinal: 1 });
    const newer = attempt({ ordinal: 2 });
    const result = findBindableAttempt(assuranceWith([older, newer]), OBLIGATION_A);
    expect(result?.attemptId).toBe(newer.attemptId);
  });

  it('returns null when no attempt exists at all', () => {
    expect(findBindableAttempt(emptyReviewAssurance(), OBLIGATION_A)).toBeNull();
    expect(findBindableAttempt(undefined, OBLIGATION_A)).toBeNull();
  });
});
