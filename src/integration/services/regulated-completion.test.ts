import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeRegulatedCompletion, resumeRegulatedCompletion } from './regulated-completion.js';
import type { SessionState } from '../../state/schema.js';
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

function completeState() {
  return makeState('COMPLETE', {
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
      at: '2026-01-01T00:00:00.000Z',
    },
  });
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

afterEach(() => vi.clearAllMocks());

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

describe('executeRegulatedCompletion', () => {
  it('commits and reconciles decision then lifecycle before archiving', async () => {
    const state = completeState();
    trackPersistedState(state);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state, completionDeps());

    expect(result.archiveStatus).toBe('verified');
    expect(reconcilePendingAuditOperations).toHaveBeenCalledTimes(3);
    expect(writeStateWithArtifactsAndAuditOperations).toHaveBeenNthCalledWith(
      1,
      '/sess',
      state,
      undefined,
      expect.arrayContaining([
        expect.objectContaining({ event: expect.stringMatching(/^decision:DEC-/) }),
      ]),
    );
    expect(writeStateWithArtifactsAndAuditOperations).toHaveBeenNthCalledWith(
      2,
      '/sess',
      expect.objectContaining({ archiveStatus: 'pending' }),
      undefined,
      expect.arrayContaining([expect.objectContaining({ event: 'lifecycle:session_completed' })]),
    );
    expect(archiveRegulatedEvidence).toHaveBeenCalledWith('fp', 'sid');
  });

  it('fails closed and persists failure when reconciliation fails', async () => {
    const state = completeState();
    vi.mocked(readState).mockResolvedValue(state);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue({
      auditOk: false,
      code: 'AUDIT_PERSISTENCE_FAILED',
      reason: 'disk failure',
    });

    const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state, completionDeps());

    expect(result.archiveStatus).toBe('failed');
    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
    expect(writeStateWithArtifactsAndAuditOperations).toHaveBeenLastCalledWith(
      '/sess',
      expect.objectContaining({ archiveStatus: 'failed' }),
    );
  });

  it('resumes from a durable decision checkpoint without emitting a second decision', async () => {
    const state = completeState();
    trackPersistedState(state);
    vi.mocked(readAuditTrail).mockResolvedValue({
      events: [{ detail: { kind: 'decision' } }],
      skipped: 0,
    } as never);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state, completionDeps());

    expect(result.archiveStatus).toBe('verified');
    const decisionWrites = vi
      .mocked(writeStateWithArtifactsAndAuditOperations)
      .mock.calls.filter((call) => JSON.stringify(call[3] ?? []).includes('decision:DEC-'));
    expect(decisionWrites).toHaveLength(0);
    expect(archiveRegulatedEvidence).toHaveBeenCalledOnce();
  });

  it('resumes only for incomplete regulated COMPLETE checkpoints', async () => {
    vi.mocked(readState).mockResolvedValue({
      ...completeState(),
      archiveStatus: 'pending',
    });

    await expect(
      resumeRegulatedCompletion('/sess', 'fp', 'sid', completionDeps()),
    ).resolves.not.toBeNull();

    vi.mocked(readState).mockResolvedValue({
      ...completeState(),
      archiveStatus: 'verified',
    });
    await expect(
      resumeRegulatedCompletion('/sess', 'fp', 'sid', completionDeps()),
    ).resolves.toBeNull();
  });
});
