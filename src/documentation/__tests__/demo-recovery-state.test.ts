/** Operation-scoped persistence witnesses; unrelated changes must stay unproven. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expectRecovery,
  implementationReviewAcceptanceProven,
  recoveryPersisted,
} from '../../../demos/lib/recovery-state.mjs';
import {
  loadInstalledReviewInvocationValidator,
  reviewInvocationValidator,
} from '../../../demos/lib/review-recovery-authority.mjs';
import { hashText } from '../../shared/hashing.js';
import { ReviewInvocationEvidence } from '../../state/evidence-review-invocation.js';
import {
  approvedPlan,
  consumedReview,
  reviewedPlan,
  validateReviewInvocation,
} from '../demo-recovery-test-helpers.js';

const foreignId = 'a7704ff0-f4f0-4eed-a8d1-3ca952e71068';
const expectPlan = (state = reviewedPlan()) =>
  expectRecovery(state, ['flowguard_plan'], 'COMPLETE', [], 0, [], validateReviewInvocation);
const persistsReview = (expected: unknown, state: unknown, command: string) =>
  recoveryPersisted(expected, state, command, [], validateReviewInvocation);

describe('implementation review acceptance witness', () => {
  const digest = 'impl-digest-1';
  function accepting() {
    const state = reviewedPlan();
    return {
      ...state,
      phase: 'EVIDENCE_REVIEW',
      implementation: { digest },
      reviewAssurance: consumedReview('implement', digest),
    };
  }

  it('proves an implementation recovery only through the bound, consumed acceptance', () => {
    expect(implementationReviewAcceptanceProven(accepting(), validateReviewInvocation)).toBe(true);

    const wrongVerdict = structuredClone(accepting());
    wrongVerdict.reviewAssurance.invocations[0]!.capturedVerdict = 'changes_requested';
    expect(implementationReviewAcceptanceProven(wrongVerdict, validateReviewInvocation)).toBe(
      false,
    );

    const notConsumed = structuredClone(accepting());
    notConsumed.reviewAssurance.obligations[0]!.status = 'fulfilled';
    expect(implementationReviewAcceptanceProven(notConsumed, validateReviewInvocation)).toBe(false);

    const withoutProvenance = accepting();
    Reflect.deleteProperty(withoutProvenance.reviewAssurance.invocations[0]!, 'nativeProvenance');
    expect(implementationReviewAcceptanceProven(withoutProvenance, validateReviewInvocation)).toBe(
      false,
    );

    const foreignDigest = structuredClone(accepting());
    foreignDigest.implementation.digest = 'impl-digest-2';
    expect(implementationReviewAcceptanceProven(foreignDigest, validateReviewInvocation)).toBe(
      false,
    );

    expect(implementationReviewAcceptanceProven({})).toBe(false);
  });
});

describe('operation-scoped recovery witnesses', () => {
  it('accepts the authorized approval of the exact reviewed plan and obligation', () => {
    const expected = expectPlan();
    expect(expected.kind).toBe('subject_approval');
    expect(persistsReview(expected, approvedPlan(), 'approve')).toBe(true);
    expect(recoveryPersisted(expected, approvedPlan(), 'approve')).toBe(false);
  });

  it('rejects arbitrary state/file-digest changes, including a phase-only change', () => {
    const state = reviewedPlan();
    const expected = expectPlan(state);
    expect(persistsReview(expected, { ...state, logging: { level: 'debug' } }, 'approve')).toBe(
      false,
    );
    expect(persistsReview(expected, { ...state, phase: 'IMPLEMENTATION' }, 'approve')).toBe(false);
  });

  it('rejects a certificate for a different plan, revision, obligation or host', () => {
    const expected = expectPlan();
    const approved = approvedPlan();
    const foreignPlan = structuredClone(approved);
    foreignPlan.plan.current.digest = 'plan-B';
    foreignPlan.plan.approvalCertificate.authorityDigest = 'plan-B';
    expect(persistsReview(expected, foreignPlan, 'approve')).toBe(false);
    const foreignReview = structuredClone(approved);
    foreignReview.plan.approvalCertificate.reviewBinding.reviewObligationId = 'ob-B';
    expect(persistsReview(expected, foreignReview, 'approve')).toBe(false);
    const foreignRevision = structuredClone(approved);
    foreignRevision.plan.current.recordDigest = 'record-B';
    expect(persistsReview(expected, foreignRevision, 'approve')).toBe(false);
    const foreignHost = structuredClone(approved);
    foreignHost.binding.hostSessionId = 'ses_other';
    expect(persistsReview(expected, foreignHost, 'approve')).toBe(false);
    expect(persistsReview(expected, approved, 'status')).toBe(false);
  });

  it('does not turn unsupported or missing subject evidence into a recovery', () => {
    const expected = expectRecovery({ phase: 'PLAN' }, ['flowguard_plan'], 'COMPLETE');
    expect(expected.kind).toBe('unproven');
    expect(recoveryPersisted(expected, approvedPlan(), 'approve')).toBe(false);
  });

  it('does not bind a denial naming Plan A to the successful persistence of Plan B', () => {
    const expected = expectRecovery(
      reviewedPlan(),
      ['flowguard_plan'],
      'COMPLETE',
      [{ bindings: { subjectDigest: 'plan-B' }, conflicts: [] }],
      0,
      [],
      validateReviewInvocation,
    );
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

describe('review recovery rejects invalid current authority', () => {
  type Ledger = ReturnType<typeof consumedReview>;
  const boundPlan = (reviewAssurance: Ledger) => ({ ...reviewedPlan(), reviewAssurance });

  it('rejects schema-valid historical generation 5', () => {
    const ledger = consumedReview('plan', 'plan-A');
    const { nativeProvenance: _nativeProvenance, ...current } = ledger.invocations[0]!;
    const historical = ReviewInvocationEvidence.parse({
      ...current,
      transportVersion: 5,
      invocationMode: 'native_task_message_json',
    });
    ledger.invocations[0] = { ...historical };
    expect(expectPlan(boundPlan(ledger)).kind).toBe('unproven');
  });

  it('does not prove acceptance without an installed contract or a bound parent', () => {
    const state = reviewedPlan();
    expect(expectRecovery(state, ['flowguard_plan'], 'COMPLETE').kind).toBe('unproven');
    expect(expectPlan({ ...state, binding: { hostSessionId: '' } }).kind).toBe('unproven');
    expect(() => reviewInvocationValidator(undefined, () => true)).toThrow(
      'installed product does not expose its V2 review contract',
    );
    expect(() => reviewInvocationValidator(ReviewInvocationEvidence, undefined)).toThrow(
      'installed product does not expose its V2 review contract',
    );
  });

  it.each(['missing', 'incomplete'])(
    'fails closed on a %s installed review contract',
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'fg-installed-review-'));
      try {
        if (scenario === 'incomplete') {
          const dist = join(root, '.opencode', 'node_modules', '@flowguard', 'core', 'dist');
          const integration = join(dist, 'integration', 'review', 'validation');
          const schemas = join(dist, 'state');
          await mkdir(integration, { recursive: true });
          await mkdir(schemas, { recursive: true });
          await writeFile(join(dist, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
          await writeFile(join(schemas, 'evidence-review-invocation.js'), 'export {};\n', {
            flag: 'wx',
          });
          await writeFile(join(integration, 'review-validation-acceptance.js'), 'export {};\n', {
            flag: 'wx',
          });
        }
        await expect(loadInstalledReviewInvocationValidator(root)).rejects.toMatchObject({
          code: 'DEMO_NOT_VERIFIED',
          message:
            scenario === 'missing'
              ? 'installed product V2 review contract is unreadable'
              : 'installed product does not expose its V2 review contract',
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  const defects: Array<[string, (ledger: Ledger) => void]> = [
    [
      'missing native provenance',
      (l) => {
        Reflect.deleteProperty(l.invocations[0]!, 'nativeProvenance');
      },
    ],
    [
      'mismatched native provenance',
      (l) => {
        const i = l.invocations[0]!;
        i.nativeProvenance = { ...i.nativeProvenance!, payloadDigest: 'e'.repeat(64) };
      },
    ],
    [
      'obsolete evidence flag',
      (l) => {
        Reflect.set(l.invocations[0]!, 'structuredOutputUsed', true);
      },
    ],
    [
      'other parent session',
      (l) => {
        l.invocations[0]!.parentSessionId = 'ses_other';
      },
    ],
    [
      'missing consumption timestamp',
      (l) => {
        l.obligations[0]!.consumedAt = null;
      },
    ],
    [
      'other consumer',
      (l) => {
        l.invocations[0]!.consumedByObligationId = foreignId;
      },
    ],
    [
      'wrong invocation',
      (l) => {
        l.obligations[0]!.invocationId = foreignId;
      },
    ],
    [
      'wrong obligation',
      (l) => {
        l.invocations[0]!.obligationId = foreignId;
      },
    ],
    [
      'wrong invocation type',
      (l) => {
        l.invocations[0]!.obligationType = 'review';
      },
    ],
    [
      'wrong capture attempt',
      (l) => {
        l.invocations[0]!.attemptId = foreignId;
        l.attempts[0]!.attemptId = foreignId;
      },
    ],
    [
      'wrong persisted attempt',
      (l) => {
        l.attempts[0]!.attemptId = foreignId;
      },
    ],
    [
      'attempt under another obligation',
      (l) => {
        l.attempts[0]!.obligationId = foreignId;
      },
    ],
    [
      'attempt for another review type',
      (l) => {
        l.attempts[0]!.obligationType = 'architecture';
      },
    ],
    [
      'unbound attempt',
      (l) => {
        l.attempts[0]!.status = 'created';
      },
    ],
    [
      'attempt for another child',
      (l) => {
        l.attempts[0]!.childSessionId = 'ses_other';
      },
    ],
    [
      'wrong verdict',
      (l) => {
        l.invocations[0]!.capturedVerdict = 'changes_requested';
      },
    ],
    [
      'contradictory captured verdict',
      (l) => {
        const i = l.invocations[0]!;
        i.capturedRawFindings = { ...i.capturedRawFindings, overallVerdict: 'changes_requested' };
      },
    ],
    [
      'changed captured findings',
      (l) => {
        const i = l.invocations[0]!;
        i.capturedRawFindings = { ...i.capturedRawFindings, planVersion: 20 };
      },
    ],
    [
      'wrong review mandate',
      (l) => {
        l.obligations[0]!.mandateDigest = 'other-mandate';
      },
    ],
    [
      'different obligation subject',
      (l) => {
        l.obligations[0]!.subjectDigest = 'other-subject';
      },
    ],
    [
      'different attempt subject',
      (l) => {
        l.attempts[0]!.subjectDigest = 'other-subject';
      },
    ],
  ];
  it.each(defects)('rejects %s', (_name, change) => {
    const ledger = consumedReview('plan', 'plan-A');
    change(ledger);
    expect(expectPlan(boundPlan(ledger)).kind).toBe('unproven');
  });

  it('revalidates a consumed V2 architecture review after certificate issuance', () => {
    const digest = 'adr-A';
    const state = {
      ...reviewedPlan(),
      phase: 'ARCH_REVIEW',
      architecture: { digest, reviewCompletion: 'reviewer_accepted' },
      reviewAssurance: consumedReview('architecture', digest),
    };
    const expected = expectRecovery(
      state,
      ['flowguard_architecture'],
      'ARCH_COMPLETE',
      [],
      0,
      [],
      validateReviewInvocation,
    );
    const after = {
      ...state,
      phase: 'ARCH_COMPLETE',
      architecture: {
        ...state.architecture,
        approvalCertificate: {
          certificateId: 'cert-arch',
          authorityDigest: digest,
          reviewBinding: {
            kind: 'current_review',
            reviewedSubjectDigest: digest,
            reviewObligationId: state.reviewAssurance.obligations[0]!.obligationId,
          },
        },
      },
    };
    expect(expected.kind).toBe('subject_approval');
    expect(persistsReview(expected, after, 'approve')).toBe(true);
    after.reviewAssurance.invocations[0]!.parentSessionId = 'ses_other';
    expect(persistsReview(expected, after, 'approve')).toBe(false);
  });
});

const ticketCodes = ['TICKET_SOURCE_CONFLICT', 'TICKET_SOURCE_ORIGIN_CONFLICT'];
describe.each(ticketCodes)('ticket-adoption recovery (%s)', (code) => {
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
      detail: { tool: 'flowguard_ticket', success: false, errorCode: code },
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

  function expectedTicket(
    state: object = adoptedTicket,
    identities: Array<{ bindings: Record<string, string>; conflicts: string[] }> = [],
    floor = 0,
  ) {
    return expectRecovery(state, ['flowguard_ticket'], 'COMPLETE', identities, floor, [code]);
  }

  it('accepts the same-turn adoption of the exact persisted ticket with its audit sequence', () => {
    const expected = expectedTicket();
    expect(expected.kind).toBe('ticket_adoption');
    expect((expected as { digest?: string }).digest).toBe(ticketDigest);
    expect(recoveryPersisted(expected, adoptedTicket, 'task', adoptionAudit)).toBe(true);
  });

  it('rejects content that does not hash to the expected ticket digest', () => {
    const expected = expectedTicket();
    const tampered = structuredClone(adoptedTicket);
    tampered.ticket.text = `${ticketText} (tampered)`;
    expect(recoveryPersisted(expected, tampered, 'task', adoptionAudit)).toBe(false);
    // The digest is only trusted when it is the SHA-256 of the stored content.
    const wrongDigest = expectedTicket({
      ...adoptedTicket,
      ticket: { ...adoptedTicket.ticket, digest: 'ticket-A' },
    });
    expect(wrongDigest.kind).toBe('unproven');
  });

  it('rejects a historical audit sequence from another session or before the turn floor', () => {
    const expected = expectedTicket();
    const foreignSession = adoptionAudit.map((event) => ({
      ...event,
      flowguardSessionId: 'fg-other',
    }));
    expect(recoveryPersisted(expected, adoptedTicket, 'task', foreignSession)).toBe(false);
    // Events 1..3 are already persisted before this recovery turn (floor 3).
    const floored = expectedTicket(adoptedTicket, [], 3);
    expect(recoveryPersisted(floored, adoptedTicket, 'task', adoptionAudit)).toBe(false);
    // The denial itself must also lie inside the current turn: a success and
    // transition without their in-turn denial never confirm the recovery.
    const flooredAfterDenial = expectedTicket(adoptedTicket, [], 1);
    expect(recoveryPersisted(flooredAfterDenial, adoptedTicket, 'task', adoptionAudit)).toBe(false);
  });

  it('does not turn a missing or empty persisted ticket into a recovery', () => {
    const missing = expectedTicket({ ...actor, phase: 'TICKET' });
    expect(missing.kind).toBe('unproven');
    expect(recoveryPersisted(missing, adoptedTicket, 'task', adoptionAudit)).toBe(false);
    const empty = expectedTicket({ ...adoptedTicket, ticket: { digest: '', text: '' } });
    expect(empty.kind).toBe('unproven');
  });

  it('rejects a different, cleared or phase-foreign ticket identity', () => {
    const expected = expectedTicket();
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
    const expected = expectedTicket();
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
    const successBeforeDenial = [success, denial, adoptionAudit[2]];
    expect(recoveryPersisted(expected, adoptedTicket, 'task', successBeforeDenial)).toBe(false);
  });

  it('rejects a ticket adopted before the conflict denial and a foreign actor or command', () => {
    const adoptionBeforeDenial = [adoptionAudit[2], adoptionAudit[0], adoptionAudit[1]];
    const expected = expectedTicket();
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
        detail: { tool: 'flowguard_ticket', success: false, errorCode: code },
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
    const expected = expectedTicket(state);
    expect(expected.kind).toBe('ticket_adoption');
    expect(recoveryPersisted(expected, state, 'task', audit)).toBe(true);
    // The persisted ticket alone, without the operational sequence, stays unproven.
    expect(recoveryPersisted(expected, state, 'task', [audit[1]])).toBe(false);
  });

  it('keeps a conflicting denial identity unproven', () => {
    const expected = expectedTicket(adoptedTicket, [
      { bindings: {}, conflicts: ['subjectDigest'] },
    ]);
    expect(expected.kind).toBe('unproven');
    expect(recoveryPersisted(expected, adoptedTicket, 'task', adoptionAudit)).toBe(false);
  });

  it('does not substitute a different denial code for the observed conflict', () => {
    const audit = structuredClone(adoptionAudit);
    audit[0]!.detail.errorCode =
      code === 'TICKET_SOURCE_CONFLICT'
        ? 'TICKET_SOURCE_ORIGIN_CONFLICT'
        : 'TICKET_SOURCE_CONFLICT';
    expect(recoveryPersisted(expectedTicket(), adoptedTicket, 'task', audit)).toBe(false);
    expect(
      recoveryPersisted(
        { ...expectedTicket(), denialCodes: [] },
        adoptedTicket,
        'task',
        adoptionAudit,
      ),
    ).toBe(false);
    expect(
      recoveryPersisted(
        { ...expectedTicket(), auditSequenceFloor: -1 },
        adoptedTicket,
        'task',
        adoptionAudit,
      ),
    ).toBe(false);
  });

  it('requires every observed conflict code, not merely one member of the family', () => {
    const other =
      code === 'TICKET_SOURCE_CONFLICT'
        ? 'TICKET_SOURCE_ORIGIN_CONFLICT'
        : 'TICKET_SOURCE_CONFLICT';
    const expected = expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE', [], 0, [
      code,
      other,
    ]);
    expect(recoveryPersisted(expected, adoptedTicket, 'task', adoptionAudit)).toBe(false);
    const audit = [
      adoptionAudit[0],
      {
        ...adoptionAudit[0]!,
        auditSequence: 2,
        detail: { ...adoptionAudit[0]!.detail, errorCode: other },
      },
      { ...adoptionAudit[1]!, auditSequence: 3 },
      { ...adoptionAudit[2]!, auditSequence: 4 },
    ];
    expect(recoveryPersisted(expected, adoptedTicket, 'task', audit)).toBe(true);
    const unsupported = { ...expected, denialCodes: [code, 'OTHER'] };
    audit[1]!.detail.errorCode = 'OTHER';
    expect(recoveryPersisted(unsupported, adoptedTicket, 'task', audit)).toBe(false);
    expect(
      expectRecovery(adoptedTicket, ['flowguard_ticket'], 'COMPLETE', [], 0, [code, 'OTHER']).kind,
    ).toBe('unproven');
  });

  it.each([
    'denial-tool',
    'denial-event',
    'denial-success',
    'success-tool',
    'success-event',
    'success-failed',
    'no-transition-count',
    'string-transition-count',
    'wrong-transition',
    'wrong-from',
    'wrong-to',
    'wrong-detail-event',
  ])('requires the complete adoption operation (%s)', (kind) => {
    const audit = structuredClone(adoptionAudit);
    if (kind === 'denial-tool') audit[0]!.detail.tool = 'flowguard_plan';
    if (kind === 'denial-event') audit[0]!.event = 'error:ticket';
    if (kind === 'denial-success') audit[0]!.detail.success = true;
    if (kind === 'success-tool') audit[1]!.detail.tool = 'flowguard_plan';
    if (kind === 'success-event') audit[1]!.event = 'tool_call:flowguard_plan';
    if (kind === 'success-failed') audit[1]!.detail.success = false;
    if (kind === 'no-transition-count') audit[1]!.detail.transitionCount = 0;
    if (kind === 'string-transition-count')
      Object.assign(audit[1]!.detail, { transitionCount: '1' });
    if (kind === 'wrong-transition') audit[2]!.event = 'transition:PLAN_READY';
    if (kind === 'wrong-from') audit[2]!.detail.from = 'PLAN';
    if (kind === 'wrong-to') audit[2]!.detail.to = 'PLAN';
    if (kind === 'wrong-detail-event') audit[2]!.detail.event = 'PLAN_READY';
    expect(recoveryPersisted(expectedTicket(), adoptedTicket, 'task', audit)).toBe(false);
  });
});
