/**
 * @module integration/tools/plan/plan-auto-approval.test
 * @description Automatic plan-approval preparation: an accepted review under an
 * automatic policy is certified from the same bound review evidence as the
 * explicit path; an uncertifiable accepted review blocks the PLAN gate itself
 * (no automatic transition, no silent approval).
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAutomaticPlanApproval } from './plan-auto-approval.js';
import { persistPlanReview } from './plan-response.js';
import type { PlanExecutionScope } from './plan-types.js';
import { FIXED_TIME, makeState, PLAN_RECORD } from '../../../fixtures.js';
import {
  emptyClaimDeclarations,
  hasCurrentPlanApprovalCertificate,
} from '../../../state/proofgraph-approval.js';
import { planApprovalContextOf } from '../../../state/proofgraph-approval-context.js';
import { readState } from '../../../adapters/persistence.js';
import { createPolicySnapshot } from '../../../config/policy-snapshot.js';
import { getPolicyPreset } from '../../../config/policy.js';
import { createTestContext } from '../../../testing.js';
import { assuranceChain } from '../../../rails/review-decision-test-helpers.js';
import { hashText } from '../../../shared/hashing.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';

const OBLIGATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVOCATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function planAssurance(
  subjectDigest: string,
  capturedVerdict: 'accept' | 'changes_requested',
  claimDeclarationsDigest: string = hashText(
    canonicalJsonStringify(emptyClaimDeclarations('plan')),
  ),
) {
  return assuranceChain([
    {
      obligationId: OBLIGATION_ID,
      obligationType: 'plan',
      subjectDigest,
      status: 'consumed',
      invocationId: INVOCATION_ID,
      findingsHash: 'a'.repeat(64),
      capturedVerdict,
      claimDeclarationsDigest,
      consumedByObligationId: OBLIGATION_ID,
    },
  ]);
}

function planState(input: {
  readonly preset: 'solo' | 'team';
  readonly phase?: 'PLAN' | 'PLAN_REVIEW';
  readonly completion: 'reviewer_accepted' | 'review_exhausted';
  readonly withAssurance: boolean;
  readonly capturedVerdict?: 'accept' | 'changes_requested';
  readonly declarationsDigest?: string;
}) {
  return makeState(input.phase ?? 'PLAN_REVIEW', {
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
            input.declarationsDigest,
          ),
        }
      : {}),
  });
}

/** The preparation consumes only `policy` and `ctx` from the plan scope. */
function scopeFor(preset: 'solo' | 'team'): PlanExecutionScope {
  return {
    policy: getPolicyPreset(preset),
    ctx: createTestContext(FIXED_TIME),
  } as unknown as PlanExecutionScope;
}

describe('prepareAutomaticPlanApproval', () => {
  it('mints a policy_auto certificate for an accepted review under an automatic policy', () => {
    const state = planState({
      preset: 'solo',
      completion: 'reviewer_accepted',
      withAssurance: true,
    });
    const preparation = prepareAutomaticPlanApproval(state, scopeFor('solo'));
    expect(preparation.kind).toBe('ready');
    if (preparation.kind !== 'ready') return;
    const certificate = preparation.state.plan?.approvalCertificate;
    expect(certificate?.approvalAttestation.kind).toBe('policy_auto');
    expect(
      hasCurrentPlanApprovalCertificate(
        {
          current: PLAN_RECORD.current,
          claimDeclarations: emptyClaimDeclarations('plan'),
          approvalCertificate: certificate!,
        },
        planApprovalContextOf(preparation.state),
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
    const preparation = prepareAutomaticPlanApproval(state, scopeFor('solo'));
    expect(preparation.kind).toBe('ready');
    if (preparation.kind !== 'ready') return;
    expect(preparation.state.plan?.approvalCertificate).toBeUndefined();
    expect(preparation.state).toBe(state);
  });

  it('does not mint under a human-gated policy', () => {
    const state = planState({
      preset: 'team',
      completion: 'reviewer_accepted',
      withAssurance: true,
    });
    const preparation = prepareAutomaticPlanApproval(state, scopeFor('team'));
    expect(preparation.kind).toBe('ready');
    if (preparation.kind !== 'ready') return;
    expect(preparation.state.plan?.approvalCertificate).toBeUndefined();
  });

  it('blocks an accepted review without bound review evidence, even without critical claims', () => {
    const state = planState({
      preset: 'solo',
      completion: 'reviewer_accepted',
      withAssurance: false,
    });
    const preparation = prepareAutomaticPlanApproval(state, scopeFor('solo'));
    expect(preparation.kind).toBe('blocked');
    if (preparation.kind !== 'blocked') return;
    expect(preparation.block.code).toBe('PLAN_REVIEW_EVIDENCE_REQUIRED');
  });

  it('blocks accepted review evidence that does not resolve against the current declaration set', () => {
    const state = planState({
      preset: 'solo',
      completion: 'reviewer_accepted',
      withAssurance: true,
      declarationsDigest: hashText('different declarations'),
    });
    const preparation = prepareAutomaticPlanApproval(state, scopeFor('solo'));
    expect(preparation.kind).toBe('blocked');
    if (preparation.kind !== 'blocked') return;
    expect(preparation.block.code).toBe('PLAN_REVIEW_EVIDENCE_REQUIRED');
    expect(preparation.block.reason).toContain('missing');
  });
});

describe('persistPlanReview automatic-approval denial', () => {
  let sessDir: string;
  beforeEach(async () => {
    sessDir = await mkdtemp(join(tmpdir(), 'flowguard-plan-auto-'));
  });
  afterEach(async () => {
    await rm(sessDir, { recursive: true, force: true });
  });

  it('persists the gate entry and applies NO automatic transition when an accepted review is uncertifiable', async () => {
    const reviewedState = planState({
      preset: 'solo',
      phase: 'PLAN',
      completion: 'reviewer_accepted',
      withAssurance: false,
    });
    const scope = {
      policy: getPolicyPreset('solo'),
      ctx: createTestContext(FIXED_TIME),
      sessDir,
    } as unknown as PlanExecutionScope;

    const response = await persistPlanReview(
      scope,
      {} as never,
      { overallVerdict: 'accept' } as never,
      undefined as never,
      () => reviewedState,
    );

    const payload = JSON.parse(response) as Record<string, unknown>;
    expect(payload.error).toBe(true);
    expect(payload.code).toBe('PLAN_REVIEW_EVIDENCE_REQUIRED');
    expect(payload.phase).toBe('PLAN_REVIEW');

    const persisted = await readState(sessDir);
    expect(persisted?.phase).toBe('PLAN_REVIEW');
    expect(persisted?.plan?.approvalCertificate).toBeUndefined();
    expect(persisted?.transition?.event).toBe('SELF_REVIEW_MET');
    expect(persisted?.phase).not.toBe('VALIDATION');
    expect(persisted?.phase).not.toBe('EXPORT_READY');
  });
});
