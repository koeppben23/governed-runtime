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

/**
 * Optional diagnostic context is OMITTED when absent — never present as an
 * explicit `undefined`, so diagnostics keep one representation of "no value".
 */
function optionalContextFields(
  detail: DiagnosticDetail,
): Pick<RuntimeDiagnostics, 'phase' | 'policyMode'> {
  const phase = optionalField(detail.phase);
  const policyMode = optionalField(detail.policyMode);
  return {
    ...(phase !== undefined ? { phase } : {}),
    ...(policyMode !== undefined ? { policyMode } : {}),
  };
}

function enforcementObserved(detail: DiagnosticDetail): string[] {
  return clean([
    optionalField(detail.sessionId) ? `sessionId=${detail.sessionId}` : undefined,
    optionalField(detail.stateFile) ? `stateFile=${detail.stateFile}` : undefined,
    optionalField(detail.stateReadable) ? `stateReadable=${detail.stateReadable}` : undefined,
    optionalField(detail.auditReadable) ? `auditReadable=${detail.auditReadable}` : undefined,
    optionalField(detail.error) ? `error=${detail.error}` : undefined,
  ]);
}

function enforcementRequired(detail: DiagnosticDetail): string[] {
  const required = optionalField(detail.required);
  return clean([
    required ? `required=${required}` : 'readable FlowGuard session state',
    'active plugin enforcement context',
  ]);
}

function enforcementMissingEvidence(detail: DiagnosticDetail): string[] {
  return clean([
    detail.stateReadable === 'false' ? 'readable_session_state' : undefined,
    detail.pluginActive === 'false' ? 'active_flowguard_plugin' : undefined,
  ]);
}

function enforcementUnavailable(detail: DiagnosticDetail): RuntimeDiagnostics {
  const command = optionalField(detail.tool) ?? optionalField(detail.command);
  const deniedReviewPath = optionalField(detail.deniedReviewPath);
  return {
    diagnosticCode: 'RUNTIME_ENFORCEMENT_CONTEXT_UNAVAILABLE',
    severity: 'error',
    ...(command !== undefined ? { command } : {}),
    ...optionalContextFields(detail),
    rootCause:
      optionalField(detail.reason) ??
      'FlowGuard could not verify the enforcement context required for this action.',
    observed: enforcementObserved(detail),
    required: enforcementRequired(detail),
    missingEvidence: enforcementMissingEvidence(detail),
    safeNextActions: [
      'Run flowguard doctor to verify the installation and plugin activation.',
      'Inspect session directory and session-state.json permissions.',
      'Re-run /hydrate after fixing workspace or session state issues.',
    ],
    ...(deniedReviewPath !== undefined ? { deniedReviewPath } : {}),
  };
}

function sessionDirMissing(detail: DiagnosticDetail): RuntimeDiagnostics {
  const tool = optionalField(detail.tool) ?? optionalField(detail.command) ?? 'host tool';
  const sessDir = optionalField(detail.sessDir);
  return {
    diagnosticCode: 'SESSION_DIRECTORY_MISSING',
    severity: 'error',
    command: tool,
    ...optionalContextFields(detail),
    rootCause:
      'FlowGuard had a session directory from the workspace context, but the directory no longer exists on disk.',
    observed: clean([
      optionalField(detail.sessionId) ? `sessionId=${detail.sessionId}` : undefined,
      sessDir ? `sessDir=${sessDir}` : undefined,
      optionalField(detail.stateReadable) ? `stateReadable=${detail.stateReadable}` : undefined,
    ]),
    required: clean([
      'existing FlowGuard session directory on disk',
      sessDir ? `expected directory: ${sessDir}` : 'expected session directory',
    ]),
    missingEvidence: clean([
      detail.stateReadable === 'false' ? 'readable_session_state' : undefined,
      'existing_session_directory',
    ]),
    safeNextActions: [
      'Run /hydrate to recreate or bind a valid FlowGuard session.',
      'Verify the workspace/session directory exists and is writable.',
      'Restart OpenCode if the sidecar session points to stale workspace state.',
    ],
  };
}

function hostToolPhaseDenied(detail: DiagnosticDetail): RuntimeDiagnostics {
  const tool = optionalField(detail.tool) ?? optionalField(detail.command) ?? 'mutating host tool';
  const phase = optionalField(detail.phase) ?? 'current phase';
  const policyMode = optionalField(detail.policyMode);
  return {
    diagnosticCode: 'HOST_TOOL_MUTATION_DENIED_IN_PHASE',
    severity: 'error',
    command: tool,
    phase,
    ...(policyMode !== undefined ? { policyMode } : {}),
    rootCause: `${tool} is mutating and is not allowed while FlowGuard is in ${phase}.`,
    observed: clean([`tool=${tool}`, `phase=${phase}`]),
    required: [
      'read-only tools outside IMPLEMENTATION',
      'IMPLEMENTATION phase before mutating host tools',
    ],
    safeNextActions: [
      'Use read-only tools such as read, glob, or grep outside IMPLEMENTATION.',
      'Return to the IMPLEMENTATION phase before mutating files.',
    ],
  };
}

