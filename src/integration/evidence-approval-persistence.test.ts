/**
 * @module integration/evidence-approval-persistence.test
 * @description Persistence-boundary guard for a newly entered EXPORT_READY:
 * exactly what is written must clear the canonical evidence preflight.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { describe, expect, it } from 'vitest';
import { prepareStateWithAuditOperations } from './audit-outbox.js';
import { FIXED_TIME, makeProgressedState } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import type { PlanClaimDeclarations } from '../state/proofgraph-approval.js';

const CLAIM_ID = '00000000-0000-4000-8000-0000000000e1';

function criticalDeclarations(): PlanClaimDeclarations {
  return {
    flow: 'plan',
    version: 'v2',
    claims: [
      {
        claimId: CLAIM_ID,
        statement: 'the change preserves the intended behavior',
        critical: true,
        authoritySectionId: 's1',
        claimScope: 'specific_behavior',
        expectedCheckId: 'test',
      },
    ],
  };
}

function enteringExportReady(state: SessionState): SessionState {
  return {
    ...state,
    phase: 'EXPORT_READY',
    transition: { from: 'EVIDENCE_REVIEW', to: 'EXPORT_READY', event: 'APPROVE', at: FIXED_TIME },
  };
}

const TRANSITIONS = [
  { from: 'EVIDENCE_REVIEW', to: 'EXPORT_READY', event: 'APPROVE', at: FIXED_TIME },
];

describe('EXPORT_READY evidence-approval persistence guard', () => {
  it('persists a claimless, trigger-less approval that clears the preflight', async () => {
    const previous = makeProgressedState('EVIDENCE_REVIEW');
    const next = enteringExportReady({ ...previous, plan: null });
    const persisted = await prepareStateWithAuditOperations(previous, next, TRANSITIONS);
    expect(persisted.phase).toBe('EXPORT_READY');
  });

  it('refuses a newly entered EXPORT_READY whose evidence does not clear the preflight', async () => {
    const previous = makeProgressedState('EVIDENCE_REVIEW');
    const withClaims: SessionState = {
      ...previous,
      plan: { ...previous.plan!, claimDeclarations: criticalDeclarations() },
    };
    const next = enteringExportReady(withClaims);
    await expect(
      prepareStateWithAuditOperations(previous, next, TRANSITIONS),
    ).rejects.toMatchObject({ code: 'EXPORT_READY_APPROVAL_UNVERIFIED' });
  });

  it('does not treat same-phase metadata updates in EXPORT_READY as a new approval', async () => {
    const previous = enteringExportReady({ ...makeProgressedState('EVIDENCE_REVIEW'), plan: null });
    const next: SessionState = {
      ...previous,
      reviewCycles: { ...previous.reviewCycles, plan: previous.reviewCycles.plan + 1 },
    };
    const persisted = await prepareStateWithAuditOperations(previous, next, undefined);
    expect(persisted.phase).toBe('EXPORT_READY');
  });
});
