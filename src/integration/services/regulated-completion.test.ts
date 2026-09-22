import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeRegulatedCompletion, resumeRegulatedCompletion } from './regulated-completion.js';
import type { SessionState } from '../../state/schema.js';
import type { ChainedAuditEvent } from '../../audit/types.js';
import { computeCanonicalEventDigest } from '../../audit/canonical-digest.js';
import {
  makeState,
  REGULATED_POLICY_SNAPSHOT,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  REVIEW_APPROVE,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
} from '../../fixtures.js';
import type { AuditDeps } from '../plugin-audit.js';

vi.mock('../../adapters/persistence.js', () => ({
  readState: vi.fn(),
  PersistenceError: class PersistenceError extends Error {
    constructor(
      public readonly code: string,
      message?: string,
    ) {
      super(message ?? code);
    }
  },
}));
vi.mock('../../adapters/persistence-lock.js', () => ({
  acquireNamedWriteLock: vi.fn(async () => ({
    release: vi.fn(async () => undefined),
    waited: false,
  })),
}));
vi.mock('../../adapters/persistence-audit.js', () => ({
  readAuditTrail: vi.fn().mockResolvedValue([]),
  appendAuditEvent: vi.fn(),
  withAuditTrailLock: vi.fn(async (_dir: string, fn: () => Promise<unknown>) => fn()),
  appendAuditEventAlreadyLocked: vi.fn(),
}));
vi.mock('../../adapters/workspace/archive.js', () => ({ archiveRegulatedEvidence: vi.fn() }));
vi.mock('../../adapters/workspace/archive-verify-chain.js', () => ({
  verifyRegulatedArchive: vi.fn(),
}));
vi.mock('../plugin-audit.js', () => ({ reconcilePendingAuditOperations: vi.fn() }));
vi.mock('../tools/helpers.js', () => ({
  writeStateWithArtifactsAndAuditOperations: vi.fn(async (_dir: string, state: unknown) => state),
  withSessionWriteTransaction: vi.fn(
    async (_dir: string, fn: (tx: { waited: boolean }) => Promise<void>) => fn({ waited: false }),
  ),
}));

import { PersistenceError, readState } from '../../adapters/persistence.js';
import { acquireNamedWriteLock } from '../../adapters/persistence-lock.js';
import {
  appendAuditEventAlreadyLocked,
  readAuditTrail,
  withAuditTrailLock,
} from '../../adapters/persistence-audit.js';
import { archiveRegulatedEvidence } from '../../adapters/workspace/archive.js';
import { verifyRegulatedArchive } from '../../adapters/workspace/archive-verify-chain.js';
import { reconcilePendingAuditOperations } from '../plugin-audit.js';
import { writeStateWithArtifactsAndAuditOperations } from '../tools/helpers.js';
import { verifyRegulatedCompletionCompleteness } from '../../adapters/workspace/archive-verify-regulated.js';
import type { ArchiveFinding } from '../../archive/types.js';
import type { SemanticAuditIntent } from '../audit-outbox.js';

const AT = '2026-01-01T00:00:00.000Z';
const TERMINAL_DECISION_OPERATION_ID = '00000000-0000-4000-8000-000000000300';

/** Durable approval transition outbox record: the terminal state retains only the export transition. */
function approvalTransitionOperation() {
  return {
    kind: 'transition' as const,
    operationId: '00000000-0000-4000-8000-000000000010',
    preStateDigest: 'a'.repeat(64),
    mutationDigest: 'b'.repeat(64),
    postStateDigest: 'c'.repeat(64),
    auditEventDigest: 'd'.repeat(64),
    transition: {
      from: 'EVIDENCE_REVIEW' as const,
      to: 'EXPORT_READY' as const,
      event: 'APPROVE' as const,
      at: AT,
      chainIndex: 0,
      autoAdvanced: false,
    },
    status: 'reconciled' as const,
  };
}

