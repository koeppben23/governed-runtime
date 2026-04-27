/**
 * @module integration/tools/status-tool
 * @description FlowGuard status tool — read-only session state check.
 *
 * Returns phase, evidence summary, policy info, completeness matrix,
 * and next action. Does NOT mutate state.
 *
 * Supports focused projections via optional boolean flags:
 * whyBlocked, evidence, context, readiness.
 *
 * @version v1
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
import {
  withReadOnlySession,
  formatBlocked,
  formatError,
  formatEval,
  appendNextAction,
} from './helpers.js';

// State & Machine
import { evaluate } from '../../machine/evaluate.js';

// Adapters
import { ActorClaimError } from '../../adapters/actor.js';

// Config
import { evaluateCompleteness } from '../../audit/completeness.js';
import {
  buildStatusProjection,
  buildEvidenceDetailProjection,
  buildBlockedProjection,
  buildContextProjection,
  buildReadinessProjection,
} from '../status.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_status — Read-Only State Check
// ═══════════════════════════════════════════════════════════════════════════════

export const status: ToolDefinition = {
  description:
    'Read the current FlowGuard session state. Returns phase, evidence summary, ' +
    'policy info, completeness matrix, and next action. ' +
    'Does NOT mutate state. Use this to understand where the workflow is before taking action.',
  args: {
    whyBlocked: z
      .boolean()
      .optional()
      .describe('Return focused blocker surface from canonical evaluator/completeness truth.'),
    evidence: z
      .boolean()
      .optional()
      .describe('Return per-slot evidence detail from canonical completeness truth.'),
    context: z.boolean().optional().describe('Return actor/policy/archive context projection.'),
    readiness: z.boolean().optional().describe('Return compact operational readiness projection.'),
  },
  async execute(_args, context) {
    try {
      const { state, policy } = await withReadOnlySession(context);

      if (!state) {
        return JSON.stringify({
          phase: null,
          status: 'No FlowGuard session found.',
          next: 'Run /hydrate to bootstrap a session.',
        });
      }

      const ev = evaluate(state, policy);
      const completeness = evaluateCompleteness(state);
      const args = _args as {
        whyBlocked?: boolean;
        evidence?: boolean;
        context?: boolean;
        readiness?: boolean;
      };

      if (args.whyBlocked === true) {
        const blocked = buildBlockedProjection(state, policy);
        return appendNextAction(
          JSON.stringify({
            phase: state.phase,
            sessionId: state.id,
            whyBlocked: blocked,
          }),
          state,
        );
      }

      if (args.evidence === true) {
        const evidenceDetail = buildEvidenceDetailProjection(state);
        return appendNextAction(
          JSON.stringify({
            phase: state.phase,
            sessionId: state.id,
            evidence: evidenceDetail,
          }),
          state,
        );
      }

      if (args.context === true) {
        const contextDetail = buildContextProjection(state);
        return appendNextAction(
          JSON.stringify({
            phase: state.phase,
            sessionId: state.id,
            context: contextDetail,
          }),
          state,
        );
      }

      if (args.readiness === true) {
        const readinessDetail = buildReadinessProjection(state, policy);
        return appendNextAction(
          JSON.stringify({
            phase: state.phase,
            sessionId: state.id,
            readiness: readinessDetail,
          }),
          state,
        );
      }

      const projection = buildStatusProjection(state, policy);

      return appendNextAction(
        JSON.stringify({
          status: projection,
          phase: state.phase,
          sessionId: state.id,
          policyMode: state.policySnapshot?.mode ?? 'unknown',
          archiveStatus: state.archiveStatus ?? null,
          appliedPolicy: {
            source: state.policySnapshot?.source ?? 'unknown',
            requestedMode: state.policySnapshot?.requestedMode ?? 'unknown',
            effectiveMode: state.policySnapshot?.mode ?? 'unknown',
            effectiveGateBehavior: state.policySnapshot?.effectiveGateBehavior ?? 'unknown',
            degradedReason: state.policySnapshot?.degradedReason ?? null,
            resolutionReason: state.policySnapshot?.resolutionReason ?? null,
            centralMinimumMode: state.policySnapshot?.centralMinimumMode ?? null,
            centralPolicyDigest: state.policySnapshot?.policyDigest ?? null,
            centralPolicyVersion: state.policySnapshot?.policyVersion ?? null,
            centralPolicyPathHint: state.policySnapshot?.policyPathHint ?? null,
          },
          initiatedBy: state.initiatedBy,
          profileId: state.activeProfile?.id ?? 'none',
          profileName: state.activeProfile?.name ?? 'None',
          profileRules: (() => {
            const base = state.activeProfile?.ruleContent ?? '';
            const phaseExtra = state.activeProfile?.phaseRuleContent?.[state.phase];
            return phaseExtra ? base + '\n\n' + phaseExtra : base;
          })(),
          detectedStack: state.detectedStack ?? null,
          verificationCandidates: state.verificationCandidates ?? [],
          hasTicket: state.ticket !== null,
          hasPlan: state.plan !== null,
          planVersion: state.plan ? state.plan.history.length + 1 : 0,
          selfReviewIteration: state.selfReview?.iteration ?? null,
          selfReviewConverged: state.selfReview
            ? state.selfReview.iteration >= state.selfReview.maxIterations ||
              (state.selfReview.revisionDelta === 'none' && state.selfReview.verdict === 'approve')
            : null,
          // Latest independent plan review summary
          latestReview: (() => {
            const findings = state.plan?.reviewFindings;
            if (!findings || findings.length === 0) return null;
            const latest = findings[findings.length - 1];
            if (!latest) return null;
            return {
              iteration: latest.iteration,
              planVersion: latest.planVersion,
              overallVerdict: latest.overallVerdict,
              blockingIssueCount: latest.blockingIssues.length,
              majorRiskCount: latest.majorRisks.length,
              missingVerificationCount: latest.missingVerification.length,
              reviewMode: latest.reviewMode,
              reviewedAt: latest.reviewedAt,
            };
          })(),
          validationResults: state.validation.map((v) => ({
            checkId: v.checkId,
            passed: v.passed,
          })),
          hasImplementation: state.implementation !== null,
          implReviewIteration: state.implReview?.iteration ?? null,
          implReviewConverged: state.implReview
            ? state.implReview.iteration >= state.implReview.maxIterations ||
              (state.implReview.revisionDelta === 'none' && state.implReview.verdict === 'approve')
            : null,
          // Latest independent implementation review summary
          latestImplementationReview: (() => {
            const findings = state.implReviewFindings;
            if (!findings || findings.length === 0) return null;
            const latest = findings[findings.length - 1];
            if (!latest) return null;
            return {
              iteration: latest.iteration,
              overallVerdict: latest.overallVerdict,
              blockingIssueCount: latest.blockingIssues.length,
              majorRiskCount: latest.majorRisks.length,
              missingVerificationCount: latest.missingVerification.length,
              reviewMode: latest.reviewMode,
              reviewedAt: latest.reviewedAt,
            };
          })(),
          hasReviewDecision: state.reviewDecision !== null,
          reviewVerdict: state.reviewDecision?.verdict ?? null,
          error: state.error,
          evalKind: ev.kind,
          next: formatEval(ev),
          completeness: {
            overallComplete: completeness.overallComplete,
            fourEyes: completeness.fourEyes,
            summary: completeness.summary,
          },
        }),
        state,
      );
    } catch (err) {
      if (err instanceof ActorClaimError) {
        return formatBlocked(err.code);
      }
      return formatError(err);
    }
  },
};
