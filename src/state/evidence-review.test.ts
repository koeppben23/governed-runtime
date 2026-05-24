/**
 * @module evidence-review.test
 * @description Tests for evidence-review module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  Finding,
  ReviewActorInfo,
  ReviewAttestation,
  ReviewFindings,
  ReviewObligation,
  ReviewInvocationEvidence,
  ReviewAssuranceState,
  ReviewDecision,
  ReviewReport,
  EvidenceSlotStatusSchema,
  FourEyesStatusSchema,
  CompletenessSummarySchema,
  CompletenessReportSchema,
} from './evidence-review.js';
import { FIXED_TIME, FIXED_UUID } from './evidence-test-constants.js';

describe('evidence-review', () => {
  describe('Completeness schemas (HAPPY)', () => {
    it('EvidenceSlotStatusSchema parses valid slot', () => {
      const slot = {
        slot: 'ticket',
        label: 'Ticket Evidence',
        required: true,
        present: true,
        status: 'complete' as const,
      };
      expect(EvidenceSlotStatusSchema.parse(slot)).toEqual(slot);
    });

    it('FourEyesStatusSchema parses satisfied four-eyes', () => {
      const status = {
        required: true,
        satisfied: true,
        initiatedBy: 'user-a',
        decidedBy: 'user-b',
        detail: 'Four-eyes satisfied: reviewed by different user',
      };
      expect(FourEyesStatusSchema.parse(status)).toEqual(status);
    });

    it('CompletenessReportSchema parses full report', () => {
      const report = {
        sessionId: FIXED_UUID,
        phase: 'COMPLETE',
        policyMode: 'regulated',
        overallComplete: true,
        slots: [
          {
            slot: 'ticket',
            label: 'Ticket',
            required: true,
            present: true,
            status: 'complete' as const,
          },
        ],
        fourEyes: {
          required: true,
          satisfied: true,
          initiatedBy: 'user-a',
          decidedBy: 'user-b',
          detail: 'OK',
        },
        summary: { total: 1, complete: 1, missing: 0, notYetRequired: 0, failed: 0 },
      };
      expect(CompletenessReportSchema.parse(report)).toEqual(report);
    });
  });

  describe('Review findings (HAPPY)', () => {
    it('Finding parses valid finding', () => {
      const finding = {
        severity: 'major' as const,
        category: 'correctness' as const,
        message: 'Missing edge case handling',
        location: 'src/auth.ts:42',
      };
      expect(Finding.parse(finding)).toEqual(finding);
    });

    it('ReviewActorInfo parses minimal actor info', () => {
      const actor = { sessionId: 'ses_test' };
      expect(ReviewActorInfo.parse(actor)).toEqual(actor);
    });

    it('ReviewAttestation parses strict attestation', () => {
      const attestation = {
        mandateDigest: 'sha256-mandate',
        criteriaVersion: 'v1',
        toolObligationId: FIXED_UUID,
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer' as const,
      };
      expect(ReviewAttestation.parse(attestation)).toEqual(attestation);
    });

    it('ReviewFindings parses approval verdict', () => {
      const findings = {
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent' as const,
        overallVerdict: 'approve' as const,
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: { sessionId: 'ses_test' },
        reviewedAt: FIXED_TIME,
      };
      expect(ReviewFindings.parse(findings)).toEqual(findings);
    });
  });

  describe('Review obligations (HAPPY)', () => {
    it('ReviewObligation parses pending obligation', () => {
      const obligation = {
        obligationId: FIXED_UUID,
        obligationType: 'plan' as const,
        iteration: 0,
        planVersion: 1,
        criteriaVersion: 'v1',
        mandateDigest: 'sha256-mandate',
        createdAt: FIXED_TIME,
        pluginHandshakeAt: null,
        status: 'pending' as const,
        invocationId: null,
        blockedCode: null,
        fulfilledAt: null,
        consumedAt: null,
      };
      expect(ReviewObligation.parse(obligation)).toEqual(obligation);
    });

    it('ReviewInvocationEvidence parses host-task invocation', () => {
      const invocation = {
        invocationId: FIXED_UUID,
        obligationId: FIXED_UUID,
        obligationType: 'plan' as const,
        parentSessionId: 'ses_parent',
        childSessionId: 'ses_child',
        agentType: 'flowguard-reviewer' as const,
        invocationMode: 'host_subagent_task' as const,
        hostVisible: true,
        promptHash: 'sha256-prompt',
        mandateDigest: 'sha256-mandate',
        criteriaVersion: 'v1',
        findingsHash: 'sha256-findings',
        invokedAt: FIXED_TIME,
        fulfilledAt: null,
        consumedByObligationId: null,
      };
      const parsed = ReviewInvocationEvidence.parse(invocation);
      expect(parsed.reviewOutputMode).toBe('structured_output');
      expect(parsed.structuredOutputUsed).toBe(true);
      expect(parsed.reviewAssuranceLevel).toBe('structured_high');
    });

    it('ReviewAssuranceState parses valid assurance state', () => {
      const state = { obligations: [], invocations: [] };
      expect(ReviewAssuranceState.parse(state)).toEqual(state);
    });
  });

  describe('Review decision (HAPPY)', () => {
    it('ReviewDecision parses approve decision', () => {
      const decision = {
        verdict: 'approve' as const,
        rationale: 'LGTM',
        decidedAt: FIXED_TIME,
        decidedBy: 'reviewer-1',
      };
      expect(ReviewDecision.parse(decision)).toEqual(decision);
    });

    it('ReviewDecision parses decision with identity', () => {
      const decision = {
        verdict: 'changes_requested' as const,
        rationale: 'Missing tests',
        decidedAt: FIXED_TIME,
        decidedBy: 'reviewer-2',
        decisionIdentity: {
          actorId: 'reviewer-2',
          actorEmail: 'r2@example.com',
          actorSource: 'env' as const,
          actorAssurance: 'best_effort' as const,
        },
      };
      expect(ReviewDecision.parse(decision)).toEqual(decision);
    });
  });

  describe('Review report (HAPPY)', () => {
    it('ReviewReport parses clean report', () => {
      const report = {
        schemaVersion: 'flowguard-review-report.v1' as const,
        sessionId: FIXED_UUID,
        generatedAt: FIXED_TIME,
        phase: 'COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: 'clean' as const,
        completeness: {
          sessionId: FIXED_UUID,
          phase: 'COMPLETE',
          policyMode: 'team',
          overallComplete: true,
          slots: [],
          fourEyes: {
            required: false,
            satisfied: true,
            initiatedBy: 'test',
            decidedBy: null,
            detail: 'Four-eyes not required by policy',
          },
          summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
        },
      };
      expect(ReviewReport.parse(report)).toEqual(report);
    });
  });

  describe('Review (BAD)', () => {
    it('Finding rejects invalid severity', () => {
      expect(() =>
        Finding.parse({
          severity: 'trivial',
          category: 'quality',
          message: 'test',
        }),
      ).toThrow();
    });

    it('ReviewDecision rejects unknown verdict', () => {
      expect(() =>
        ReviewDecision.parse({
          verdict: 'maybe',
          rationale: 'unsure',
          decidedAt: FIXED_TIME,
          decidedBy: 'reviewer',
        }),
      ).toThrow();
    });

    it('ReviewObligation rejects obligation with missing fields', () => {
      expect(() => ReviewObligation.parse({ obligationId: FIXED_UUID })).toThrow();
    });

    it('ReviewReport rejects invalid overallStatus', () => {
      expect(() =>
        ReviewReport.parse({
          schemaVersion: 'flowguard-review-report.v1',
          sessionId: FIXED_UUID,
          generatedAt: FIXED_TIME,
          phase: 'COMPLETE',
          planDigest: null,
          implDigest: null,
          validationSummary: [],
          findings: [],
          overallStatus: 'perfect',
          completeness: {
            sessionId: FIXED_UUID,
            phase: 'COMPLETE',
            policyMode: 'team',
            overallComplete: true,
            slots: [],
            fourEyes: {
              required: false,
              satisfied: true,
              initiatedBy: 'test',
              decidedBy: null,
              detail: '',
            },
            summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
          },
        }),
      ).toThrow();
    });
  });

  describe('Review (CORNER)', () => {
    it('ReviewFindings accepts unable_to_review verdict', () => {
      const findings = {
        iteration: 0,
        planVersion: 1,
        reviewMode: 'subagent' as const,
        overallVerdict: 'unable_to_review' as const,
        blockingIssues: [],
        majorRisks: [],
        missingVerification: ['Context references missing'],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: { sessionId: 'ses_test' },
        reviewedAt: FIXED_TIME,
      };
      expect(ReviewFindings.parse(findings)).toEqual(findings);
    });

    it('CompletenessSummary total must equal sum of parts', () => {
      const summary = { total: 10, complete: 7, missing: 2, notYetRequired: 0, failed: 1 };
      expect(CompletenessSummarySchema.parse(summary)).toEqual(summary);
    });
  });

  describe('Review (EDGE)', () => {
    it('ReviewFindings rejects decisions with reject (human-only verdict)', () => {
      expect(() =>
        ReviewFindings.parse({
          iteration: 0,
          planVersion: 1,
          reviewMode: 'subagent',
          overallVerdict: 'reject',
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          reviewedBy: { sessionId: 'ses_test' },
          reviewedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ReviewObligation metadata is optional and accepts arbitrary records', () => {
      const obligation = {
        obligationId: FIXED_UUID,
        obligationType: 'review' as const,
        iteration: 0,
        planVersion: 1,
        criteriaVersion: 'v1',
        mandateDigest: 'sha256-mandate',
        createdAt: FIXED_TIME,
        pluginHandshakeAt: null,
        status: 'pending' as const,
        invocationId: null,
        blockedCode: null,
        fulfilledAt: null,
        consumedAt: null,
        metadata: { inputFingerprint: 'abc', customField: 42 },
      };
      expect(ReviewObligation.parse(obligation)).toEqual(obligation);
    });
  });
});