/** Export transition outbox record in the requested durability status. */
function exportTransitionOperation(
  status: 'state_committed' | 'audit_committed' | 'reconciled' = 'state_committed',
) {
  return {
    kind: 'transition' as const,
    operationId: '00000000-0000-4000-8000-000000000011',
    preStateDigest: 'a'.repeat(64),
    mutationDigest: 'b'.repeat(64),
    postStateDigest: 'c'.repeat(64),
    auditEventDigest: 'd'.repeat(64),
    transition: {
      from: 'EXPORT_READY' as const,
      to: 'COMPLETE' as const,
      event: 'EXPORT_MATERIALIZED' as const,
      at: AT,
      chainIndex: 1,
      autoAdvanced: false,
    },
    status,
  };
}

/** The approval transition as already-durable audit evidence. */
function approvalTransitionEvent(): ChainedAuditEvent {
  return {
    detail: {
      kind: 'transition',
      from: 'EVIDENCE_REVIEW',
      to: 'EXPORT_READY',
      event: 'APPROVE',
    },
    event: 'transition:APPROVE',
    occurredAt: AT,
  } as unknown as ChainedAuditEvent;
}

/** The export transition as already-durable audit evidence. */
function exportTransitionEvent(): ChainedAuditEvent {
  return {
    detail: {
      kind: 'transition',
      from: 'EXPORT_READY',
      to: 'COMPLETE',
      event: 'EXPORT_MATERIALIZED',
    },
    event: 'transition:EXPORT_MATERIALIZED',
    occurredAt: AT,
  } as unknown as ChainedAuditEvent;
}

function reviewState(phase: 'EVIDENCE_REVIEW' | 'COMPLETE') {
  return makeState(phase, {
    ticket: TICKET,
    plan: PLAN_RECORD,
    selfReview: SELF_REVIEW_CONVERGED,
    reviewDecision: REVIEW_APPROVE,
    validation: VALIDATION_PASSED,
    implementation: IMPL_EVIDENCE,
    implReview: IMPL_REVIEW_CONVERGED,
    policySnapshot: REGULATED_POLICY_SNAPSHOT,
    ...(phase === 'COMPLETE'
      ? {
          transition: {
            from: 'EXPORT_READY' as const,
            to: 'COMPLETE' as const,
            event: 'EXPORT_MATERIALIZED' as const,
            at: AT,
          },
          pendingAuditOperations: [approvalTransitionOperation()],
        }
      : {}),
  });
}

/** The real entry path: the rail persisted COMPLETE before the regulated chain ran. */
function reviewEntryPath(): { persisted: SessionState; complete: SessionState } {
  return { persisted: reviewState('EVIDENCE_REVIEW'), complete: reviewState('COMPLETE') };
}

/** The reconciled terminal decision outbox operation a durable receipt belongs to. */
function terminalDecisionOperation() {
  return {
    kind: 'semantic' as const,
    operationId: TERMINAL_DECISION_OPERATION_ID,
    preStateDigest: 'a'.repeat(64),
    mutationDigest: 'b'.repeat(64),
    postStateDigest: 'c'.repeat(64),
    auditEventDigest: 'd'.repeat(64),
    semantic: {
      phase: 'EVIDENCE_REVIEW' as const,
      event: 'decision:DEC-001',
      occurredAt: AT,
      detail: decisionEvent().detail,
    },
    status: 'reconciled' as const,
  };
}

function decisionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TERMINAL_DECISION_OPERATION_ID,
    detail: {
      kind: 'decision',
      decisionId: 'DEC-001',
      decisionSequence: 1,
      gatePhase: 'EVIDENCE_REVIEW',
      verdict: 'approve',
      rationale: 'LGTM',
      decisionIdentity: REVIEW_APPROVE.decisionIdentity,
      decidedAt: AT,
      fromPhase: 'EVIDENCE_REVIEW',
      toPhase: 'EXPORT_READY',
      transitionEvent: 'APPROVE',
      policyMode: 'regulated',
      ...overrides,
    },
  };
}

