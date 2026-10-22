import { describe, expect, it } from 'vitest';
import { makeState } from '../../../fixtures.js';
import type { ReviewAttempt, ReviewObligation } from '../../../state/evidence.js';
import type { ProofGraphProjection } from '../../../state/proofgraph.js';
import {
  buildReviewerEvidenceDossier,
  MAX_DOSSIER_UTF8_BYTES,
  REVIEW_DOSSIER_BUDGET_EXCEEDED,
  REVIEW_DOSSIER_INTEGRITY_FAILED,
  type ReviewerDossierProjectionInput,
} from './reviewer-evidence-dossier.js';

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT = 'subject-digest';

function claim(index: number): ProofGraphProjection['claims'][number] {
  return {
    claimId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    statement: `claim ${index}`,
    signalClass: 'fact',
    critical: index === 0,
    provenance: { kind: 'canonical_authority', authorityId: 'authority', digest: SUBJECT },
    evidenceRefs: [],
    counterexampleRefs: [],
    verificationState: 'PROVEN',
    freshness: { state: 'fresh', subjectDigest: SUBJECT } as never,
  };
}

function snapshot(candidateCount: number) {
  return {
    observedAt: '2026-01-01T00:00:00.000Z',
    discoveryDigest: 'discovery-digest',
    workspaceFingerprint: 'workspace',
    health: {
      status: 'available',
      healthy: true,
      failedCollectorNames: [],
      hasBudgetExhaustion: false,
      ageWarning: null,
      notVerified: [],
    },
    drift: {
      status: 'clean',
      drifted: false,
      currentDigest: 'current',
      persistedDigest: 'persisted',
      changedContributorNames: [],
      notVerified: [],
    },
    detectedStack: null,
    verificationCandidates: Array.from({ length: candidateCount }, (_, index) => ({
      kind: 'test',
      command: `npm test -- ${index}`,
      source: 'package.json#scripts.test',
      confidence: 'high',
      candidateId: `candidate-${index}`,
      assertionCapability: 'unsupported' as const,
    })),
    riskSurfaces: [],
    warnings: [],
    notVerified: [],
  };
}

function input(
  overrides: {
    claims?: number;
    candidates?: number;
    proofOverrides?: Partial<ProofGraphProjection>;
    attemptOverrides?: Partial<ReviewAttempt>;
  } = {},
): ReviewerDossierProjectionInput {
  const proofGraph = {
    version: 'proofgraph.v2',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    claims: Array.from({ length: overrides.claims ?? 3 }, (_, index) => claim(index)),
    ...overrides.proofOverrides,
  } as ProofGraphProjection;
  const state = makeState('PLAN_REVIEW', { proofGraph });
  const obligation = {
    obligationId: OBLIGATION_ID,
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    subjectDigest: SUBJECT,
    reviewMaterial: {
      content: 'material',
      materialDigest: 'material-digest',
      subjectDigest: SUBJECT,
    },
    requiredChallengeCount: 1,
    requiredChallengeKind: 'design_challenge',
  } as unknown as ReviewObligation;
  const attempt = {
    attemptId: ATTEMPT_ID,
    obligationId: OBLIGATION_ID,
    subjectDigest: SUBJECT,
    repositoryDiscovery: { kind: 'repository', snapshot: snapshot(overrides.candidates ?? 3) },
    ...overrides.attemptOverrides,
  } as unknown as ReviewAttempt;
  return {
    state,
    obligation,
    attempt,
    challenge: {
      requiredChallengeCount: 1,
      requiredChallengeKind: 'design_challenge',
      offeredEvidenceRefCount: 2,
      resolutionTargetCount: 0,
    },
    validationBindings: new Map(),
    claimBindings: new Map([['33333333-3333-4333-8333-000000000000', 'bound_current' as const]]),
    canonicalProofContext: ['CANONICAL-PROOF-CONTEXT'],
  };
}

