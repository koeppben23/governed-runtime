/**
 * @module integration/review/rejected-digests.test
 * @description Unit contract for the historical rejected-digest projection:
 *              implementation digests that an independent reviewer has EVER
 *              rejected must be derivable from the append-only obligations +
 *              bound findings — including across rounds where the single-slot
 *              `implementationRework` marker has moved on.
 */

import { describe, it, expect } from 'vitest';
import { assuranceWith, makeState, FIXED_TIME } from '../../fixtures.js';
import type { ReviewFindings, ReviewObligation } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { collectHistoricallyRejectedImplementationDigests } from './rejected-digests.js';

function implementObligation(id: string, digest: string): ReviewObligation {
  return {
    obligationId: id,
    obligationType: 'implement',
    iteration: 1,
    planVersion: 1,
    criteriaVersion: 'criteria-v1',
    mandateDigest: 'mandate-digest',
    createdAt: FIXED_TIME,
    pluginHandshakeAt: null,
    status: 'consumed',
    invocationId: null,
    blockedCode: null,
    fulfilledAt: FIXED_TIME,
    consumedAt: FIXED_TIME,
    subjectDigest: digest,
    reviewSubjectScope: { kind: 'implementation', implementationDigest: digest },
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    maxReviewerOutputRepairAttempts: 0,
  };
}

function planObligation(id: string, digest: string): ReviewObligation {
  return {
    obligationId: id,
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    criteriaVersion: 'criteria-v1',
    mandateDigest: 'mandate-digest',
    createdAt: FIXED_TIME,
    pluginHandshakeAt: null,
    status: 'consumed',
    invocationId: null,
    blockedCode: null,
    fulfilledAt: FIXED_TIME,
    consumedAt: FIXED_TIME,
    subjectDigest: digest,
    reviewSubjectScope: {
      kind: 'artifact',
      artifact: { kind: 'plan', digest, sectionPaths: [] },
    },
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    maxReviewerOutputRepairAttempts: 0,
  };
}

function finding(obligationId: string, verdict: 'accept' | 'changes_requested'): ReviewFindings {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_r' },
    reviewedAt: FIXED_TIME,
    attestation: {
      mandateDigest: 'mandate-digest',
      criteriaVersion: 'criteria-v1',
      toolObligationId: obligationId,
      iteration: 1,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
  };
}

function stateWith(opts: {
  obligations: ReviewObligation[];
  findings: ReviewFindings[];
  rework?: SessionState['implementationRework'];
}): SessionState {
  return {
    ...makeState('IMPLEMENTATION'),
    reviewAssurance: assuranceWith({ obligations: opts.obligations }),
    implementationRework: opts.rework ?? null,
    implReviewFindings: opts.findings.length > 0 ? opts.findings : undefined,
  };
}

describe('collectHistoricallyRejectedImplementationDigests', () => {
  it('projects every changesto-requested digest bound to a consumed implementation obligation', () => {
    const d1 = 'digest-d1';
    const d2 = 'digest-d2';
    const result = collectHistoricallyRejectedImplementationDigests(
      stateWith({
        obligations: [implementObligation('aaa', d1), implementObligation('bbb', d2)],
        findings: [finding('aaa', 'changes_requested'), finding('bbb', 'changes_requested')],
      }),
    );
    expect([...result].sort()).toEqual([d1, d2].sort());
  });

  it('retains round-1 rejected digests after a later round closed the marker (multi-round reuse)', () => {
    const d1 = 'digest-d1';
    const d2 = 'digest-d2';
    const result = collectHistoricallyRejectedImplementationDigests(
      stateWith({
        obligations: [implementObligation('aaa', d1), implementObligation('bbb', d2)],
        findings: [finding('aaa', 'changes_requested'), finding('bbb', 'changes_requested')],
        // The single-slot marker moved on to D2 after round 2 entered IMPL_REVIEW.
        rework: { rejectedDigest: d2, exhausted: false },
      }),
    );
    expect(result.has(d1)).toBe(true);
    expect(result.has(d2)).toBe(true);
  });

  it('excludes accepted findings, unattributed findings, and non-implementation obligations', () => {
    const result = collectHistoricallyRejectedImplementationDigests(
      stateWith({
        obligations: [
          implementObligation('aaa', 'digest-accepted'),
          implementObligation('bbb', 'digest-attestation-missing'),
          planObligation('ccc', 'digest-plan'),
        ],
        findings: [
          finding('aaa', 'accept'),
          { ...finding('bbb', 'changes_requested'), attestation: undefined },
          finding('ccc', 'changes_requested'),
        ],
      }),
    );
    expect([...result]).toEqual([]);
  });

  it('ignores findings whose obligation id does not resolve in this session', () => {
    const result = collectHistoricallyRejectedImplementationDigests(
      stateWith({
        obligations: [implementObligation('aaa', 'digest-d1')],
        findings: [finding('other-obligation', 'changes_requested')],
      }),
    );
    expect([...result]).toEqual([]);
  });
});
