/** Operation-scoped persistence witnesses; unrelated changes must stay unproven. */
import { describe, expect, it } from 'vitest';
import { expectRecovery, recoveryPersisted } from '../../../demos/lib/recovery-state.mjs';
import { approvedPlan, reviewedPlan } from '../demo-recovery-test-helpers.js';

describe('operation-scoped recovery witnesses', () => {
  it('accepts the authorized approval of the exact reviewed plan and obligation', () => {
    const expected = expectRecovery(reviewedPlan(), ['flowguard_plan'], 'COMPLETE');
    expect(expected.kind).toBe('subject_approval');
    expect(recoveryPersisted(expected, approvedPlan(), 'approve')).toBe(true);
  });

  it('rejects arbitrary state/file-digest changes, including a phase-only change', () => {
    const state = reviewedPlan();
    const expected = expectRecovery(state, ['flowguard_plan'], 'COMPLETE');
    expect(recoveryPersisted(expected, { ...state, logging: { level: 'debug' } }, 'approve')).toBe(
      false,
    );
    expect(recoveryPersisted(expected, { ...state, phase: 'IMPLEMENTATION' }, 'approve')).toBe(
      false,
    );
  });

  it('rejects a certificate for a different plan, revision, obligation or host', () => {
    const expected = expectRecovery(reviewedPlan(), ['flowguard_plan'], 'COMPLETE');
    const approved = approvedPlan();
    const foreignPlan = structuredClone(approved);
    foreignPlan.plan.current.digest = 'plan-B';
    foreignPlan.plan.approvalCertificate.authorityDigest = 'plan-B';
    expect(recoveryPersisted(expected, foreignPlan, 'approve')).toBe(false);
    const foreignReview = structuredClone(approved);
    foreignReview.plan.approvalCertificate.reviewBinding.reviewObligationId = 'ob-B';
    expect(recoveryPersisted(expected, foreignReview, 'approve')).toBe(false);
    const foreignRevision = structuredClone(approved);
    foreignRevision.plan.current.recordDigest = 'record-B';
    expect(recoveryPersisted(expected, foreignRevision, 'approve')).toBe(false);
    const foreignHost = structuredClone(approved);
    foreignHost.binding.hostSessionId = 'ses_other';
    expect(recoveryPersisted(expected, foreignHost, 'approve')).toBe(false);
    expect(recoveryPersisted(expected, approved, 'status')).toBe(false);
  });

  it('does not turn unsupported or missing subject evidence into a recovery', () => {
    const expected = expectRecovery({ phase: 'PLAN' }, ['flowguard_plan'], 'COMPLETE');
    expect(expected.kind).toBe('unproven');
    expect(recoveryPersisted(expected, approvedPlan(), 'approve')).toBe(false);
  });

  it('does not bind a denial naming Plan A to the successful persistence of Plan B', () => {
    const expected = expectRecovery(reviewedPlan(), ['flowguard_plan'], 'COMPLETE', [['plan-B']]);
    expect(expected.kind).toBe('unproven');
    expect(recoveryPersisted(expected, approvedPlan(), 'approve')).toBe(false);
  });

  it('binds CONTINUE_AMBIGUOUS to the selected task operation and actual ticket', () => {
    const ready = {
      phase: 'READY',
      flowguardSessionId: 'fg-1',
      binding: { hostSessionId: 'ses_parent' },
    };
    const expected = expectRecovery(ready, ['flowguard_continue'], 'COMPLETE');
    expect(recoveryPersisted(expected, { ...ready, phase: 'TICKET' }, 'task')).toBe(false);
    const captured = { ...ready, phase: 'TICKET', ticket: { digest: 'ticket-A' } };
    expect(recoveryPersisted(expected, captured, 'status')).toBe(false);
    expect(recoveryPersisted(expected, captured, 'task')).toBe(true);
  });
});
