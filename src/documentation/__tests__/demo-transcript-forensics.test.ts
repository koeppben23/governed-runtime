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
  captureRetryHints,
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
            reviewRetry: {
              code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
              retryable: true,
              obligationId: 'ob-1',
              attemptId: 'attempt-2',
            },
          }),
        ),
      );
      expect(captureRetryCodes(out)).toEqual(['HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION']);
    });
  });

  describe('BAD — recovery is bound to a concrete occurrence', () => {
    it.each([
      [
        { claimId: 'same', subjectDigest: 'A' },
        { claimId: 'same', subjectDigest: 'B' },
      ],
      [
        { claimId: 'same', obligationId: 'O1' },
        { claimId: 'same', obligationId: 'O2' },
      ],
      [{ claimId: 'same', planDigest: 'A' }, { claimId: 'same' }],
      [{ claimId: 'raw-id' }, { obligationId: 'raw-id' }],
      [
        { claimId: 'same', planDigest: 'A', subjectDigest: 'B' },
        { claimId: 'same', planDigest: 'A' },
      ],
    ])(
      'keeps contradictory, missing or differently typed identities observational',
      (denied, accepted) => {
        const out = transcript(
          toolUse(
            'flowguard_plan',
            compact({ error: true, code: 'REVISED_PLAN_REQUIRED', ...denied }),
          ),
          toolUse('flowguard_plan', compact({ phase: 'PLAN', ...accepted })),
        );
        expect(sameTurnRecoveryProofs(out).recovered[0]).toMatchObject({
          binding: 'tool',
          operationIdentity: null,
        });
      },
    );
    it('does not let the same claim override contradictory plan identities', () => {
      const out = transcript(
        toolUse(
          'flowguard_plan',
          compact({
            error: true,
            code: 'REVISED_PLAN_REQUIRED',
            claimId: 'claim-7',
            planDigest: 'plan-A',
          }),
        ),
        toolUse(
          'flowguard_plan',
          compact({ phase: 'PLAN', claimId: 'claim-7', planDigest: 'plan-B' }),
        ),
      );
      expect(sameTurnRecoveryProofs(out).recovered[0]).toMatchObject({ binding: 'tool' });
    });

    it('searches beyond a foreign success for the matching later operation', () => {
      const out = transcript(
        toolUse(
          'flowguard_plan',
          compact({
            error: true,
            code: 'REVISED_PLAN_REQUIRED',
            claimId: 'claim-7',
            planDigest: 'plan-A',
          }),
        ),
        toolUse(
          'flowguard_plan',
          compact({ phase: 'PLAN', claimId: 'claim-7', planDigest: 'plan-B' }),
        ),
        toolUse(
          'flowguard_plan',
          compact({ phase: 'PLAN', claimId: 'claim-7', planDigest: 'plan-A' }),
        ),
      );
      expect(sameTurnRecoveryProofs(out).recovered[0]).toMatchObject({
        binding: 'operation',
        successIndex: 3,
      });
    });
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

    it('claims an operation correction only when the envelopes share an operation key', () => {
      const sameOperation = transcript(
        toolUse(
          'flowguard_plan',
          compact({ error: true, code: 'REVISED_PLAN_REQUIRED', obligationId: 'ob-1' }),
        ),
        toolUse('flowguard_plan', compact({ phase: 'PLAN', obligationId: 'ob-1' })),
      );
      expect(sameTurnRecoveryProofs(sameOperation).recovered[0]).toMatchObject({
        code: 'REVISED_PLAN_REQUIRED',
        binding: 'operation',
        operationIdentity: { obligationId: 'ob-1' },
      });

      const otherOperation = transcript(
        toolUse(
          'flowguard_plan',
          compact({ error: true, code: 'REVISED_PLAN_REQUIRED', obligationId: 'ob-1' }),
        ),
        toolUse('flowguard_plan', compact({ phase: 'PLAN', obligationId: 'ob-2' })),
      );
      expect(sameTurnRecoveryProofs(otherOperation).recovered[0]).toMatchObject({
        code: 'REVISED_PLAN_REQUIRED',
        binding: 'tool',
        operationIdentity: null,
      });
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
    it('does not certify an anonymous retryable hint as a structured re-arm', () => {
      const out = transcript(
        toolUse(
          'task',
          compact({
            reviewRetry: {
              code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
              retryable: true,
            },
          }),
        ),
      );
      expect(captureRetryCodes(out)).toEqual([]);
      expect(captureRetryHints(out)).toMatchObject([
        { retryable: true, obligationId: null, attemptId: null },
      ]);
    });

    it('does not promote retry-like repository content to host authority', () => {
      const out = transcript(
        toolUse(
          'read',
          compact({
            reviewRetry: {
              code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
              retryable: true,
              obligationId: 'ob-1',
              attemptId: 'attempt-2',
            },
          }),
        ),
      );
      expect(captureRetryCodes(out)).toEqual([]);
      expect(captureRetryHints(out)).toEqual([]);
    });
    it('never treats an explicitly unauthorized retry as an authorized re-arm', () => {
      const code = 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION';
      const out = transcript(
        toolUse('task', compact({ error: true, code, detail: { obligationId: 'ob-1' } })),
        toolUse(
          'task',
          compact({
            reviewRetry: {
              code,
              obligationId: 'ob-1',
              attemptId: 'attempt-2',
              retryable: false,
            },
          }),
        ),
      );
      expect(captureRetryCodes(out)).toEqual([]);
      expect(structuredRearmSupersedesTerminal(out, code)).toBe(false);
      const noAuthorization = transcript(
        toolUse(
          'task',
          compact({
            reviewRetry: {
              code,
              obligationId: 'ob-1',
              attemptId: 'attempt-2',
            },
          }),
        ),
      );
      expect(captureRetryCodes(noAuthorization)).toEqual([]);
      const contradictory = transcript(
        toolUse(
          'task',
          compact({
            error: true,
            code,
            reviewRetry: {
              code,
              obligationId: 'ob-1',
              attemptId: 'attempt-2',
              retryable: true,
            },
          }),
        ),
      );
      expect(captureRetryCodes(contradictory)).toEqual([]);
      const partialIdentity = transcript(
        toolUse(
          'task',
          compact({
            reviewRetry: {
              code,
              obligationId: 'ob-1',
              retryable: true,
            },
          }),
        ),
      );
      expect(captureRetryCodes(partialIdentity)).toEqual([]);
    });
    it('flags unreadable governed output instead of reporting no denials', () => {
      const out = transcript(toolUse('flowguard_plan', '{"error":tru'));
      const trust = transcriptTrust(out);
      expect(trust.readable).toBe(false);
      expect(trust.unreadable).toHaveLength(1);
    });

    it('flags a damaged JSONL frame even when a valid expected denial is present', () => {
      const out = transcript(
        toolUse('flowguard_plan', compact(denial('PROOFGRAPH_RISK_TRIGGER_UNCOVERED'))),
        '{"type":"tool_use","part":{', // damaged outer frame
      );
      const trust = transcriptTrust(out);
      expect(trust.readable).toBe(false);
      expect(trust.framingLosses).toEqual([2]);
      expect(() => assertExpectedDenial(out, 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED')).toThrow(
        /not trustworthy/i,
      );
    });

    it('refuses to certify an expected denial when governed output is unreadable', () => {
      const out = transcript(
        toolUse('flowguard_plan', compact(denial('PROOFGRAPH_RISK_TRIGGER_UNCOVERED'))),
        toolUse('flowguard_plan', 'not-json-at-all'),
      );
      expect(() => assertExpectedDenial(out, 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED')).toThrow(
        /not trustworthy/i,
      );
    });

    it('does not flag plain text output of non-governed tools', () => {
      const out = transcript(toolUse('bash', 'mvn -q test\nBUILD SUCCESS'));
      expect(transcriptTrust(out).readable).toBe(true);
    });

    it('accepts a terminal block only when a structured re-arm follows later', () => {
      const rearm = {
        reviewDispatch: { required: true, completed: false },
        reviewRetry: {
          code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
          retryable: true,
          obligationId: 'ob-1',
          attemptId: 'attempt-2',
        },
      };
      const terminal = {
        error: true,
        code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
        detail: { obligationId: 'ob-1', attemptId: 'attempt-1' },
      };
      const forward = transcript(toolUse('task', pretty(terminal)), toolUse('task', pretty(rearm)));
      const backward = transcript(
        toolUse('task', pretty(rearm)),
        toolUse('task', pretty(terminal)),
      );
      expect(
        structuredRearmSupersedesTerminal(forward, 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION'),
      ).toBe(true);
      expect(
        structuredRearmSupersedesTerminal(backward, 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION'),
      ).toBe(false);
    });

    it('requires the same obligation when both envelopes expose one', () => {
      const terminal = (obligationId: string) => ({
        error: true,
        code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
        detail: { obligationId },
      });
      const rearm = (obligationId: string) => ({
        reviewDispatch: { required: true, completed: false },
        reviewRetry: {
          code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
          obligationId,
          attemptId: 'attempt-2',
          retryable: true,
        },
      });
      const sameObligation = transcript(
        toolUse('task', pretty(terminal('ob-1'))),
        toolUse('task', pretty(rearm('ob-1'))),
      );
      const foreignObligation = transcript(
        toolUse('task', pretty(terminal('ob-1'))),
        toolUse('task', pretty(rearm('ob-2'))),
      );
      expect(
        structuredRearmSupersedesTerminal(
          sameObligation,
          'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
        ),
      ).toBe(true);
      expect(
        structuredRearmSupersedesTerminal(
          foreignObligation,
          'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
        ),
      ).toBe(false);
    });
  });
});