function planDecisionEvent(): Record<string, unknown> {
  return decisionEvent({
    decisionId: 'DEC-000',
    gatePhase: 'PLAN_REVIEW',
    fromPhase: 'PLAN_REVIEW',
    toPhase: 'VALIDATION',
    decidedAt: '2025-12-31T00:00:00.000Z',
  });
}

function sessionCreatedEvent(): Record<string, unknown> {
  return {
    event: 'lifecycle:session_created',
    detail: { kind: 'lifecycle', action: 'session_created' },
  };
}

function sessionCompletedEvent(): Record<string, unknown> {
  return {
    event: 'lifecycle:session_completed',
    detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'COMPLETE' },
  };
}

function completionDeps(): AuditDeps {
  return {
    resolveFingerprint: async () => 'fp',
    getSessionDir: (candidate: string) => (candidate === 'sid' ? '/sess' : null),
    resolveSessionPolicy: vi.fn(),
    initChain: vi.fn(async () => 'genesis'),
    invalidateChainState: vi.fn(),
    appendAndTrack: vi.fn(async (event) => {
      event.chainHash = 'c'.repeat(64);
    }),
    nextDecisionSequence: vi.fn(async () => 1),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    logError: vi.fn(),
    cachedFingerprint: 'fp',
    mode: 'regulated',
  };
}

/** Simulate persisted state advancing with every write, as the real adapter does. */
function trackPersistedState(initial: SessionState) {
  let latest: SessionState | null = initial;
  vi.mocked(writeStateWithArtifactsAndAuditOperations).mockImplementation(
    async (_dir: string, state: unknown) => {
      latest = state as SessionState;
      return state as SessionState;
    },
  );
  vi.mocked(readState).mockImplementation(async () => latest);
  return {
    get: (): SessionState => {
      if (latest === null) throw new Error('tracked state is absent');
      return latest;
    },
    set: (next: SessionState): void => {
      latest = next;
    },
  };
}

function appendedDecisionEvents(): unknown[] {
  return vi
    .mocked(appendAuditEventAlreadyLocked)
    .mock.calls.filter((call) => JSON.stringify(call[1]).includes('decision:DEC-'));
}

function lifecycleWrites(): unknown[] {
  return vi
    .mocked(writeStateWithArtifactsAndAuditOperations)
    .mock.calls.filter((call) =>
      JSON.stringify(call[3] ?? []).includes('lifecycle:session_completed'),
    );
}

afterEach(() => vi.clearAllMocks());

