/**
 * @module diagnostics/builders
 * @description Pure diagnostic builders for FlowGuard blocked/error results.
 *
 * These builders derive operator-facing explanations from already-authoritative
 * reason codes and caller-supplied detail. They MUST remain side-effect free and
 * MUST NOT read state, policy, evidence, audit trails, or the filesystem.
 */

import type { RuntimeDiagnostics } from './types.js';

type DiagnosticDetail = Readonly<Record<string, string | undefined>>;

function clean(values: readonly (string | undefined | null | false)[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function optionalField(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function enforcementUnavailable(detail: DiagnosticDetail): RuntimeDiagnostics {
  const stateFile = optionalField(detail.stateFile);
  const required = optionalField(detail.required);
  return {
    diagnosticCode: 'RUNTIME_ENFORCEMENT_CONTEXT_UNAVAILABLE',
    severity: 'error',
    command: optionalField(detail.tool) ?? optionalField(detail.command),
    phase: optionalField(detail.phase),
    policyMode: optionalField(detail.policyMode),
    rootCause:
      optionalField(detail.reason) ??
      'FlowGuard could not verify the enforcement context required for this action.',
    observed: clean([
      optionalField(detail.sessionId) ? `sessionId=${detail.sessionId}` : undefined,
      stateFile ? `stateFile=${stateFile}` : undefined,
      optionalField(detail.stateReadable) ? `stateReadable=${detail.stateReadable}` : undefined,
      optionalField(detail.auditReadable) ? `auditReadable=${detail.auditReadable}` : undefined,
      optionalField(detail.error) ? `error=${detail.error}` : undefined,
    ]),
    required: clean([
      required ? `required=${required}` : 'readable FlowGuard session state',
      'active plugin enforcement context',
    ]),
    missingEvidence: clean([
      detail.stateReadable === 'false' ? 'readable_session_state' : undefined,
      detail.pluginActive === 'false' ? 'active_flowguard_plugin' : undefined,
    ]),
    safeNextActions: [
      'Run flowguard doctor to verify the installation and plugin activation.',
      'Inspect session directory and session-state.json permissions.',
      'Re-run /hydrate after fixing workspace or session state issues.',
    ],
  };
}

function hostToolPhaseDenied(detail: DiagnosticDetail): RuntimeDiagnostics {
  const tool = optionalField(detail.tool) ?? optionalField(detail.command) ?? 'mutating host tool';
  const phase = optionalField(detail.phase) ?? 'current investigation phase';
  return {
    diagnosticCode: 'HOST_TOOL_MUTATION_DENIED_IN_PHASE',
    severity: 'error',
    command: tool,
    phase,
    policyMode: optionalField(detail.policyMode),
    rootCause: `${tool} is mutating and is not allowed while FlowGuard is in ${phase}.`,
    observed: clean([`tool=${tool}`, `phase=${phase}`]),
    required: [
      'read-only investigation tools in this phase',
      'implementation phase before mutating host tools',
    ],
    safeNextActions: [
      'Use read-only tools such as read, glob, or grep while investigating.',
      'Advance the FlowGuard workflow to the implementation phase before mutating files.',
    ],
  };
}

function hostSubagentTaskRequired(detail: DiagnosticDetail): RuntimeDiagnostics {
  const obligationId = optionalField(detail.obligationId);
  const bindOutcome = optionalField(detail.bindOutcome);
  return {
    diagnosticCode: 'REVIEW_HOST_TASK_EVIDENCE_MISSING',
    severity: 'error',
    phase: optionalField(detail.phase),
    policyMode: optionalField(detail.policyMode) ?? 'host_task_required',
    rootCause:
      optionalField(detail.reason) ??
      'Policy requires host-visible reviewer Task evidence, but no bindable evidence was found.',
    observed: clean([
      obligationId ? `obligationId=${obligationId}` : undefined,
      optionalField(detail.bindOutcome) ? `bindOutcome=${detail.bindOutcome}` : undefined,
      optionalField(detail.reviewerSubagentType)
        ? `reviewerSubagentType=${detail.reviewerSubagentType}`
        : undefined,
    ]),
    required: [
      'host-visible Task invocation by the FlowGuard reviewer subagent',
      'ReviewFindings bound to the active review obligation',
      'matching mandateDigest and criteriaVersion',
    ],
    ...(bindOutcome
      ? { missingEvidence: ['host_subagent_task_invocation', 'review_findings_attestation'] }
      : {}),
    safeNextActions: [
      'Run the FlowGuard reviewer subagent via the OpenCode Task tool.',
      'Submit the complete ReviewFindings object returned by the reviewer.',
      'Do not submit manual or self-review findings in host_task_required mode.',
    ],
  };
}

function subagentEvidenceMissing(detail: DiagnosticDetail): RuntimeDiagnostics {
  const obligationId = optionalField(detail.obligationId);
  return {
    diagnosticCode: 'REVIEW_INVOCATION_EVIDENCE_MISSING',
    severity: 'error',
    phase: optionalField(detail.phase),
    policyMode: optionalField(detail.policyMode),
    rootCause:
      optionalField(detail.reason) ??
      'Review findings could not be bound to trusted reviewer invocation evidence.',
    observed: clean([
      obligationId ? `obligationId=${obligationId}` : undefined,
      optionalField(detail.invocationId) ? `invocationId=${detail.invocationId}` : undefined,
    ]),
    required: [
      'matching ReviewInvocationEvidence for the active obligation',
      'matching reviewer session, findings hash, mandate, and criteria where required',
    ],
    missingEvidence: ['review_invocation_evidence'],
    safeNextActions: [
      'Re-run the reviewer subagent with the required review context.',
      'Submit ReviewFindings that include the provided obligation and attestation values.',
    ],
  };
}

function subagentEvidenceReused(detail: DiagnosticDetail): RuntimeDiagnostics {
  return {
    diagnosticCode: 'REVIEW_INVOCATION_EVIDENCE_REUSED',
    severity: 'error',
    phase: optionalField(detail.phase),
    policyMode: optionalField(detail.policyMode),
    rootCause: 'Reviewer invocation evidence has already been consumed by another obligation.',
    observed: clean([
      optionalField(detail.invocationId) ? `invocationId=${detail.invocationId}` : undefined,
      optionalField(detail.consumedBy) ? `consumedBy=${detail.consumedBy}` : undefined,
      optionalField(detail.obligationId) ? `obligationId=${detail.obligationId}` : undefined,
    ]),
    required: ['fresh reviewer invocation evidence for each review obligation'],
    missingEvidence: ['fresh_review_invocation_evidence'],
    safeNextActions: [
      'Re-run the reviewer subagent for the active obligation.',
      'Do not reuse ReviewFindings or invocation evidence from a prior obligation.',
    ],
  };
}

function strictReviewOrchestrationFailed(detail: DiagnosticDetail): RuntimeDiagnostics {
  return {
    diagnosticCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
    severity: 'error',
    phase: optionalField(detail.phase),
    policyMode: optionalField(detail.policyMode),
    rootCause:
      optionalField(detail.reason) ??
      optionalField(detail.code) ??
      'Strict review orchestration failed before FlowGuard could record trusted review evidence.',
    observed: clean([
      optionalField(detail.obligationId) ? `obligationId=${detail.obligationId}` : undefined,
      optionalField(detail.code) ? `blockedCode=${detail.code}` : undefined,
    ]),
    required: [
      'parseable reviewer output',
      'valid strict attestation',
      'bindable review invocation evidence',
    ],
    safeNextActions: [
      'Re-run the FlowGuard command to create a fresh review obligation and retry orchestration.',
      'Run flowguard doctor if orchestration failures repeat.',
    ],
  };
}

export function buildBlockedDiagnostics(
  code: string,
  detail: DiagnosticDetail = {},
): RuntimeDiagnostics | null {
  switch (code) {
    case 'PLUGIN_ENFORCEMENT_UNAVAILABLE':
      return enforcementUnavailable(detail);
    case 'HOST_TOOL_PHASE_DENIED':
      return hostToolPhaseDenied(detail);
    case 'HOST_SUBAGENT_TASK_REQUIRED':
      return hostSubagentTaskRequired(detail);
    case 'SUBAGENT_EVIDENCE_MISSING':
      return subagentEvidenceMissing(detail);
    case 'SUBAGENT_EVIDENCE_REUSED':
      return subagentEvidenceReused(detail);
    case 'STRICT_REVIEW_ORCHESTRATION_FAILED':
      return strictReviewOrchestrationFailed(detail);
    default:
      return null;
  }
}
