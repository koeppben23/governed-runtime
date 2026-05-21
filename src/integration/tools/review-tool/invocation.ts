/**
 * @module integration/tools/review-tool/invocation
 * @description Review invocation validation and recording.
 *
 * Handles host-orchestrated and manual-attested review invocation evidence.
 *
 * @version v1
 */

import type { ReviewObligation } from '../../../state/evidence.js';
import {
  ensureReviewAssurance,
  buildInvocationEvidence,
  hasEvidenceReuse,
  hashFindings,
  hashText,
  appendInvocationEvidence,
  fulfillObligation,
} from '../../review/assurance.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import {
  formatBlockedWithAttestation,
  formatSubagentReviewNotInvoked,
  fingerprintReviewInput,
} from './obligation.js';
import type { StartedReviewResult, ReviewExecutionContext } from './types.js';
import type { ToolContext } from '../helpers.js';

// ─── Invocation validation ───────────────────────────────────────────────────

export function validateTextCompatInvocation(
  findings: Record<string, unknown>,
  obligation: ReviewObligation,
  hostInvForObligation: ReturnType<typeof ensureReviewAssurance>['invocations'][number] | undefined,
): string | null {
  const submittedReviewOutput = findings.pluginReviewOutput as Record<string, unknown> | undefined;
  if (submittedReviewOutput?.reviewOutputMode !== 'text_compat') return null;
  if (hostInvForObligation?.reviewOutputMode !== 'text_compat') {
    return formatBlockedWithAttestation(
      'SUBAGENT_MANDATE_MISMATCH',
      'Submitted text-compat findings require matching host-orchestrated ReviewInvocationEvidence with reviewOutputMode: text_compat.',
      obligation.obligationId,
    );
  }
  if (
    hostInvForObligation.reviewAssuranceLevel !== 'text_compat_lower' ||
    hostInvForObligation.structuredOutputUsed !== false ||
    !hostInvForObligation.extractionMethod
  ) {
    return formatBlockedWithAttestation(
      'SUBAGENT_MANDATE_MISMATCH',
      'Submitted text-compat findings require complete lower-assurance invocation metadata.',
      obligation.obligationId,
    );
  }
  return null;
}

export function validateHostInvocationEvidence(input: {
  hostInvForObligation: ReturnType<typeof ensureReviewAssurance>['invocations'][number];
  findingsHash: string;
  childSessionId: string;
  policy: string;
  context: ToolContext;
  obligation: ReviewObligation;
}): string | null {
  const { hostInvForObligation, findingsHash, childSessionId, policy, context, obligation } = input;
  const policyMismatch =
    policy === 'host_task_required' &&
    (hostInvForObligation.invocationMode !== 'host_subagent_task' ||
      hostInvForObligation.hostVisible !== true ||
      hostInvForObligation.parentSessionId !== context.sessionID ||
      hostInvForObligation.criteriaVersion !== obligation.criteriaVersion ||
      hostInvForObligation.mandateDigest !== obligation.mandateDigest);
  if (
    hostInvForObligation.findingsHash === findingsHash &&
    hostInvForObligation.childSessionId === childSessionId &&
    !policyMismatch
  )
    return null;
  return formatBlockedWithAttestation(
    'SUBAGENT_MANDATE_MISMATCH',
    'Submitted findings do not match the host-orchestrated reviewer findings for this obligation. Re-submit with the exact pluginReviewFindings provided by the plugin.',
    obligation.obligationId,
  );
}

// ─── Manual invocation state building ────────────────────────────────────────

function buildManualInvocationState(input: {
  result: StartedReviewResult;
  obligation: ReviewObligation;
  context: ToolContext;
  childSessionId: string;
  findingsHash: string;
  promptHash: string;
  now: string;
}): StartedReviewResult {
  const { result, obligation, context, childSessionId, findingsHash, promptHash, now } = input;
  const invocation = buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: 'review',
    parentSessionId: context.sessionID,
    childSessionId,
    invocationMode: 'manual_attested',
    hostVisible: false,
    promptHash,
    findingsHash,
    invokedAt: now,
    fulfilledAt: now,
    source: 'agent-submitted-attested',
  });
  return {
    ...result,
    state: {
      ...result.state,
      reviewAssurance: appendInvocationEvidence(
        fulfillObligation(
          ensureReviewAssurance(result.state.reviewAssurance),
          obligation.obligationId,
          invocation.invocationId,
          now,
        ),
        invocation,
      ),
    },
  };
}

// ─── Invocation recording orchestrators ──────────────────────────────────────

function recordManualReviewInvocation(input: {
  result: StartedReviewResult;
  obligation: ReviewObligation;
  exec: ReviewExecutionContext;
  childSessionId: string;
  findingsHash: string;
  assurance: ReturnType<typeof ensureReviewAssurance>;
}): { result: StartedReviewResult; blocked?: string } {
  const { result, obligation, exec, childSessionId, findingsHash, assurance } = input;
  if (exec.policy === 'host_task_required') {
    return {
      result,
      blocked: formatBlockedWithAttestation(
        'HOST_SUBAGENT_TASK_REQUIRED',
        `This policy requires host-visible Task-tool evidence for ${REVIEWER_SUBAGENT_TYPE}; manual-attested /review findings are not accepted.`,
        obligation.obligationId,
      ),
    };
  }
  if (hasEvidenceReuse(assurance.invocations, childSessionId, findingsHash)) {
    return {
      result,
      blocked: formatBlockedWithAttestation(
        'SUBAGENT_EVIDENCE_REUSED',
        'The submitted subagent findings have already been used for a prior review obligation.',
        obligation.obligationId,
      ),
    };
  }
  return {
    result: buildManualInvocationState({
      result,
      obligation,
      context: exec.context,
      childSessionId,
      findingsHash,
      promptHash: hashText(fingerprintReviewInput(exec.args)),
      now: exec.now,
    }),
  };
}

export function recordSubmittedReviewInvocation(
  result: StartedReviewResult,
  obligation: ReviewObligation,
  exec: ReviewExecutionContext,
): { result: StartedReviewResult; blocked?: string } {
  const findings = exec.args.reviewFindings as Record<string, unknown>;
  const childSessionId = String((findings.reviewedBy as Record<string, unknown>).sessionId ?? '');
  if (!childSessionId) {
    return {
      result,
      blocked: formatSubagentReviewNotInvoked(
        'Subagent findings must include reviewedBy.sessionId.',
        obligation.obligationId,
      ),
    };
  }

  const findingsHash = hashFindings(findings);
  const assurance = ensureReviewAssurance(result.state.reviewAssurance);
  const hostInvForObligation = assurance.invocations.find(
    (inv) => inv.obligationId === obligation.obligationId && inv.source === 'host-orchestrated',
  );
  const textCompatBlock = validateTextCompatInvocation(findings, obligation, hostInvForObligation);
  if (textCompatBlock) return { result, blocked: textCompatBlock };
  if (hostInvForObligation) {
    return {
      result,
      blocked:
        validateHostInvocationEvidence({
          hostInvForObligation,
          findingsHash,
          childSessionId,
          policy: exec.policy,
          context: exec.context,
          obligation,
        }) ?? undefined,
    };
  }
  return recordManualReviewInvocation({
    result,
    obligation,
    exec,
    childSessionId,
    findingsHash,
    assurance,
  });
}
