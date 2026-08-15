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
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './assurance.js';
import { hashFindings } from './findings-hash.js';
import { resolveReviewedArtifactIdentity } from './reviewed-digest.js';

const NOW = '2026-08-15T10:00:00.000Z';

function planObligation(): ReviewObligation {
  return createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'plan-digest-v1',
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
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    parentSessionId: 'ses-parent',
    childSessionId: 'ses-child',
    invocationMode: 'host_subagent_task',
    hostVisible: true,
    promptHash: 'sha256-prompt',
    findingsHash: hashFindings(findings),
    invokedAt: NOW,
    source: 'host-orchestrated',
  });
  return { ...invocation, ...overrides } as ReviewInvocationEvidence;
}

function assurance(obligations: ReviewObligation[], invocations: ReviewInvocationEvidence[]) {
  return {
    assuranceSchemaVersion: 'review-assurance.v5' as const,
    obligations,
    invocations,
    attempts: [],
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
      obligationType: 'plan',
      iteration: 1,
      planVersion: 2,
      now: NOW,
      subjectDigest: 'plan-digest-v2',
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
      obligationType: 'implement',
      iteration: 0,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'impl-digest',
      changedFiles: ['src/foo.ts'],
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
