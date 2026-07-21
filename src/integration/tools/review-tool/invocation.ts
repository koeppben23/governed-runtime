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
import { readReviewerCaptures } from '../../../adapters/persistence-reviewer-capture.js';
import {
  formatBlockedWithAttestation,
  formatSubagentReviewNotInvoked,
  fingerprintReviewInput,
  getRequiredBranchReviewSource,
} from './obligation.js';
import type {
  NativeAttestationRejection,
  NativeAttestationRejectionReason,
  StartedReviewResult,
  ReviewExecutionContext,
} from './types.js';
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

// ─── Native subagent attestation resolution ──────────────────────────────────

export interface NativeAttestation {
  readonly invocationMode: 'manual_attested' | 'native_subagent_attested';
  readonly hostCapturedAgentId?: string;
  readonly hostCapturedAgentType?: typeof REVIEWER_SUBAGENT_TYPE;
  readonly hostCaptureSource?: 'subagent_stop_hook' | 'post_tool_use_hook';
  readonly rejection?: NativeAttestationRejection;
}

function manualAttestation(
  obligationId: string,
  reason: NativeAttestationRejectionReason,
): NativeAttestation {
  return { invocationMode: 'manual_attested', rejection: { reason, obligationId } };
}

/**
 * Decide whether agent-submitted attested findings can be upgraded to
 * `native_subagent_attested`. The upgrade requires an independent FlowGuard
 * host-captured corroboration record — a PostToolUse capture proving the review
 * tool was invoked from inside a genuine `flowguard-reviewer` subagent AND bound
 * to this exact obligation.
 *
 * Fail-closed: any read error, skipped capture line, missing capture, or unbound
 * capture returns `manual_attested` with an explicit diagnostic (no upgrade, never
 * an error-open). The capture must match this exact parent sessionId; SubagentStop
 * captures alone do NOT upgrade because they carry no obligation binding.
 */
export async function resolveNativeAttestation(input: {
  sessDir: string;
  obligationId: string;
  sessionId: string;
}): Promise<NativeAttestation> {
  let read: Awaited<ReturnType<typeof readReviewerCaptures>>;
  try {
    read = await readReviewerCaptures(input.sessDir);
  } catch {
    return manualAttestation(input.obligationId, 'capture_read_failed');
  }
  if (read.skipped > 0) return manualAttestation(input.obligationId, 'capture_lines_skipped');
  if (read.captures.length === 0) return manualAttestation(input.obligationId, 'capture_missing');
  const bound = read.captures.find(
    (c) =>
      c.agentType === REVIEWER_SUBAGENT_TYPE &&
      c.source === 'post_tool_use_hook' &&
      c.reviewToolInvoked === true &&
      c.obligationId === input.obligationId,
  );
  if (!bound) return manualAttestation(input.obligationId, 'capture_unbound');
  if (bound.sessionId !== input.sessionId) {
    return manualAttestation(input.obligationId, 'capture_session_mismatch');
  }
  return {
    invocationMode: 'native_subagent_attested',
    hostCapturedAgentId: bound.agentId,
    hostCapturedAgentType: REVIEWER_SUBAGENT_TYPE,
    hostCaptureSource: 'post_tool_use_hook',
  };
}

function getBranchProvenance(obligation: ReviewObligation): {
  resolvedBranchSha?: string | null;
  resolvedBaseSha?: string | null;
  reviewedContentDigest?: string | null;
} {
  const isBranchReview =
    typeof obligation.metadata?.branch === 'string' && obligation.metadata.branch.length > 0;
  if (!isBranchReview) return {};
  // For branch reviews, fail-closed if SHAs are missing
  const source = getRequiredBranchReviewSource(obligation);
  const digest =
    typeof obligation.metadata?.reviewedContentDigest === 'string'
      ? obligation.metadata.reviewedContentDigest
      : null;
  return {
    resolvedBranchSha: source.resolvedBranchSha,
    resolvedBaseSha: source.resolvedBaseSha,
    reviewedContentDigest: digest,
  };
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
  attestation: NativeAttestation;
}): StartedReviewResult {
  const {
    result,
    obligation,
    context,
    childSessionId,
    findingsHash,
    promptHash,
    now,
    attestation,
  } = input;
  const invocation = buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: 'review',
    parentSessionId: context.sessionID,
    childSessionId,
    invocationMode: attestation.invocationMode,
    hostVisible: false,
    promptHash,
    findingsHash,
    invokedAt: now,
    fulfilledAt: now,
    source: 'agent-submitted-attested',
    ...getBranchProvenance(obligation),
    ...(attestation.hostCapturedAgentId
      ? { hostCapturedAgentId: attestation.hostCapturedAgentId }
      : {}),
    ...(attestation.hostCapturedAgentType
      ? { hostCapturedAgentType: attestation.hostCapturedAgentType }
      : {}),
    ...(attestation.hostCaptureSource ? { hostCaptureSource: attestation.hostCaptureSource } : {}),
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

async function recordManualReviewInvocation(input: {
  result: StartedReviewResult;
  obligation: ReviewObligation;
  exec: ReviewExecutionContext;
  childSessionId: string;
  findingsHash: string;
  assurance: ReturnType<typeof ensureReviewAssurance>;
  sessDir: string;
}): Promise<{
  result: StartedReviewResult;
  blocked?: string;
  nativeAttestationRejection?: NativeAttestationRejection;
}> {
  const { result, obligation, exec, childSessionId, findingsHash, assurance, sessDir } = input;
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
  if (childSessionId === exec.context.sessionID) {
    return {
      result,
      blocked: formatBlockedWithAttestation(
        'REVIEW_SELF_APPROVAL_DENIED',
        'Manual-attested review findings must come from a different reviewer session than the governed parent session.',
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
  const attestation = await resolveNativeAttestation({
    sessDir,
    obligationId: obligation.obligationId,
    sessionId: exec.context.sessionID,
  });
  return {
    result: buildManualInvocationState({
      result,
      obligation,
      context: exec.context,
      childSessionId,
      findingsHash,
      promptHash: hashText(fingerprintReviewInput(exec.args)),
      now: exec.now,
      attestation,
    }),
    ...(attestation.rejection ? { nativeAttestationRejection: attestation.rejection } : {}),
  };
}

export async function recordSubmittedReviewInvocation(
  result: StartedReviewResult,
  obligation: ReviewObligation,
  exec: ReviewExecutionContext,
  sessDir: string,
): Promise<{
  result: StartedReviewResult;
  blocked?: string;
  nativeAttestationRejection?: NativeAttestationRejection;
}> {
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
    sessDir,
  });
}