describe('reviewer evidence dossier', () => {
  it('is deterministic and retains 50 claims and all candidates without truncation', () => {
    const value = input({ claims: 50, candidates: 50 });
    const first = buildReviewerEvidenceDossier(value);
    const second = buildReviewerEvidenceDossier(value);
    expect(first.kind).toBe('ok');
    expect(second).toEqual(first);
    if (first.kind !== 'ok') return;
    expect(first.text).toContain('claim 49');
    expect(first.text).toContain('candidate-49');
    expect(first.text).not.toContain('omitted for prompt length');
    expect(first.text).toContain('Ref 1 to Ref 2');
    expect(first.text).toContain('CANONICAL-PROOF-CONTEXT');
    expect(first.utf8Bytes).toBeLessThanOrEqual(MAX_DOSSIER_UTF8_BYTES);
  });

  it('distinguishes absent plan execution from a stale implementation binding', () => {
    const plan = buildReviewerEvidenceDossier(input());
    expect(plan.kind).toBe('ok');
    if (plan.kind === 'ok') {
      expect(plan.text).toContain('NOT_VERIFIED sourceKind=validation_attempts');
      expect(plan.text).toContain('proposed');
    }

    const stale = input();
    (stale as { state: ReturnType<typeof makeState> }).state = makeState('IMPL_REVIEW', {
      implementation: { digest: 'current-implementation' } as never,
      validationAttempts: [
        {
          attemptId: '44444444-4444-4444-8444-444444444444',
          scope: 'implementation',
          implementationId: '55555555-5555-4555-8555-555555555555',
          implementationDigest: 'old-implementation',
          executionObservation: {
            executionObservedStateDigest: 'a'.repeat(64),
            preCommitStateDigest: 'a'.repeat(64),
          },
          result: {
            checkId: 'test',
            passed: true,
            detail: 'ok',
            executedAt: '2026-01-01T00:00:00.000Z',
            kind: 'test',
            command: 'npm test',
            exitCode: 0,
            executionMs: 1,
            outputDigest: 'b'.repeat(64),
            timedOut: false,
            outcome: 'supported',
          },
        },
      ] as never,
    });
    (stale as unknown as { validationBindings: ReadonlyMap<string, 'stale'> }).validationBindings =
      new Map([['44444444-4444-4444-8444-444444444444', 'stale']]);
    const result = buildReviewerEvidenceDossier(stale);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.text).toContain('"binding":"stale"');
      expect(result.text).toContain('44444444-4444-4444-8444-444444444444');
    }
  });

  it('blocks contradictory obligation/attempt identity', () => {
    const result = buildReviewerEvidenceDossier(
      input({ attemptOverrides: { obligationId: 'different-obligation' } }),
    );
    expect(result).toMatchObject({
      kind: 'blocked',
      code: REVIEW_DOSSIER_INTEGRITY_FAILED,
    });
  });

  it('blocks duplicate candidate identities before dispatch', () => {
    const value = input();
    const discovery = value.attempt.repositoryDiscovery;
    if (discovery.kind !== 'repository') throw new Error('fixture');
    (discovery.snapshot as { verificationCandidates: unknown[] }).verificationCandidates[1] = {
      ...discovery.snapshot.verificationCandidates[0]!,
    };
    expect(buildReviewerEvidenceDossier(value)).toMatchObject({
      kind: 'blocked',
      code: REVIEW_DOSSIER_INTEGRITY_FAILED,
    });
  });

  it('blocks an oversized dossier instead of truncating it', () => {
    const value = input({ claims: 2 });
    const first = value.attempt.repositoryDiscovery;
    if (first.kind !== 'repository') throw new Error('fixture');
    (first.snapshot as { verificationCandidates: unknown[] }).verificationCandidates = [
      {
        ...(first.snapshot.verificationCandidates[0] as object),
        command: 'x'.repeat(MAX_DOSSIER_UTF8_BYTES),
        candidateId: 'oversized',
      },
    ];
    expect(buildReviewerEvidenceDossier(value)).toMatchObject({
      kind: 'blocked',
      code: REVIEW_DOSSIER_BUDGET_EXCEEDED,
    });
  });
});
