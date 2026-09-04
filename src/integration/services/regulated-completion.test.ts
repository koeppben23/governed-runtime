import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeRegulatedCompletion } from './regulated-completion.js';
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

afterEach(() => vi.clearAllMocks());

describe('executeRegulatedCompletion', () => {
  it('commits and reconciles decision then lifecycle before archiving', async () => {
    const state = completeState();
    vi.mocked(readState).mockResolvedValue(state);
    vi.mocked(reconcilePendingAuditOperations).mockResolvedValue(undefined);
    vi.mocked(archiveRegulatedEvidence).mockResolvedValue('/archive.tar.gz');
    vi.mocked(verifyRegulatedArchive).mockResolvedValue({ passed: true } as never);

    const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

    expect(result.archiveStatus).toBe('verified');
    expect(reconcilePendingAuditOperations).toHaveBeenCalledTimes(2);
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

    const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

    expect(result.archiveStatus).toBe('failed');
    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
    expect(writeStateWithArtifactsAndAuditOperations).toHaveBeenLastCalledWith(
      '/sess',
      expect.objectContaining({ archiveStatus: 'failed' }),
    );
  });
});
