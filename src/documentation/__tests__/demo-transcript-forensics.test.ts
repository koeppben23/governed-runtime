/**
 * @module documentation/demo-transcript-forensics.test
 * @description F1/F1b/F3: denial and recovery classification must be structured,
 * occurrence-bound, and fail closed on unreadable governed transcripts.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import {
  assertExpectedDenial,
  captureRetryCodes,
  deniedToolForCode,
  sameTurnRecoveryProofs,
  structuredRearmSupersedesTerminal,
  toolDenialCodes,
  transcriptTrust,
} from '../../../demos/java-task-manager/run-live-matrix.mjs';

const compact = (value: unknown): string => JSON.stringify(value);
const pretty = (value: unknown): string => JSON.stringify(value, null, 1);

function toolUse(tool: string, output: string): string {
  return JSON.stringify({ type: 'tool_use', part: { tool, state: { output } } });
}

function transcript(...lines: string[]): string {
  return lines.join('\n');
}

const denial = (code: string) => ({ error: true, code });
const success = { phase: 'PLAN', status: 'planning' };

describe('demo transcript forensics', () => {
  describe('HAPPY — structured envelopes regardless of formatting', () => {
    it('detects compact and pretty-printed denials identically', () => {
      const out = transcript(
        toolUse('flowguard_plan', compact(denial('REVISED_PLAN_REQUIRED'))),
        toolUse('flowguard_plan', pretty(denial('PROOFGRAPH_CLAIM_NOT_DECLARED'))),
      );
      expect(toolDenialCodes(out)).toEqual([
        'REVISED_PLAN_REQUIRED',
        'PROOFGRAPH_CLAIM_NOT_DECLARED',
      ]);
    });

    it('attributes the denied tool for pretty-printed output', () => {
      const out = transcript(toolUse('flowguard_plan', pretty(denial('REVISED_PLAN_REQUIRED'))));
      expect(deniedToolForCode(out, 'REVISED_PLAN_REQUIRED')).toBe('flowguard_plan');
    });

    it('captures structured review re-arms regardless of formatting', () => {
      const out = transcript(
        toolUse(
          'task',
          pretty({
            reviewDispatch: { required: true, completed: false },
            reviewRetry: { code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION', retryable: true },
          }),
        ),
      );
      expect(captureRetryCodes(out)).toEqual(['HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION']);
    });
  });

  describe('BAD — recovery is bound to a concrete occurrence', () => {
    it('does not credit a denial that occurs after the last successful call', () => {
      const out = transcript(
        toolUse('flowguard_plan', compact(denial('REVISED_PLAN_REQUIRED'))),
        toolUse('flowguard_plan', compact(success)),
        toolUse('flowguard_plan', compact(denial('PROOFGRAPH_CLAIM_NOT_DECLARED'))),
      );
      const proofs = sameTurnRecoveryProofs(out);
      expect(proofs.recovered.map((proof) => proof.code)).toEqual(['REVISED_PLAN_REQUIRED']);
      expect(proofs.unproven.map((proof) => proof.code)).toEqual(['PROOFGRAPH_CLAIM_NOT_DECLARED']);
    });

    it('never credits a different tool as the correction', () => {
      const out = transcript(
        toolUse('flowguard_plan', compact(denial('REVISED_PLAN_REQUIRED'))),
        toolUse('flowguard_status', compact(success)),
      );
      const proofs = sameTurnRecoveryProofs(out);
      expect(proofs.recovered).toEqual([]);
      expect(proofs.unproven.map((proof) => proof.code)).toEqual(['REVISED_PLAN_REQUIRED']);
    });
  });

  describe('CORNER — one later success may resolve several earlier rejections', () => {
    it('credits every denial that precedes the later success', () => {
      const out = transcript(
        toolUse('flowguard_plan', compact(denial('REVISED_PLAN_REQUIRED'))),
        toolUse('flowguard_plan', compact(denial('REVISED_PLAN_CLAIMS_REQUIRED'))),
        toolUse('flowguard_plan', compact(success)),
      );
      const proofs = sameTurnRecoveryProofs(out);
      expect(proofs.recovered.map((proof) => proof.code).sort()).toEqual([
        'REVISED_PLAN_CLAIMS_REQUIRED',
        'REVISED_PLAN_REQUIRED',
      ]);
      expect(proofs.unproven).toEqual([]);
    });
  });

  describe('EDGE — transcript trust boundary', () => {
    it('flags unreadable governed output instead of reporting no denials', () => {
      const out = transcript(toolUse('flowguard_plan', '{"error":tru'));
      const trust = transcriptTrust(out);
      expect(trust.readable).toBe(false);
      expect(trust.unreadable).toHaveLength(1);
    });

    it('refuses to certify an expected denial when governed output is unreadable', () => {
      const out = transcript(
        toolUse('flowguard_plan', compact(denial('PROOFGRAPH_RISK_TRIGGER_UNCOVERED'))),
        toolUse('flowguard_plan', 'not-json-at-all'),
      );
      expect(() => assertExpectedDenial(out, 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED')).toThrow(
        /transcript/i,
      );
    });

    it('does not flag plain text output of non-governed tools', () => {
      const out = transcript(toolUse('bash', 'mvn -q test\nBUILD SUCCESS'));
      expect(transcriptTrust(out).readable).toBe(true);
    });

    it('accepts a terminal block only when a structured re-arm follows later', () => {
      const rearm = {
        reviewDispatch: { required: true, completed: false },
        reviewRetry: { code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION', retryable: true },
      };
      const forward = transcript(
        toolUse('task', pretty(denial('HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION'))),
        toolUse('task', pretty(rearm)),
      );
      const backward = transcript(
        toolUse('task', pretty(rearm)),
        toolUse('task', pretty(denial('HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION'))),
      );
      expect(
        structuredRearmSupersedesTerminal(forward, 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION'),
      ).toBe(true);
      expect(
        structuredRearmSupersedesTerminal(backward, 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION'),
      ).toBe(false);
    });
  });
});
