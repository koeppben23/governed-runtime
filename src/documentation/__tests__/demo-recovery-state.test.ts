/** Operation-scoped persistence witnesses; unrelated changes must stay unproven. */
import { describe, expect, it } from 'vitest';
import {
  expectRecovery,
  implementationReviewAcceptanceProven,
  recoveryPersisted,
} from '../../../demos/lib/recovery-state.mjs';
import { hashText } from '../../shared/hashing.js';
import { approvedPlan, reviewedPlan } from '../demo-recovery-test-helpers.js';

describe('implementation review acceptance witness', () => {
  const digest = 'impl-digest-1';
  function accepting() {
    return {
      phase: 'EVIDENCE_REVIEW',
      implementation: { digest },
      reviewAssurance: {
        obligations: [
          {
            obligationId: 'ob-1',
            obligationType: 'implement',
            subjectDigest: digest,
            status: 'consumed',
            consumedAt: '2026-10-16T00:00:00.000Z',
            invocationId: 'inv-1',
          },
        ],
        invocations: [
          {
            invocationId: 'inv-1',
            obligationId: 'ob-1',
            attemptId: 'att-1',
            consumedByObligationId: 'ob-1',
            capturedVerdict: 'accept',
            structuredOutputUsed: true,
          },
        ],
        attempts: [{ attemptId: 'att-1', obligationId: 'ob-1', subjectDigest: digest }],
      },
    };
  }

  it('proves an implementation recovery only through the bound, consumed acceptance', () => {
    expect(implementationReviewAcceptanceProven(accepting())).toBe(true);

    const wrongVerdict = structuredClone(accepting());
    wrongVerdict.reviewAssurance.invocations[0]!.capturedVerdict = 'changes_requested';
    expect(implementationReviewAcceptanceProven(wrongVerdict)).toBe(false);

    const notConsumed = structuredClone(accepting());
    notConsumed.reviewAssurance.obligations[0]!.status = 'fulfilled';
    expect(implementationReviewAcceptanceProven(notConsumed)).toBe(false);

    const withoutStructured = structuredClone(accepting());
    withoutStructured.reviewAssurance.invocations[0]!.structuredOutputUsed = false;
    expect(implementationReviewAcceptanceProven(withoutStructured)).toBe(false);

    const foreignDigest = structuredClone(accepting());
    foreignDigest.implementation.digest = 'impl-digest-2';
    expect(implementationReviewAcceptanceProven(foreignDigest)).toBe(false);

    expect(implementationReviewAcceptanceProven({})).toBe(false);
  });
});

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
  const ticketText = '# TICKET: Document local build';
  const ticketDigest = hashText(ticketText);
  const adoptedTicket = {
    ...actor,
    phase: 'TICKET',
    ticket: {
      digest: ticketDigest,
      text: ticketText,
      source: 'user',
      references: [{ ref: 'TICKET_DOCS.md', type: 'doc' }],
    },
  };
  const adoptionAudit = [
    {
      auditSequence: 1,
      flowguardSessionId: 'fg-1',
      event: 'tool_call:flowguard_ticket',
      detail: { tool: 'flowguard_ticket', success: false, errorCode: 'TICKET_SOURCE_CONFLICT' },
    },
    {
      auditSequence: 2,
      flowguardSessionId: 'fg-1',
      event: 'tool_call:flowguard_ticket',
      detail: { tool: 'flowguard_ticket', success: true, transitionCount: 1 },
    },
    {
      auditSequence: 3,
      flowguardSessionId: 'fg-1',
      event: 'transition:TICKET_SELECTED',
      detail: { from: 'READY', to: 'TICKET', event: 'TICKET_SELECTED' },
    },
  ];

  it('accepts the same-turn adoption of the exact persisted ticket with its audit sequence', () => {
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE');
    expect(expected.kind).toBe('ticket_adoption');
    expect((expected as { digest?: string }).digest).toBe(ticketDigest);
    expect(recoveryPersisted(expected, adoptedTicket, 'task', adoptionAudit)).toBe(true);
  });

  it('settles the input-origin conflict through the same adoption witness only', () => {
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE');
    const originAudit = adoptionAudit.map((event, index) =>
      index === 0
        ? {
            ...event,
            detail: { ...event.detail, errorCode: 'TICKET_SOURCE_ORIGIN_CONFLICT' },
          }
        : event,
    );
    expect(recoveryPersisted(expected, adoptedTicket, 'task', originAudit)).toBe(true);
    const foreignAudit = adoptionAudit.map((event, index) =>
      index === 0 ? { ...event, detail: { ...event.detail, errorCode: 'SOMETHING_ELSE' } } : event,
    );
    expect(recoveryPersisted(expected, adoptedTicket, 'task', foreignAudit)).toBe(false);
  });

  it('rejects content that does not hash to the expected ticket digest', () => {
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE');
    const tampered = structuredClone(adoptedTicket);
    tampered.ticket.text = `${ticketText} (tampered)`;
    expect(recoveryPersisted(expected, tampered, 'task', adoptionAudit)).toBe(false);
    // The digest is only trusted when it is the SHA-256 of the stored content.
    const wrongDigest = expectRecovery(
      { ...adoptedTicket, ticket: { ...adoptedTicket.ticket, digest: 'ticket-A' } },
      ['flowguard_ticket'],
      'COMPLETE',
    );
    expect(wrongDigest.kind).toBe('unproven');
  });

  it('rejects a historical audit sequence from another session or before the turn floor', () => {
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE');
    const foreignSession = adoptionAudit.map((event) => ({
      ...event,
      flowguardSessionId: 'fg-other',
    }));
    expect(recoveryPersisted(expected, adoptedTicket, 'task', foreignSession)).toBe(false);
    // Events 1..3 are already persisted before this recovery turn (floor 3).
    const floored = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE', [], 3);
    expect(recoveryPersisted(floored, adoptedTicket, 'task', adoptionAudit)).toBe(false);
    // The denial itself must also lie inside the current turn: a success and
    // transition without their in-turn denial never confirm the recovery.
    const flooredAfterDenial = expectRecovery(
      adoptedTicket,
      ['flowguard_ticket'],
      'COMPLETE',
      [],
      1,
    );
    expect(recoveryPersisted(flooredAfterDenial, adoptedTicket, 'task', adoptionAudit)).toBe(false);
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

  it('reproduces the former reduced-on failure with the real ticket identity and audit sequence', () => {
    // Values captured from the failing full-sweep run (session
    // ses_ec8e3f6f9ffeqJ3uRUQ87uNkLs, 2026-10-13): the exact persisted ticket
    // text and digest plus the audit sequence that corrected the conflict
    // denial. Capturing the original bytes keeps the digest-content invariant
    // honest instead of pinning an inconsistent pair.
    const originalText =
      '# TICKET: Document Local Build and Test Instructions\n\n## Summary\n\nThe Task Manager has no usage notes describing how to build, run, and test the\napplication locally. Add a short, self-contained guide at `docs/usage-notes.md`\nso a new contributor can start from a fresh checkout.\n\n## Required Change\n\nCreate `docs/usage-notes.md` with a short guide covering:\n\n1. Prerequisites (JDK 21+).\n2. Build and full verification: `./mvnw verify`.\n3. Running the test suite: `./mvnw test`.\n4. Starting the application locally: `./mvnw spring-boot:run` (default port\n   8080, see `src/main/resources/application.properties`).\n5. A short example of the task API endpoints.\n\n## Do Not Change\n\n- Do not change any Java source or test file.\n- Do not change `README.md`, `TICKET.md`, `ADR_TICKET.md`, or the Maven build.\n- Do not add files other than `docs/usage-notes.md`.\n\n## Acceptance Criteria\n\n- `docs/usage-notes.md` exists and is non-empty.\n- It documents `./mvnw verify` and `./mvnw test`.\n- No other file in the repository changed.\n';
    const originalDigest = 'e3db9099de201438b35a5354690b838ab249638fffe375466dc38c1314934aa3';
    expect(hashText(originalText)).toBe(originalDigest);
    const state = {
      ...actor,
      phase: 'TICKET',
      ticket: {
        digest: originalDigest,
        text: originalText,
        source: 'user',
        references: [{ ref: 'TICKET_DOCS.md', type: 'doc' }],
      },
    };
    const audit = [
      {
        auditSequence: 1,
        flowguardSessionId: 'fg-1',
        event: 'tool_call:flowguard_ticket',
        detail: { tool: 'flowguard_ticket', success: false, errorCode: 'TICKET_SOURCE_CONFLICT' },
      },
      {
        auditSequence: 2,
        flowguardSessionId: 'fg-1',
        event: 'tool_call:flowguard_ticket',
        detail: { tool: 'flowguard_ticket', success: true, transitionCount: 1 },
      },
      {
        auditSequence: 3,
        flowguardSessionId: 'fg-1',
        event: 'transition:TICKET_SELECTED',
        detail: { from: 'READY', to: 'TICKET', event: 'TICKET_SELECTED' },
      },
    ];
    const expected = expectRecovery(state, ['flowguard_ticket'], 'COMPLETE');
    expect(expected.kind).toBe('ticket_adoption');
    expect(recoveryPersisted(expected, state, 'task', audit)).toBe(true);
    // The persisted ticket alone, without the operational sequence, stays unproven.
    expect(recoveryPersisted(expected, state, 'task', [audit[1]])).toBe(false);
  });

  it('keeps a conflicting denial identity unproven', () => {
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE', [
      { bindings: {}, conflicts: ['subjectDigest'] },
    ]);
    expect(expected.kind).toBe('unproven');
    expect(recoveryPersisted(expected, adoptedTicket, 'task', adoptionAudit)).toBe(false);
  });
});