function riskClassificationBlocked(detail: DiagnosticDetail): RuntimeDiagnostics {
  const command = optionalField(detail.tool) ?? optionalField(detail.command);
  return {
    diagnosticCode: 'RISK_CLASSIFICATION_GATE_BLOCKED',
    severity: 'error',
    ...(command !== undefined ? { command } : {}),
    ...optionalContextFields(detail),
    rootCause:
      optionalField(detail.reason) ??
      'Runtime evidence does not satisfy the claimed task risk classification.',
    observed: clean([
      optionalField(detail.sessionId) ? `sessionId=${detail.sessionId}` : undefined,
      optionalField(detail.claimedTaskClass)
        ? `claimedTaskClass=${detail.claimedTaskClass}`
        : undefined,
      optionalField(detail.minimumTaskClass)
        ? `minimumTaskClass=${detail.minimumTaskClass}`
        : undefined,
      optionalField(detail.touchedSurface) ? `touchedSurface=${detail.touchedSurface}` : undefined,
      optionalField(detail.decisionId) ? `decisionId=${detail.decisionId}` : undefined,
    ]),
    required: ['claimed task class greater than or equal to runtime-computed minimum'],
    missingEvidence: clean([
      detail.claimedTaskClass === 'missing' ? 'claimed_task_class' : undefined,
      detail.stateReadable === 'false' ? 'readable_session_state' : undefined,
    ]),
    safeNextActions: [
      'Reclassify the task at the runtime-required risk level.',
      'Start a fresh governed session if the existing risk gate is blocked.',
    ],
  };
}

function hostTaskSchemaInvalid(detail: DiagnosticDetail): RuntimeDiagnostics {
  return {
    diagnosticCode: 'REVIEWER_FINDINGS_SCHEMA_INVALID',
    severity: 'error',
    ...optionalContextFields(detail),
    rootCause:
      optionalField(detail.reason) ??
      optionalField(detail.message) ??
      'The reviewer completed, but its ReviewFindings output failed canonical schema validation.',
    observed: clean([
      optionalField(detail.obligationId) ? `obligationId=${detail.obligationId}` : undefined,
      optionalField(detail.bindOutcome) ? `bindOutcome=${detail.bindOutcome}` : undefined,
      optionalField(detail.schemaErrors) ? `schemaErrors=${detail.schemaErrors}` : undefined,
      optionalField(detail.reviewerSubagentType)
        ? `reviewerSubagentType=${detail.reviewerSubagentType}`
        : undefined,
    ]),
    required: [
      'one schema-valid canonical ReviewFindings object from the completed reviewer session',
      'ReviewFindings bound to the active review obligation',
      'matching mandateDigest and criteriaVersion',
    ],
    missingEvidence: ['schema_valid_review_findings'],
    safeNextActions: [
      'Re-run the originating FlowGuard command to authorize a fresh output-repair attempt.',
      'Follow the returned recovery steps; do not retry or reconstruct the rejected reviewer output yourself.',
      'Do NOT hand-edit, copy, or submit the rejected reviewFindings.',
    ],
  };
}

function subagentEvidenceMissing(detail: DiagnosticDetail): RuntimeDiagnostics {
  const obligationId = optionalField(detail.obligationId);
  return {
    diagnosticCode: 'REVIEW_INVOCATION_EVIDENCE_MISSING',
    severity: 'error',
    ...optionalContextFields(detail),
    rootCause:
      optionalField(detail.reason) ??
      'Review findings could not be bound to trusted reviewer invocation evidence.',
    observed: clean([
      obligationId ? `obligationId=${detail.obligationId}` : undefined,
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
    ...optionalContextFields(detail),
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
    ...optionalContextFields(detail),
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

const BLOCKED_DIAGNOSTIC_BUILDERS: ReadonlyMap<
  string,
  (detail: DiagnosticDetail) => RuntimeDiagnostics
> = new Map([
  ['PLUGIN_ENFORCEMENT_UNAVAILABLE', enforcementUnavailable],
  ['SESSION_DIR_NOT_FOUND', sessionDirMissing],
  ['HOST_TOOL_PHASE_DENIED', hostToolPhaseDenied],
  ['RISK_CLASSIFICATION_MISMATCH', riskClassificationBlocked],
  ['RISK_CLASSIFICATION_REQUIRED', riskClassificationBlocked],
  ['RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', riskClassificationBlocked],
  ['RISK_GATE_BLOCKED', riskClassificationBlocked],
  ['RISK_DOWNGRADE_OVERRIDE_DENIED', riskClassificationBlocked],
  ['ENVELOPE_SCHEMA_INVALID', hostTaskSchemaInvalid],
  ['SUBAGENT_EVIDENCE_MISSING', subagentEvidenceMissing],
  ['SUBAGENT_EVIDENCE_REUSED', subagentEvidenceReused],
  ['STRICT_REVIEW_ORCHESTRATION_FAILED', strictReviewOrchestrationFailed],
]);

export function buildBlockedDiagnostics(
  code: string,
  detail: DiagnosticDetail = {},
): RuntimeDiagnostics | null {
  const builder = BLOCKED_DIAGNOSTIC_BUILDERS.get(code);
  return builder ? builder(detail) : null;
}
