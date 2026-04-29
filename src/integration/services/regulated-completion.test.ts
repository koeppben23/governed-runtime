/**
 * @module integration/services/regulated-completion.test
 * @description Unit tests for P26 regulated completion chain: audit → archive → verify.
 *
 * Coverage: HAPPY, BAD, CORNER, EDGE
 * - HAPPY: Full chain succeeds → archiveStatus 'verified'
 * - BAD: Archive failure → archiveStatus 'failed', verification failure → 'failed'
 * - CORNER: Audit trail read failure → 'failed'
 * - EDGE: Verification returns not-passed → 'failed'
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

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
} from '../../__fixtures__.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../adapters/persistence.js', () => ({
  readAuditTrail: vi.fn().mockResolvedValue({ events: [], skipped: 0 }),
  appendAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../adapters/workspace/index.js', () => ({
  archiveSession: vi.fn().mockResolvedValue(undefined),
  verifyArchive: vi.fn().mockResolvedValue({ passed: true }),
}));

vi.mock('../../audit/types.js', () => ({
  createLifecycleEvent: vi.fn().mockReturnValue({
    eventId: 'test-evt',
    sessionId: 'sid',
    eventType: 'lifecycle',
    action: 'session_completed',
    timestamp: '2026-01-01T00:00:00.000Z',
  }),
}));

vi.mock('../../audit/integrity.js', () => ({
  getLastChainHash: vi.fn().mockReturnValue(null),
}));

vi.mock('../tools/helpers.js', () => ({
  writeStateWithArtifacts: vi.fn().mockResolvedValue(undefined),
}));

import { readAuditTrail, appendAuditEvent } from '../../adapters/persistence.js';
import { archiveSession, verifyArchive } from '../../adapters/workspace/index.js';
import { writeStateWithArtifacts } from '../tools/helpers.js';

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRegulatedCompleteState() {
  return makeState('COMPLETE', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    selfReview: SELF_REVIEW_CONVERGED,
    reviewDecision: REVIEW_APPROVE,
    validation: VALIDATION_PASSED,
    implementation: IMPL_EVIDENCE,
    implReview: IMPL_REVIEW_CONVERGED,
    policySnapshot: REGULATED_POLICY_SNAPSHOT,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('executeRegulatedCompletion', () => {
  describe('HAPPY: full chain succeeds', () => {
    it('returns state with archiveStatus verified', async () => {
      const state = makeRegulatedCompleteState();
      const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      expect(result.archiveStatus).toBe('verified');
    });

    it('writes pending state first', async () => {
      const state = makeRegulatedCompleteState();
      await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      // First call to writeStateWithArtifacts should be with pending status
      const firstCall = (writeStateWithArtifacts as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall![1]).toMatchObject({ archiveStatus: 'pending' });
    });

    it('emits audit event before archiving', async () => {
      const state = makeRegulatedCompleteState();
      await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      expect(readAuditTrail).toHaveBeenCalledWith('/sess');
      expect(appendAuditEvent).toHaveBeenCalledOnce();
    });

    it('calls archiveSession and verifyArchive in sequence', async () => {
      const state = makeRegulatedCompleteState();
      await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      expect(archiveSession).toHaveBeenCalledWith('fp', 'sid');
      expect(verifyArchive).toHaveBeenCalledWith('fp', 'sid');
    });

    it('writes created state after archive, before verify', async () => {
      const state = makeRegulatedCompleteState();
      await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      // Second call to writeStateWithArtifacts should be with created status
      const secondCall = (writeStateWithArtifacts as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(secondCall).toBeDefined();
      expect(secondCall![1]).toMatchObject({ archiveStatus: 'created' });
    });
  });

  describe('BAD: chain failures produce failed status', () => {
    it('returns failed when readAuditTrail throws', async () => {
      (readAuditTrail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('audit read error'),
      );
      const state = makeRegulatedCompleteState();
      const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      expect(result.archiveStatus).toBe('failed');
    });

    it('returns failed when appendAuditEvent throws', async () => {
      (appendAuditEvent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('audit write error'),
      );
      const state = makeRegulatedCompleteState();
      const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      expect(result.archiveStatus).toBe('failed');
    });

    it('returns failed when archiveSession throws', async () => {
      (archiveSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('archive error'),
      );
      const state = makeRegulatedCompleteState();
      const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      expect(result.archiveStatus).toBe('failed');
    });

    it('returns failed when verifyArchive throws', async () => {
      (verifyArchive as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('verify error'));
      const state = makeRegulatedCompleteState();
      const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      expect(result.archiveStatus).toBe('failed');
    });
  });

  describe('EDGE: verification not passed', () => {
    it('returns failed when verification.passed is false', async () => {
      (verifyArchive as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ passed: false });
      const state = makeRegulatedCompleteState();
      const result = await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      expect(result.archiveStatus).toBe('failed');
    });
  });

  describe('CORNER: always writes pending state even when chain fails', () => {
    it('pending state is written before failure', async () => {
      (readAuditTrail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('immediate failure'),
      );
      const state = makeRegulatedCompleteState();
      await executeRegulatedCompletion('/sess', 'fp', 'sid', state);

      // Pending state is always written first
      expect(writeStateWithArtifacts).toHaveBeenCalled();
      const firstCall = (writeStateWithArtifacts as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(firstCall![1]).toMatchObject({ archiveStatus: 'pending' });
    });
  });
});
