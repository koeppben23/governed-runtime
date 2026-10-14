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
    const expected = expectRecovery(reviewedPlan(), ['flowguard_plan'], 'COMPLETE', [
      { bindings: { subjectDigest: 'plan-B' }, conflicts: [] },
    ]);
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

describe('ticket-adoption recovery witnesses', () => {
  const actor = {
    flowguardSessionId: 'fg-1',
    binding: { hostSessionId: 'ses_parent' },
  };
  const adoptedTicket = {
    ...actor,
    phase: 'TICKET',
    ticket: {
      digest: 'ticket-A',
      text: '# TICKET: Document local build',
      source: 'user',
      references: [{ ref: 'TICKET_DOCS.md', type: 'doc' }],
    },
  };
  const adoptionAudit = [
    {
      auditSequence: 1,
      event: 'tool_call:flowguard_ticket',
      detail: { tool: 'flowguard_ticket', success: false, errorCode: 'TICKET_SOURCE_CONFLICT' },
    },
    {
      auditSequence: 2,
      event: 'tool_call:flowguard_ticket',
      detail: { tool: 'flowguard_ticket', success: true, transitionCount: 1 },
    },
    {
      auditSequence: 3,
      event: 'transition:TICKET_SELECTED',
      detail: { from: 'READY', to: 'TICKET', event: 'TICKET_SELECTED' },
    },
  ];

  it('accepts the same-turn adoption of the exact persisted ticket with its audit sequence', () => {
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE');
    expect(expected.kind).toBe('ticket_adoption');
    expect((expected as { digest?: string }).digest).toBe('ticket-A');
    expect(recoveryPersisted(expected, adoptedTicket, 'task', adoptionAudit)).toBe(true);
  });

  it('does not turn a missing or empty persisted ticket into a recovery', () => {
    const missing = expectRecovery({ ...actor, phase: 'TICKET' }, ['flowguard_ticket'], 'COMPLETE');
    expect(missing.kind).toBe('unproven');
    expect(recoveryPersisted(missing, adoptedTicket, 'task', adoptionAudit)).toBe(false);
    const empty = expectRecovery(
      { ...adoptedTicket, ticket: { digest: '', text: '' } },
      ['flowguard_ticket'],
      'COMPLETE',
    );
    expect(empty.kind).toBe('unproven');
  });

  it('rejects a different, cleared or phase-foreign ticket identity', () => {
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE');
    const other = structuredClone(adoptedTicket);
    other.ticket.digest = 'ticket-B';
    expect(recoveryPersisted(expected, other, 'task', adoptionAudit)).toBe(false);
    expect(
      recoveryPersisted(expected, { ...adoptedTicket, ticket: null }, 'task', adoptionAudit),
    ).toBe(false);
    const foreignPhase = { ...adoptedTicket, phase: 'PLAN_REVIEW' };
    expect(recoveryPersisted(expected, foreignPhase, 'task', adoptionAudit)).toBe(false);
    const foreignContent = structuredClone(adoptedTicket);
    foreignContent.ticket.text = '';
    expect(recoveryPersisted(expected, foreignContent, 'task', adoptionAudit)).toBe(false);
  });

  it('requires the operational audit sequence, not a bare tool-level success', () => {
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE');
    expect(recoveryPersisted(expected, adoptedTicket, 'task', [])).toBe(false);
    const [denial, success] = adoptionAudit;
    expect(recoveryPersisted(expected, adoptedTicket, 'task', [denial, success])).toBe(false);
    expect(
      recoveryPersisted(expected, adoptedTicket, 'task', [
        denial,
        success,
        { auditSequence: 4, event: 'transition:PLAN_READY', detail: {} },
      ]),
    ).toBe(false);
    const transitionBeforeSuccess = [denial, adoptionAudit[2], success];
    expect(recoveryPersisted(expected, adoptedTicket, 'task', transitionBeforeSuccess)).toBe(false);
  });

  it('rejects a ticket adopted before the conflict denial and a foreign actor or command', () => {
    const adoptionBeforeDenial = [adoptionAudit[2], adoptionAudit[0], adoptionAudit[1]];
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE');
    expect(recoveryPersisted(expected, adoptedTicket, 'task', adoptionBeforeDenial)).toBe(false);
    expect(recoveryPersisted(expected, adoptedTicket, 'plan', adoptionAudit)).toBe(false);
    const foreignHost = structuredClone(adoptedTicket);
    foreignHost.binding.hostSessionId = 'ses_other';
    expect(recoveryPersisted(expected, foreignHost, 'task', adoptionAudit)).toBe(false);
  });

  it('keeps a conflicting denial identity unproven', () => {
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE', [
      { bindings: {}, conflicts: ['subjectDigest'] },
    ]);
    expect(expected.kind).toBe('unproven');
    expect(recoveryPersisted(expected, adoptedTicket, 'task', adoptionAudit)).toBe(false);
  });
});