describe('executeRegulatedCompletion', () => {
  it('fails closed instead of fabricating a late receipt when the export transition is durable', async () => {
    // Earlier PLAN_REVIEW decisions and session_created lifecycles are never
    // terminal authority, and the export transition is already in the audit
    // trail: the terminal decision receipt can no longer be ordered before it.
    const { persisted, complete } = reviewEntryPath();
    trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue([
      approvalTransitionEvent(),
      exportTransitionEvent(),
      planDecisionEvent(),
      sessionCreatedEvent(),
    ] as never);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      complete,
      completionDeps(),
    );

    expect(result.regulatedArchiveStatus).toBe('failed');
    expect(appendedDecisionEvents()).toHaveLength(0);
    expect(lifecycleWrites()).toHaveLength(0);
    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'the export operation is already reconciled',
      status: 'reconciled' as const,
    },
    {
      label: 'the export append succeeded but its acknowledgement was lost',
      status: 'state_committed' as const,
    },
  ])('refuses a late receipt when $label and the export event is durable', async ({ status }) => {
    const persisted: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [approvalTransitionOperation(), exportTransitionOperation(status)],
    };
    trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue([
      approvalTransitionEvent(),
      exportTransitionEvent(),
      sessionCreatedEvent(),
    ] as never);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      persisted,
      completionDeps(),
    );

    expect(result.regulatedArchiveStatus).toBe('failed');
    expect(appendedDecisionEvents()).toHaveLength(0);
    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
  });

  it('fails closed and persists failure when reconciliation fails', async () => {
    const { persisted, complete } = reviewEntryPath();
    trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue([]);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue({
      auditOk: false,
      block: true,
      code: 'AUDIT_PERSISTENCE_FAILED',
      reason: 'disk failure',
    });

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      complete,
      completionDeps(),
    );

    expect(result.regulatedArchiveStatus).toBe('failed');
    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
    expect(writeStateWithArtifactsAndAuditOperations).toHaveBeenLastCalledWith(
      '/sess',
      expect.objectContaining({ regulatedArchiveStatus: 'failed' }),
    );
  });

  it('resumes without emitting a second terminal decision or lifecycle', async () => {
    const persisted: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [approvalTransitionOperation(), terminalDecisionOperation()],
    };
    trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue([
      decisionEvent(),
      sessionCompletedEvent(),
    ] as never);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      persisted,
      completionDeps(),
    );

    expect(result.regulatedArchiveStatus).toBe('verified');
    expect(appendedDecisionEvents()).toHaveLength(0);
    expect(lifecycleWrites()).toHaveLength(0);
    expect(archiveRegulatedEvidence).toHaveBeenCalledOnce();
  });

  it('does not treat a PLAN_REVIEW decision as terminal checkpoint evidence', async () => {
    const persisted = reviewState('COMPLETE');
    trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue([
      approvalTransitionEvent(),
      exportTransitionEvent(),
      planDecisionEvent(),
      sessionCreatedEvent(),
    ] as never);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      persisted,
      completionDeps(),
    );

    expect(result.regulatedArchiveStatus).toBe('failed');
    expect(appendedDecisionEvents()).toHaveLength(0);
    expect(lifecycleWrites()).toHaveLength(0);
  });

  it('orders a recovered terminal decision before a pending export transition and passes the real order check', async () => {
    const persisted: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [approvalTransitionOperation(), exportTransitionOperation()],
    };
    // The approval transition is already durable; only the export transition
    // is still pending when recovery starts. The drain is simulated in
    // outbox-array order so the emitted trail reflects the real sequence.
    const trail: ChainedAuditEvent[] = [approvalTransitionEvent()];
    let latest: SessionState = persisted;
    vi.mocked(readState).mockImplementation(async () => latest);
    vi.mocked(writeStateWithArtifactsAndAuditOperations).mockImplementation(
      async (_dir: string, state: unknown, _transitions: unknown, intents: unknown) => {
        const base = state as SessionState;
        const appended: SessionState['pendingAuditOperations'] = (
          (intents as readonly SemanticAuditIntent[] | undefined) ?? []
        ).map((semantic, index) => ({
          kind: 'semantic' as const,
          operationId: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
          preStateDigest: 'a'.repeat(64),
          mutationDigest: 'b'.repeat(64),
          postStateDigest: 'c'.repeat(64),
          auditEventDigest: 'd'.repeat(64),
          status: 'state_committed' as const,
          semantic,
        }));
        latest = {
          ...base,
          pendingAuditOperations: [...base.pendingAuditOperations, ...appended],
        };
        return latest;
      },
    );
    vi.mocked(reconcilePendingAuditOperations).mockImplementation(async () => {
      for (const operation of [...latest.pendingAuditOperations]) {
        if (operation.status === 'reconciled') continue;
        if (operation.kind === 'transition') {
          trail.push({
            detail: {
              kind: 'transition',
              from: operation.transition.from,
              to: operation.transition.to,
              event: operation.transition.event,
            },
            event: `transition:${operation.transition.event}`,
            occurredAt: operation.transition.at,
          } as unknown as ChainedAuditEvent);
        } else if (operation.kind === 'semantic') {
          trail.push({
            detail: operation.semantic.detail,
            event: operation.semantic.event,
            occurredAt: operation.semantic.occurredAt,
            actor: operation.semantic.actor,
          } as unknown as ChainedAuditEvent);
        }
        latest = {
          ...latest,
          pendingAuditOperations: latest.pendingAuditOperations.map((item) =>
            item.operationId === operation.operationId
              ? { ...item, status: 'reconciled' as const }
              : item,
          ),
        };
      }
      return undefined;
    });
    // The recovery decision append must happen under the audit lock, so no
    // competing export append can interleave between the trail check and the
    // durable decision event.
    let auditLockHeld = false;
    const appendLockStates: boolean[] = [];
    vi.mocked(withAuditTrailLock).mockImplementation(async (_dir, fn) => {
      auditLockHeld = true;
      try {
        return await fn();
      } finally {
        auditLockHeld = false;
      }
    });
    vi.mocked(appendAuditEventAlreadyLocked).mockImplementation(async (_dir, event) => {
      appendLockStates.push(auditLockHeld);
      trail.push(event as unknown as ChainedAuditEvent);
      return event as never;
    });
    vi.mocked(readAuditTrail).mockImplementation(async () => [...trail]);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      persisted,
      completionDeps(),
    );

    expect(result.regulatedArchiveStatus).toBe('verified');
    expect(appendLockStates).toEqual([true]);
    const decisionIndex = trail.findIndex((event) => event.detail.kind === 'decision');
    const exportIndex = trail.findIndex(
      (event) => event.detail.kind === 'transition' && event.detail.to === 'COMPLETE',
    );
    expect(decisionIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeGreaterThan(-1);
    expect(decisionIndex).toBeLessThan(exportIndex);

    const findings: ArchiveFinding[] = [];
    verifyRegulatedCompletionCompleteness(latest, trail, findings);
    expect(findings).toEqual([]);
  });

  it('repairs the outbox correlation when a crash separates the durable append from the state commit', async () => {
    // Fault injection: the receipt append succeeds durably, then the process
    // dies before the state commit that persists its operation.
    const persisted: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [approvalTransitionOperation(), exportTransitionOperation()],
    };
    const trail: ChainedAuditEvent[] = [approvalTransitionEvent()];
    const tracked = trackPersistedState(persisted);
    let crashArmed = true;
    vi.mocked(readAuditTrail).mockImplementation(async () => [...trail]);
    vi.mocked(appendAuditEventAlreadyLocked).mockImplementation(async (_dir, event) => {
      const body = event as unknown as Record<string, unknown>;
      const persistedEvent = {
        ...body,
        prevHash: 'genesis',
        semanticEventDigest: computeCanonicalEventDigest(body),
      } as unknown as ChainedAuditEvent;
      trail.push(persistedEvent);
      return persistedEvent;
    });
    const isDecisionOperation = (operation: SessionState['pendingAuditOperations'][number]) =>
      operation.kind === 'semantic' && operation.semantic.event.startsWith('decision:');
    vi.mocked(writeStateWithArtifactsAndAuditOperations).mockImplementation(async (_dir, state) => {
      const next = state;
      if (crashArmed && next.pendingAuditOperations.some(isDecisionOperation)) {
        crashArmed = false;
        throw new Error('simulated crash before the state commit');
      }
      tracked.set(next);
      return next;
    });
    vi.mocked(reconcilePendingAuditOperations).mockImplementation(async () => {
      tracked.set({
        ...tracked.get(),
        pendingAuditOperations: tracked.get().pendingAuditOperations.map((operation) => ({
          ...operation,
          status: 'reconciled' as const,
        })),
      });
    });
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const crashed = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      persisted,
      completionDeps(),
    );

    expect(crashed.regulatedArchiveStatus).toBe('failed');
    const durableReceipts = trail.filter((event) => event.detail.kind === 'decision');
    expect(durableReceipts).toHaveLength(1);
    const receiptId = durableReceipts[0]?.id;
    expect(receiptId).toBeDefined();
    if (receiptId === undefined) throw new Error('expected a durable terminal decision receipt');
    // The crash left the receipt durable without its outbox correlation.
    expect(
      tracked.get().pendingAuditOperations.some((operation) => operation.operationId === receiptId),
    ).toBe(false);

    // Restart: recovery rebuilds the correlation from the verified event
    // without duplicating the receipt.
    const verified = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      tracked.get(),
      completionDeps(),
    );

    expect(verified.regulatedArchiveStatus).toBe('verified');
    expect(trail.filter((event) => event.detail.kind === 'decision')).toHaveLength(1);
    const repaired = tracked
      .get()
      .pendingAuditOperations.find((operation) => operation.operationId === receiptId);
    expect(repaired?.status).toBe('reconciled');
    const operationIds = tracked
      .get()
      .pendingAuditOperations.map((operation) => operation.operationId);
    expect(operationIds.indexOf(receiptId)).toBeLessThan(
      operationIds.indexOf('00000000-0000-4000-8000-000000000011'),
    );
  });

  it('fails closed when multiple durable terminal decision receipts exist', async () => {
    const persisted: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [approvalTransitionOperation(), exportTransitionOperation()],
    };
    const tracked = trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue([
      approvalTransitionEvent(),
      { ...decisionEvent(), id: '00000000-0000-4000-8000-000000000301' },
      decisionEvent(),
    ] as never);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      persisted,
      completionDeps(),
    );

    expect(result.regulatedArchiveStatus).toBe('failed');
    expect(
      tracked
        .get()
        .pendingAuditOperations.some(
          (operation) => operation.operationId === TERMINAL_DECISION_OPERATION_ID,
        ),
    ).toBe(false);
  });

  it('fails closed when a durable receipt cannot be verified against its correlation', async () => {
    // A receipt event whose rebuilt body does not reproduce its persisted
    // digest must never be turned into provenance evidence.
    const persisted: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [approvalTransitionOperation(), exportTransitionOperation()],
    };
    const tracked = trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue([
      approvalTransitionEvent(),
      { ...decisionEvent(), phase: 'EVIDENCE_REVIEW', actor: 'human' },
    ] as never);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      persisted,
      completionDeps(),
    );

    expect(result.regulatedArchiveStatus).toBe('failed');
    expect(
      tracked
        .get()
        .pendingAuditOperations.some(
          (operation) => operation.operationId === TERMINAL_DECISION_OPERATION_ID,
        ),
    ).toBe(false);
  });

  it('drains a durable terminal-decision outbox checkpoint before deciding a new intent is needed', async () => {
    // Crash window: COMPLETE + terminal decision op persisted in the outbox,
    // but the audit trail does not yet contain the reconciled event.
    const persisted: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [
        approvalTransitionOperation(),
        {
          kind: 'semantic',
          operationId: 'op-terminal-decision',
          preStateDigest: 'a'.repeat(64),
          mutationDigest: 'b'.repeat(64),
          postStateDigest: 'c'.repeat(64),
          auditEventDigest: 'd'.repeat(64),
          semantic: {
            phase: 'EVIDENCE_REVIEW',
            event: 'decision:DEC-001',
            occurredAt: AT,
            detail: decisionEvent().detail as Record<string, unknown>,
          },
          status: 'state_committed',
        },
      ],
    };
    const trail: ChainedAuditEvent[] = [];
    vi.mocked(readAuditTrail).mockImplementation(async () => [...trail]);
    vi.mocked(reconcilePendingAuditOperations).mockImplementation(async () => {
      trail.push(decisionEvent() as unknown as ChainedAuditEvent);
      // Reconciliation is monotonic: operations stay as durable correlation
      // evidence (they are never deleted from the outbox).
      persisted.pendingAuditOperations = persisted.pendingAuditOperations.map((operation) => ({
        ...operation,
        status: 'reconciled' as const,
      }));
    });
    trackPersistedState(persisted);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      persisted,
      completionDeps(),
    );

    expect(result.regulatedArchiveStatus).toBe('verified');
    expect(appendedDecisionEvents()).toHaveLength(0);
    expect(lifecycleWrites()).toHaveLength(1);
    expect(reconcilePendingAuditOperations).toHaveBeenCalled();
  });

  it('resumes only for incomplete regulated COMPLETE checkpoints', async () => {
    vi.mocked(readState).mockResolvedValue({
      ...reviewState('COMPLETE'),
      regulatedArchiveStatus: 'pending',
    });

    await expect(
      resumeRegulatedCompletion('/sess', 'fp', 'sid', completionDeps()),
    ).resolves.not.toBeNull();

    vi.mocked(readState).mockResolvedValue({
      ...reviewState('COMPLETE'),
      regulatedArchiveStatus: 'verified',
    });
    await expect(
      resumeRegulatedCompletion('/sess', 'fp', 'sid', completionDeps()),
    ).resolves.toBeNull();
  });

  it.each(['ARCH_COMPLETE', 'PEER_REVIEW_COMPLETE'] as const)(
    'never touches a regulated %s session',
    async (phase) => {
      const foreign = makeState(phase, {
        policySnapshot: REGULATED_POLICY_SNAPSHOT,
        reviewDecision: REVIEW_APPROVE,
        transition: { from: 'ARCH_REVIEW', to: phase, event: 'APPROVE', at: AT },
      });
      vi.mocked(readState).mockResolvedValue(foreign);
      vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
      vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
      vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

      const result = await executeRegulatedCompletion(
        '/sess',
        'fp',
        'sid',
        foreign,
        completionDeps(),
      );

      expect(result).toBe(foreign);
      expect(writeStateWithArtifactsAndAuditOperations).not.toHaveBeenCalled();
      expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
      expect(reconcilePendingAuditOperations).not.toHaveBeenCalled();
    },
  );

  it('never persists a stale failure when completion-lock contention occurs', async () => {
    const tracked = trackPersistedState(reviewState('EVIDENCE_REVIEW'));
    const complete: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [approvalTransitionOperation(), exportTransitionOperation()],
    };
    vi.mocked(readAuditTrail).mockResolvedValue([]);
    // The drain reconciles every committed operation, as the real outbox does,
    // so the chain reaches the archive lock that is contended here.
    vi.mocked(reconcilePendingAuditOperations).mockImplementation(async () => {
      tracked.set({
        ...tracked.get(),
        pendingAuditOperations: tracked.get().pendingAuditOperations.map((operation) => ({
          ...operation,
          status: 'reconciled' as const,
        })),
      });
    });
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);
    vi.mocked(acquireNamedWriteLock).mockRejectedValueOnce(
      new PersistenceError(
        'LOCK_TIMEOUT',
        'Could not acquire regulated completion lock within 60000ms.',
      ),
    );

    await expect(
      executeRegulatedCompletion('/sess', 'fp', 'sid', complete, completionDeps()),
    ).rejects.toMatchObject({ code: 'REGULATED_COMPLETION_LOCK_CONTENTION' });

    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
    expect(verifyRegulatedArchive).not.toHaveBeenCalled();
    const failedWrites = vi
      .mocked(writeStateWithArtifactsAndAuditOperations)
      .mock.calls.filter(
        (call) =>
          (call[1] as { regulatedArchiveStatus?: string }).regulatedArchiveStatus === 'failed',
      );
    expect(failedWrites).toHaveLength(0);
  });

  it('returns the verified state when contention resolves against an already verified session', async () => {
    const verified: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [approvalTransitionOperation(), terminalDecisionOperation()],
      regulatedArchiveStatus: 'verified' as const,
    };
    trackPersistedState(verified);
    vi.mocked(readAuditTrail).mockResolvedValue([
      decisionEvent(),
      sessionCompletedEvent(),
    ] as never);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(acquireNamedWriteLock).mockRejectedValue(
      new PersistenceError('LOCK_TIMEOUT', 'completion lock contention'),
    );

    const result = await executeRegulatedCompletion(
      '/sess',
      'fp',
      'sid',
      verified,
      completionDeps(),
    );

    expect(result).toBe(verified);
    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
    expect(verifyRegulatedArchive).not.toHaveBeenCalled();
  });
});
