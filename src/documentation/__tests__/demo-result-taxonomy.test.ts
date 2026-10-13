/**
 * @module documentation/demo-result-taxonomy.test
 * @description F10: a correctly refused negative control is CONTROL_PASSED, never
 * COMPLETE; FAILED outranks NOT_VERIFIED in the exit code.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { RESULT, exitCodeForResults, summarizeResults } from '../../../demos/lib/results.mjs';
import {
  classifyUnexpectedBlock,
  matrixExitCode,
} from '../../../demos/java-task-manager/run-live-matrix.mjs';

const records = (...results: string[]) => results.map((result) => ({ result }));

describe('demo result taxonomy', () => {
  describe('HAPPY — completed workflows and negative controls are success', () => {
    it('exits 0 for COMPLETE and CONTROL_PASSED only', () => {
      expect(exitCodeForResults(records(RESULT.COMPLETE, RESULT.CONTROL_PASSED))).toBe(0);
      expect(matrixExitCode(records(RESULT.COMPLETE, RESULT.CONTROL_PASSED))).toBe(0);
    });
  });

  describe('BAD — contract violations dominate', () => {
    it('exits 1 when any scenario FAILED, even alongside NOT_VERIFIED', () => {
      expect(exitCodeForResults(records(RESULT.FAILED, RESULT.NOT_VERIFIED))).toBe(1);
      expect(matrixExitCode(records(RESULT.FAILED, RESULT.NOT_VERIFIED))).toBe(1);
    });
  });

  describe('CORNER — unreached proofs are distinguishable', () => {
    it('exits 2 when only NOT_VERIFIED scenarios exist', () => {
      expect(exitCodeForResults(records(RESULT.NOT_VERIFIED, RESULT.COMPLETE))).toBe(2);
      expect(matrixExitCode(records(RESULT.NOT_VERIFIED))).toBe(2);
    });

    it('reports every result kind separately', () => {
      const summary = summarizeResults(
        records(RESULT.COMPLETE, RESULT.COMPLETE, RESULT.CONTROL_PASSED, RESULT.NOT_VERIFIED),
      );
      expect(summary).toEqual({
        total: 4,
        COMPLETE: 2,
        CONTROL_PASSED: 1,
        NOT_VERIFIED: 1,
        FAILED: 0,
      });
    });
  });

  describe('EDGE — F10 negative control counting', () => {
    it('never counts a refused plain approve as a completed workflow', () => {
      const architectureNegative = {
        name: 'architecture-negative',
        result: RESULT.CONTROL_PASSED,
        negativeOutcome: 'exhausted_plain_approve_refused',
      };
      const summary = summarizeResults([architectureNegative]);
      expect(summary.COMPLETE).toBe(0);
      expect(summary.CONTROL_PASSED).toBe(1);
      expect(exitCodeForResults([architectureNegative])).toBe(0);
    });

    it('treats an unknown result string as FAILED', () => {
      expect(exitCodeForResults(records('COMPLETE_ISH'))).toBe(1);
    });

    it('classifies review-stage capture/consistency blocks as NOT_VERIFIED', () => {
      expect(classifyUnexpectedBlock(['REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE'])).toBe(
        'not_verified',
      );
      expect(
        classifyUnexpectedBlock([
          'REVIEW_EVIDENCE_NOT_OBSERVED',
          'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        ]),
      ).toBe('not_verified');
      expect(classifyUnexpectedBlock(['ARCHIVE_FAILED'])).toBe('failed');
      expect(classifyUnexpectedBlock(['ARCHIVE_FAILED', 'REVIEW_EVIDENCE_NOT_OBSERVED'])).toBe(
        'failed',
      );
    });
  });
});
