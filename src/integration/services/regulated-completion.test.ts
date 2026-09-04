import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeRegulatedCompletion, resumeRegulatedCompletion } from './regulated-completion.js';
import type { SessionState } from '../../state/schema.js';
import type { ChainedAuditEvent } from '../../audit/types.js';
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
  PersistenceError: class PersistenceError extends Error {},
}));
vi.mock('../../adapters/persistence-audit.js', () => ({
  readAuditTrail: vi.fn().mockResolvedValue({ events: [], skipped: 0 }),
  appendAuditEvent: vi.fn(),
}));
vi.mock('../../adapters/workspace/archive.js', () => ({ archiveRegulatedEvidence: vi.fn() }));
vi.mock('../../adapters/workspace/archive-verify-chain.js', () => ({
  verifyRegulatedArchive: vi.fn(),
}));
vi.mock('../plugin-audit.js', () => ({ reconcilePendingAuditOperations: vi.fn() }));
vi.mock('../tools/helpers.js', () => ({
  writeStateWithArtifactsAndAuditOperations: vi.fn(async (_dir: string, state: unknown) => state),
}));

import { readState } from '../../adapters/persistence.js';
import { readAuditTrail } from '../../adapters/persistence-audit.js';
import { archiveRegulatedEvidence } from '../../adapters/workspace/archive.js';
import { verifyRegulatedArchive } from '../../adapters/workspace/archive-verify-chain.js';
import { reconcilePendingAuditOperations } from '../plugin-audit.js';
import { writeStateWithArtifactsAndAuditOperations } from '../tools/helpers.js';

const AT = '2026-01-01T00:00:00.000Z';

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
    transition: {
      from: 'EVIDENCE_REVIEW',
      to: 'COMPLETE',
      event: 'APPROVE',
      at: AT,
    },
  });
}

/** The real entry path: the rail produced COMPLETE, but EVIDENCE_REVIEW is still persisted. */
function reviewEntryPath(): { persisted: SessionState; complete: SessionState } {
  return { persisted: reviewState('EVIDENCE_REVIEW'), complete: reviewState('COMPLETE') };
}

function decisionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    detail: {
      kind: 'decision',
      decisionId: 'DEC-001',
      decisionSequence: 1,
      gatePhase: 'EVIDENCE_REVIEW',
      verdict: 'approve',
      rationale: 'LGTM',
      decidedBy: 'reviewer-1',
      decidedAt: AT,
      fromPhase: 'EVIDENCE_REVIEW',
      toPhase: 'COMPLETE',
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
  } as unknown as AuditDeps;
}

/** Simulate persisted state advancing with every write, as the real adapter does. */
function trackPersistedState(initial: SessionState): void {
  let latest: SessionState | null = initial;
  vi.mocked(writeStateWithArtifactsAndAuditOperations).mockImplementation(
    async (_dir: string, state: unknown) => {
      latest = state as SessionState;
      return state as SessionState;
    },
  );
  vi.mocked(readState).mockImplementation(async () => latest);
}

function decisionWrites(): unknown[] {
  return vi
    .mocked(writeStateWithArtifactsAndAuditOperations)
    .mock.calls.filter((call) => JSON.stringify(call[3] ?? []).includes('decision:DEC-'));
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
  it('commits the terminal decision even when earlier decisions and lifecycles exist', async () => {
    // P0 guard: PLAN_REVIEW decisions and session_created must never suppress
    // the terminal completion evidence.
    const { persisted, complete } = reviewEntryPath();
    trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue({
      events: [planDecisionEvent(), sessionCreatedEvent()],
      skipped: 0,
    } as never);
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

    expect(result.archiveStatus).toBe('verified');
    expect(decisionWrites()).toHaveLength(1);
    expect(lifecycleWrites()).toHaveLength(1);
    expect(writeStateWithArtifactsAndAuditOperations).toHaveBeenNthCalledWith(
      1,
      '/sess',
      complete,
      undefined,
      expect.arrayContaining([
        expect.objectContaining({ event: expect.stringMatching(/^decision:DEC-/) }),
      ]),
    );
    expect(archiveRegulatedEvidence).toHaveBeenCalledWith('fp', 'sid');
  });

  it('fails closed and persists failure when reconciliation fails', async () => {
    const { persisted, complete } = reviewEntryPath();
    trackPersistedState(persisted);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue({
      auditOk: false,
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

    expect(result.archiveStatus).toBe('failed');
    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
    expect(writeStateWithArtifactsAndAuditOperations).toHaveBeenLastCalledWith(
      '/sess',
      expect.objectContaining({ archiveStatus: 'failed' }),
    );
  });

  it('resumes without emitting a second terminal decision or lifecycle', async () => {
    const persisted = reviewState('COMPLETE');
    trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue({
      events: [decisionEvent(), sessionCompletedEvent()],
      skipped: 0,
    } as never);
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

    expect(result.archiveStatus).toBe('verified');
    expect(decisionWrites()).toHaveLength(0);
    expect(lifecycleWrites()).toHaveLength(0);
    expect(archiveRegulatedEvidence).toHaveBeenCalledOnce();
  });

  it('does not treat a PLAN_REVIEW decision as terminal checkpoint evidence', async () => {
    const persisted = reviewState('COMPLETE');
    trackPersistedState(persisted);
    vi.mocked(readAuditTrail).mockResolvedValue({
      events: [planDecisionEvent(), sessionCreatedEvent()],
      skipped: 0,
    } as never);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    await executeRegulatedCompletion('/sess', 'fp', 'sid', persisted, completionDeps());

    expect(decisionWrites()).toHaveLength(1);
    expect(lifecycleWrites()).toHaveLength(1);
  });

  it('drains a durable terminal-decision outbox checkpoint before deciding a new intent is needed', async () => {
    // Crash window: COMPLETE + terminal decision op persisted in the outbox,
    // but the audit trail does not yet contain the reconciled event.
    const persisted: SessionState = {
      ...reviewState('COMPLETE'),
      pendingAuditOperations: [
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
    vi.mocked(readAuditTrail).mockImplementation(async () => ({
      events: [...trail],
      skipped: 0,
    }));
    vi.mocked(reconcilePendingAuditOperations).mockImplementation(async () => {
      trail.push(decisionEvent() as unknown as ChainedAuditEvent);
      persisted.pendingAuditOperations = [];
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

    expect(result.archiveStatus).toBe('verified');
    expect(decisionWrites()).toHaveLength(0);
    expect(lifecycleWrites()).toHaveLength(1);
    expect(reconcilePendingAuditOperations).toHaveBeenCalled();
  });

  it('resumes only for incomplete regulated COMPLETE checkpoints', async () => {
    vi.mocked(readState).mockResolvedValue({
      ...reviewState('COMPLETE'),
      archiveStatus: 'pending',
    });

    await expect(
      resumeRegulatedCompletion('/sess', 'fp', 'sid', completionDeps()),
    ).resolves.not.toBeNull();

    vi.mocked(readState).mockResolvedValue({
      ...reviewState('COMPLETE'),
      archiveStatus: 'verified',
    });
    await expect(
      resumeRegulatedCompletion('/sess', 'fp', 'sid', completionDeps()),
    ).resolves.toBeNull();
  });
});
