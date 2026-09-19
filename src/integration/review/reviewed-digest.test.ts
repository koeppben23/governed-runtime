/**
 * @module integration/review/reviewed-digest.test
 * @description Historical provenance resolution: which obligation and
 *              invocation produced exactly these findings.
 *
 * Invariant under test (no recency selection, no current-state fallback):
 *   subagent findings resolve IFF exact producer obligation (attestation or
 *   unique exact findings↔invocation match) + type/iteration/planVersion
 *   coherence + invocation consumed by nobody or by exactly that obligation.
 *   Self-mode findings resolve ONLY via their attestation.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, expect, it } from 'vitest';
import type {
  ReviewFindings,
  ReviewInvocationEvidence,
  ReviewObligation,
} from '../../state/evidence.js';
import {
  artifactReviewSubjectScope,
  buildInvocationEvidence,
  createReviewObligation,
  freezeReviewMaterial,
  fulfillObligation,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './assurance.js';
import { runWithAdapterLogger, type AdapterLogger } from '../../logging/adapter-logger.js';
import { hashFindings } from './findings-hash.js';
import { completedDispatchForInvocation } from '../../state/evidence-test-constants.js';
import { resolveReviewedArtifactIdentity, reviewedIdentityFields } from './reviewed-digest.js';

const NOW = '2026-08-15T10:00:00.000Z';

function planObligation(): ReviewObligation {
  return createReviewObligation({
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerAttempts: 1,
    },
    obligationType: 'plan',
    reviewCycle: 1,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'plan-digest-v1',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'plan-digest-v1'),
    reviewSubjectScope: artifactReviewSubjectScope('plan', '## Approach\nBody', 'plan-digest-v1'),
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
  });
}

function subagentFindings(obligation: ReviewObligation, overrides: Record<string, unknown> = {}) {
  const findings = {
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    reviewedBy: { sessionId: 'ses-child' },
    reviewedAt: NOW,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: obligation.obligationId,
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  };
  return findings as ReviewFindings;
}

function hostInvocation(
  obligation: ReviewObligation,
  findings: ReviewFindings,
  overrides: Record<string, unknown> = {},
): ReviewInvocationEvidence {
  const invocation = buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    attemptId: '00000000-0000-4000-8000-0000000000aa',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    parentSessionId: 'ses-parent',
    childSessionId: 'ses-child',
    promptHash: 'a'.repeat(64),
    findingsHash: hashFindings(findings),
    invokedAt: NOW,
    capturedRawFindings: findings,
  });
  return { ...invocation, ...overrides };
}

function assurance(obligations: ReviewObligation[], invocations: ReviewInvocationEvidence[]) {
  return {
    assuranceSchemaVersion: 'review-assurance.v6' as const,
    obligations,
    invocations,
    attempts: [],
    dispatches: invocations.map((invocation) => completedDispatchForInvocation(invocation)),
  };
}

describe('resolveReviewedArtifactIdentity', () => {
  it('HAPPY: exact producer obligation via attestation + unconsumed invocation', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const state = assurance([obligation], [hostInvocation(obligation, findings)]);
    const identity = resolveReviewedArtifactIdentity(state, 'plan', findings);
    expect(identity).toEqual({
      reviewedDigest: obligation.subjectDigest,
      reviewedObligationId: obligation.obligationId,
      reviewerIteration: findings.iteration,
      reviewedPlanVersion: findings.planVersion,
    });
  });

  it('HAPPY: historical provenance survives own-obligation consumption (blocker regression)', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const state = assurance(
      [{ ...obligation, status: 'consumed' }],
      [
        hostInvocation(obligation, findings, {
          consumedByObligationId: obligation.obligationId,
        }),
      ],
    );
    const identity = resolveReviewedArtifactIdentity(state, 'plan', findings);
    expect(identity?.reviewedDigest).toBe(obligation.subjectDigest);
  });

  it('BAD: invocation consumed by ANOTHER obligation is never provenance', () => {
    const obligation = planObligation();
    const other = createReviewObligation({
      policySnapshot: {
        challengePolicy: {
          version: 'challenge-policy.v1',
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
        },
        maxReviewerAttempts: 1,
      },
      obligationType: 'plan',
      reviewCycle: 1,
      iteration: 1,
      planVersion: 2,
      now: NOW,
      subjectDigest: 'plan-digest-v2',
      reviewMaterial: freezeReviewMaterial('frozen review material', 'plan-digest-v2'),
      reviewSubjectScope: artifactReviewSubjectScope(
        'plan',
        '## Approach\nBody2',
        'plan-digest-v2',
      ),
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    });
    const findings = subagentFindings(obligation);
    const state = assurance(
      [obligation, other],
      [hostInvocation(obligation, findings, { consumedByObligationId: other.obligationId })],
    );
    expect(resolveReviewedArtifactIdentity(state, 'plan', findings)).toBeUndefined();
  });

  it('BAD: attestation pointing at an obligation of a different type is rejected', () => {
    const implement = createReviewObligation({
      policySnapshot: {
        challengePolicy: {
          version: 'challenge-policy.v1',
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
        },
        maxReviewerAttempts: 1,
      },
      obligationType: 'implement',
      reviewCycle: 1,
      iteration: 0,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'impl-digest',
      reviewMaterial: freezeReviewMaterial('frozen review material', 'impl-digest'),
      changedFiles: ['src/foo.ts'],
      reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
    });
    const findings = subagentFindings(implement);
    const state = assurance([implement], []);
    expect(resolveReviewedArtifactIdentity(state, 'plan', findings)).toBeUndefined();
  });

  it('BAD: iteration/planVersion coherence mismatch is rejected', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, { iteration: 1 });
    const state = assurance([obligation], [hostInvocation(obligation, findings)]);
    expect(resolveReviewedArtifactIdentity(state, 'plan', findings)).toBeUndefined();
  });

  it('BAD: subagent findings without any invocation evidence are rejected', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const state = assurance([obligation], []);
    expect(resolveReviewedArtifactIdentity(state, 'plan', findings)).toBeUndefined();
  });

  it('HAPPY: subagent findings without attestation resolve via UNIQUE exact invocation match', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, { attestation: undefined });
    const state = assurance([obligation], [hostInvocation(obligation, findings)]);
    const identity = resolveReviewedArtifactIdentity(state, 'plan', findings);
    expect(identity?.reviewedDigest).toBe(obligation.subjectDigest);
  });

  it('BAD: self-mode findings without attestation are never guessed', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, {
      reviewMode: 'self',
      attestation: undefined,
    });
    const state = assurance([obligation], [hostInvocation(obligation, findings)]);
    expect(resolveReviewedArtifactIdentity(state, 'plan', findings)).toBeUndefined();
  });

  it('HAPPY: self-mode findings with attestation resolve via the producer obligation', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, { reviewMode: 'self' });
    const state = assurance([obligation], []);
    const identity = resolveReviewedArtifactIdentity(state, 'plan', findings);
    expect(identity?.reviewedDigest).toBe(obligation.subjectDigest);
  });

  it('CORNER: no findings yields no identity', () => {
    expect(resolveReviewedArtifactIdentity(assurance([], []), 'plan', undefined)).toBeUndefined();
  });
});

// =============================================================================
// Invocation-bound provenance (Cluster A) and diagnostic contracts
// =============================================================================

function bindObligation(
  obligation: ReviewObligation,
  invocation: ReviewInvocationEvidence,
): ReviewObligation {
  const bound = fulfillObligation(
    assurance([obligation], [invocation]),
    obligation.obligationId,
    invocation.invocationId,
    NOW,
  );
  return bound.obligations[0]!;
}

function captureWarnings(): {
  log: AdapterLogger;
  warnings: Array<{ service: string; event: string; extra: Record<string, unknown> | undefined }>;
} {
  const warnings: Array<{
    service: string;
    event: string;
    extra: Record<string, unknown> | undefined;
  }> = [];
  const log: AdapterLogger = {
    info: () => {},
    warn: (service, event, extra) => warnings.push({ service, event, extra }),
    error: () => {},
  };
  return { log, warnings };
}

function resolveWithWarnings(
  state: ReturnType<typeof assurance>,
  obligationType: 'plan',
  findings: ReviewFindings,
) {
  const { log, warnings } = captureWarnings();
  const identity = runWithAdapterLogger(log, () =>
    resolveReviewedArtifactIdentity(state, obligationType, findings),
  );
  return { identity, warnings };
}

describe('reviewed-digest invocation-bound provenance', () => {
  it('HAPPY: a fully bound invocation resolves through the invocationId path', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const invocation = hostInvocation(obligation, findings);
    const bound = bindObligation(obligation, invocation);
    const state = assurance([bound], [invocation]);

    const identity = resolveReviewedArtifactIdentity(state, 'plan', findings);

    expect(identity).toEqual({
      reviewedDigest: bound.subjectDigest,
      reviewedObligationId: bound.obligationId,
      reviewerIteration: findings.iteration,
      reviewedPlanVersion: findings.planVersion,
    });
  });

  it('HAPPY: own-obligation consumption keeps the bound invocation as provenance', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const invocation = hostInvocation(obligation, findings, {
      consumedByObligationId: obligation.obligationId,
    });
    const bound = bindObligation(obligation, invocation);

    const identity = resolveReviewedArtifactIdentity(
      assurance([bound], [invocation]),
      'plan',
      findings,
    );

    expect(identity?.reviewedObligationId).toBe(obligation.obligationId);
  });

  it('BAD: a differently bound invocationId is not provenance', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const invocation = hostInvocation(obligation, findings);
    // Bind the obligation to a DIFFERENT invocation id than the recorded one.
    const bound = fulfillObligation(
      assurance([obligation], [invocation]),
      obligation.obligationId,
      '00000000-0000-4000-8000-00000000dead',
      NOW,
    ).obligations[0]!;

    expect(
      resolveReviewedArtifactIdentity(assurance([bound], [invocation]), 'plan', findings),
    ).toBeUndefined();
  });

  it('BAD: an invocation bound to a different obligation id is not provenance', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const invocation = hostInvocation(obligation, findings, {
      obligationId: '00000000-0000-4000-8000-0000000000bb',
    });
    const bound = bindObligation(obligation, invocation);

    expect(
      resolveReviewedArtifactIdentity(assurance([bound], [invocation]), 'plan', findings),
    ).toBeUndefined();
  });

  it('BAD: a different child session id is not provenance', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const invocation = hostInvocation(obligation, findings, { childSessionId: 'ses-other' });
    const bound = bindObligation(obligation, invocation);

    expect(
      resolveReviewedArtifactIdentity(assurance([bound], [invocation]), 'plan', findings),
    ).toBeUndefined();
  });

  it('BAD: a different findings hash is not provenance', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const invocation = hostInvocation(obligation, findings, { findingsHash: 'f'.repeat(64) });
    const bound = bindObligation(obligation, invocation);

    expect(
      resolveReviewedArtifactIdentity(assurance([bound], [invocation]), 'plan', findings),
    ).toBeUndefined();
  });

  it('BAD: consumption by another obligation invalidates the bound provenance', () => {
    const obligation = planObligation();
    const other = createReviewObligation({
      policySnapshot: {
        challengePolicy: {
          version: 'challenge-policy.v1',
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
        },
        maxReviewerAttempts: 1,
      },
      obligationType: 'plan',
      reviewCycle: 1,
      iteration: 0,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'plan-digest-other',
      reviewMaterial: freezeReviewMaterial('frozen review material', 'plan-digest-other'),
      reviewSubjectScope: artifactReviewSubjectScope(
        'plan',
        '## Approach\nOther',
        'plan-digest-other',
      ),
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    });
    const findings = subagentFindings(obligation);
    const invocation = hostInvocation(obligation, findings, {
      consumedByObligationId: other.obligationId,
    });
    const bound = bindObligation(obligation, invocation);

    expect(
      resolveReviewedArtifactIdentity(assurance([bound, other], [invocation]), 'plan', findings),
    ).toBeUndefined();
  });

  it('CORNER: only the exact invocation among several is selected', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);
    const exact = hostInvocation(obligation, findings);
    const decoy = hostInvocation(obligation, findings, {
      childSessionId: 'ses-decoy',
      findingsHash: 'd'.repeat(64),
    });
    const bound = bindObligation(obligation, exact);
    const state = assurance([bound], [decoy, exact]);

    const identity = resolveReviewedArtifactIdentity(state, 'plan', findings);

    expect(identity?.reviewedObligationId).toBe(obligation.obligationId);
  });
});

describe('reviewed-digest producer obligation and diagnostics', () => {
  it('BAD: a native-task invocation with a different obligation id is rejected', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, { attestation: undefined });
    const invocation = hostInvocation(obligation, findings, {
      obligationId: '00000000-0000-4000-8000-0000000000cc',
    });

    expect(
      resolveReviewedArtifactIdentity(assurance([obligation], [invocation]), 'plan', findings),
    ).toBeUndefined();
  });

  it('BAD: a native-task invocation with a different child session id is rejected', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, { attestation: undefined });
    const invocation = hostInvocation(obligation, findings, { childSessionId: 'ses-other' });

    expect(
      resolveReviewedArtifactIdentity(assurance([obligation], [invocation]), 'plan', findings),
    ).toBeUndefined();
  });

  it('BAD: a native-task invocation with a different findings hash is rejected', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, { attestation: undefined });
    const invocation = hostInvocation(obligation, findings, { findingsHash: 'e'.repeat(64) });

    expect(
      resolveReviewedArtifactIdentity(assurance([obligation], [invocation]), 'plan', findings),
    ).toBeUndefined();
  });

  it('BAD: two matching obligations are ambiguous and never resolve by recency', () => {
    const first = planObligation();
    const second = createReviewObligation({
      policySnapshot: {
        challengePolicy: {
          version: 'challenge-policy.v1',
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
        },
        maxReviewerAttempts: 1,
      },
      obligationType: 'plan',
      reviewCycle: 1,
      iteration: 0,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'plan-digest-second',
      reviewMaterial: freezeReviewMaterial('frozen review material', 'plan-digest-second'),
      reviewSubjectScope: artifactReviewSubjectScope(
        'plan',
        '## Approach\nSecond',
        'plan-digest-second',
      ),
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    });
    const findings = subagentFindings(first, { attestation: undefined });
    const state = assurance(
      [first, second],
      [hostInvocation(first, findings), hostInvocation(second, findings)],
    );

    expect(resolveReviewedArtifactIdentity(state, 'plan', findings)).toBeUndefined();
  });

  it('BAD: an obligation of another type never contributes provenance', () => {
    const plan = planObligation();
    const implement = createReviewObligation({
      policySnapshot: {
        challengePolicy: {
          version: 'challenge-policy.v1',
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
        },
        maxReviewerAttempts: 1,
      },
      obligationType: 'implement',
      reviewCycle: 1,
      iteration: 0,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'impl-digest',
      reviewMaterial: freezeReviewMaterial('frozen review material', 'impl-digest'),
      changedFiles: ['src/foo.ts'],
      reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
    });
    const findings = subagentFindings(plan, { attestation: undefined });
    const state = assurance(
      [plan, implement],
      [hostInvocation(implement, findings, { obligationType: 'implement' })],
    );

    expect(resolveReviewedArtifactIdentity(state, 'plan', findings)).toBeUndefined();
  });

  it('BAD: an attestation id that does not exist warns with the candidate payload', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, {
      attestation: {
        ...subagentFindings(obligation).attestation,
        toolObligationId: '00000000-0000-4000-8000-0000000000dd',
      },
    });

    const { identity, warnings } = resolveWithWarnings(
      assurance([obligation], []),
      'plan',
      findings,
    );

    expect(identity).toBeUndefined();
    const mismatch = warnings.find((entry) => entry.event === 'reviewed_identity_type_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.extra).toMatchObject({
      obligationId: null,
      expected: 'plan',
      actual: null,
    });
  });

  it('BAD: an attestation id of another type warns with both types', () => {
    const implement = createReviewObligation({
      policySnapshot: {
        challengePolicy: {
          version: 'challenge-policy.v1',
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
        },
        maxReviewerAttempts: 1,
      },
      obligationType: 'implement',
      reviewCycle: 1,
      iteration: 0,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'impl-digest',
      reviewMaterial: freezeReviewMaterial('frozen review material', 'impl-digest'),
      changedFiles: ['src/foo.ts'],
      reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
    });
    const findings = subagentFindings(implement);

    const { identity, warnings } = resolveWithWarnings(
      assurance([implement], []),
      'plan',
      findings,
    );

    expect(identity).toBeUndefined();
    const mismatch = warnings.find((entry) => entry.event === 'reviewed_identity_type_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.extra).toMatchObject({
      obligationId: implement.obligationId,
      expected: 'plan',
      actual: 'implement',
    });
  });

  it('BAD: a coherence mismatch warns with obligation and findings values', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, { iteration: 1 });

    const { identity, warnings } = resolveWithWarnings(
      assurance([obligation], [hostInvocation(obligation, findings)]),
      'plan',
      findings,
    );

    expect(identity).toBeUndefined();
    const mismatch = warnings.find(
      (entry) => entry.event === 'reviewed_identity_coherence_mismatch',
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.extra).toMatchObject({
      obligationId: obligation.obligationId,
      obligationIteration: obligation.iteration,
      findingsIteration: 1,
    });
  });

  it('BAD: a subagent attestation without invocation proof warns with the obligation id', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation);

    const { identity, warnings } = resolveWithWarnings(
      assurance([obligation], []),
      'plan',
      findings,
    );

    expect(identity).toBeUndefined();
    const unproven = warnings.find(
      (entry) => entry.event === 'reviewed_identity_invocation_unproven',
    );
    expect(unproven).toBeDefined();
    expect(unproven!.extra).toMatchObject({
      obligationId: obligation.obligationId,
      reviewMode: 'subagent',
    });
  });

  it('BAD: unresolvable findings warn with the attestation and review mode', () => {
    const obligation = planObligation();
    const findings = subagentFindings(obligation, {
      attestation: {
        ...subagentFindings(obligation).attestation,
        toolObligationId: '00000000-0000-4000-8000-0000000000ee',
      },
    });

    const { warnings } = resolveWithWarnings(assurance([obligation], []), 'plan', findings);

    const unresolvable = warnings.find((entry) => entry.event === 'reviewed_identity_unresolvable');
    expect(unresolvable).toBeDefined();
    expect(unresolvable!.extra).toMatchObject({
      obligationType: 'plan',
      attestationObligationId: '00000000-0000-4000-8000-0000000000ee',
      reviewMode: 'subagent',
    });
  });

  it('HAPPY: reviewedIdentityFields projects every identity field', () => {
    const identity = {
      reviewedDigest: 'digest-1',
      reviewedObligationId: 'obligation-1',
      reviewerIteration: 2,
      reviewedPlanVersion: 3,
    };

    expect(reviewedIdentityFields(identity)).toEqual({
      reviewedDigest: 'digest-1',
      reviewedObligationId: 'obligation-1',
      reviewerIteration: 2,
      reviewedPlanVersion: 3,
    });
    expect(reviewedIdentityFields(undefined)).toEqual({});
  });
});
