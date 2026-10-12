/**
 * @module integration/tools/plan/plan-auto-approval.test
 * @description Automatic plan-approval certificate minting: an accepted review
 * under an automatic policy is certified from the same bound review evidence as
 * the explicit path; exhausted reviews are never certified automatically.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { describe, expect, it } from 'vitest';
import { mintAutomaticPlanApprovalCertificateIfPermitted } from './plan-auto-approval.js';
import type { PlanExecutionScope } from './plan-types.js';
import { FIXED_TIME, makeState, PLAN_RECORD } from '../../../fixtures.js';
import { emptyClaimDeclarations } from '../../../state/proofgraph-approval.js';
import { hasCurrentPlanApprovalCertificate } from '../../../state/proofgraph-approval.js';
import { planApprovalContextOf } from '../../../state/proofgraph-approval-context.js';
import { createPolicySnapshot } from '../../../config/policy-snapshot.js';
import { getPolicyPreset } from '../../../config/policy.js';
import { createTestContext } from '../../../testing.js';
import { assuranceChain } from '../../../rails/review-decision-test-helpers.js';
import { hashText } from '../../../shared/hashing.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';

const OBLIGATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVOCATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function planAssurance(subjectDigest: string, capturedVerdict: 'accept' | 'changes_requested') {
  return assuranceChain([
    {
      obligationId: OBLIGATION_ID,
      obligationType: 'plan',
      subjectDigest,
      status: 'consumed',
      invocationId: INVOCATION_ID,
      findingsHash: 'a'.repeat(64),
      capturedVerdict,
      claimDeclarationsDigest: hashText(canonicalJsonStringify(emptyClaimDeclarations('plan'))),
      consumedByObligationId: OBLIGATION_ID,
    },
  ]);
}

function planState(input: {
  readonly preset: 'solo' | 'team';
  readonly completion: 'reviewer_accepted' | 'review_exhausted';
  readonly withAssurance: boolean;
  readonly capturedVerdict?: 'accept' | 'changes_requested';
}) {
  return makeState('PLAN_REVIEW', {
    policySnapshot: createPolicySnapshot(getPolicyPreset(input.preset), FIXED_TIME, hashText),
    plan: {
      ...PLAN_RECORD,
      reviewCompletion: input.completion,
      claimDeclarations: emptyClaimDeclarations('plan'),
    },
    ...(input.withAssurance
      ? {
          reviewAssurance: planAssurance(
            PLAN_RECORD.current.digest,
            input.capturedVerdict ?? 'accept',
          ),
        }
      : {}),
  });
}

/** The minting helper consumes only `policy` and `ctx` from the plan scope. */
function scopeFor(preset: 'solo' | 'team'): PlanExecutionScope {
  return {
    policy: getPolicyPreset(preset),
    ctx: createTestContext(FIXED_TIME),
  } as unknown as PlanExecutionScope;
}

describe('mintAutomaticPlanApprovalCertificateIfPermitted', () => {
  it('mints a policy_auto certificate for an accepted review under an automatic policy', () => {
    const state = planState({
      preset: 'solo',
      completion: 'reviewer_accepted',
      withAssurance: true,
    });
    const minted = mintAutomaticPlanApprovalCertificateIfPermitted(state, scopeFor('solo'));
    const certificate = minted.plan?.approvalCertificate;
    expect(certificate).toBeDefined();
    expect(certificate?.approvalAttestation.kind).toBe('policy_auto');
    expect(
      hasCurrentPlanApprovalCertificate(
        {
          current: PLAN_RECORD.current,
          claimDeclarations: emptyClaimDeclarations('plan'),
          approvalCertificate: certificate!,
        },
        planApprovalContextOf(minted),
      ),
    ).toBe(true);
  });

  it('never certifies an exhausted review automatically', () => {
    const state = planState({
      preset: 'solo',
      completion: 'review_exhausted',
      withAssurance: true,
      capturedVerdict: 'changes_requested',
    });
    const minted = mintAutomaticPlanApprovalCertificateIfPermitted(state, scopeFor('solo'));
    expect(minted.plan?.approvalCertificate).toBeUndefined();
    expect(minted).toBe(state);
  });

  it('does not mint under a human-gated policy', () => {
    const state = planState({
      preset: 'team',
      completion: 'reviewer_accepted',
      withAssurance: true,
    });
    const minted = mintAutomaticPlanApprovalCertificateIfPermitted(state, scopeFor('team'));
    expect(minted.plan?.approvalCertificate).toBeUndefined();
  });

  it('does not mint without bound review evidence', () => {
    const state = planState({
      preset: 'solo',
      completion: 'reviewer_accepted',
      withAssurance: false,
    });
    const minted = mintAutomaticPlanApprovalCertificateIfPermitted(state, scopeFor('solo'));
    expect(minted.plan?.approvalCertificate).toBeUndefined();
  });
});
