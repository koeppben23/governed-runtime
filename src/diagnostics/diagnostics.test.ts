import { describe, expect, it } from 'vitest';

import { buildBlockedDiagnostics, formatDiagnosticCard } from './index.js';

describe('runtime diagnostics', () => {
  it('HAPPY: builds host-task evidence diagnostics with actionable recovery', () => {
    const diagnostics = buildBlockedDiagnostics('HOST_SUBAGENT_TASK_REQUIRED', {
      obligationId: 'rev-ob-123',
      bindOutcome: 'no_bindable_findings',
      policyMode: 'host_task_required',
    });

    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.diagnosticCode).toBe('REVIEW_HOST_TASK_EVIDENCE_MISSING');
    expect(diagnostics?.rootCause).toContain('host-visible');
    expect(diagnostics?.observed).toContain('obligationId=rev-ob-123');
    expect(diagnostics?.required).toContain(
      'host-visible Task invocation by the FlowGuard reviewer subagent',
    );
    expect(diagnostics?.missingEvidence).toContain('host_subagent_task_invocation');
    expect(diagnostics?.safeNextActions.join('\n')).toContain('Do not submit manual');
  });

  it('BAD: returns null for unknown codes instead of inventing authority', () => {
    expect(buildBlockedDiagnostics('UNKNOWN_CODE', { reason: 'unknown' })).toBeNull();
  });

  it('BAD: does not claim missing host evidence without bind evidence context', () => {
    const diagnostics = buildBlockedDiagnostics('HOST_SUBAGENT_TASK_REQUIRED', {
      reason: 'review invocation blocked by policy',
    });

    expect(diagnostics?.diagnosticCode).toBe('REVIEW_HOST_TASK_EVIDENCE_MISSING');
    expect(diagnostics?.missingEvidence).toBeUndefined();
  });

  it('CORNER: builds enforcement-unavailable diagnostics with sparse detail', () => {
    const diagnostics = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE');

    expect(diagnostics?.diagnosticCode).toBe('RUNTIME_ENFORCEMENT_CONTEXT_UNAVAILABLE');
    expect(diagnostics?.observed).toEqual([]);
    expect(diagnostics?.required).toContain('readable FlowGuard session state');
  });

  it('EDGE: preserves state-readability detail without changing the block code', () => {
    const diagnostics = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      stateFile: '/tmp/session-state.json',
      stateReadable: 'false',
      error: 'EACCES',
    });

    expect(diagnostics?.observed).toContain('stateFile=/tmp/session-state.json');
    expect(diagnostics?.observed).toContain('stateReadable=false');
    expect(diagnostics?.missingEvidence).toContain('readable_session_state');
  });

  it('EDGE: does not invent strict orchestration missing evidence from generic failures', () => {
    const diagnostics = buildBlockedDiagnostics('STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'reviewer response did not match ReviewFindings schema',
    });

    expect(diagnostics?.diagnosticCode).toBe('STRICT_REVIEW_ORCHESTRATION_FAILED');
    expect(diagnostics?.missingEvidence).toBeUndefined();
    expect(diagnostics?.required).toContain('parseable reviewer output');
  });

  it('SMOKE: formats a deterministic human-readable failure card', () => {
    const diagnostics = buildBlockedDiagnostics('SUBAGENT_EVIDENCE_REUSED', {
      invocationId: 'inv-1',
      consumedBy: 'rev-ob-old',
    });

    expect(diagnostics).not.toBeNull();
    const card = formatDiagnosticCard({
      code: 'SUBAGENT_EVIDENCE_REUSED',
      message: 'Evidence reused.',
      diagnostics: diagnostics!,
    });

    expect(card).toContain('FlowGuard blocked this action.');
    expect(card).toContain('Root cause:');
    expect(card).toContain('invocationId=inv-1');
    expect(card).toContain('Do not reuse ReviewFindings');
  });
});

describe('diagnostics — full builder coverage', () => {
  it('HOST_TOOL_PHASE_DENIED with default fallbacks', () => {
    const d = buildBlockedDiagnostics('HOST_TOOL_PHASE_DENIED');
    expect(d?.diagnosticCode).toBe('HOST_TOOL_MUTATION_DENIED_IN_PHASE');
    expect(d?.rootCause).toContain('mutating');
    expect(d?.required).toContain('read-only investigation tools in this phase');
  });

  it('HOST_TOOL_PHASE_DENIED with all detail fields', () => {
    const d = buildBlockedDiagnostics('HOST_TOOL_PHASE_DENIED', {
      tool: 'Bash',
      phase: 'PLAN',
      policyMode: 'regulated',
    });
    expect(d?.command).toBe('Bash');
    expect(d?.phase).toBe('PLAN');
    expect(d?.observed).toContain('tool=Bash');
    expect(d?.policyMode).toBe('regulated');
  });

  it('HOST_SUBAGENT_TASK_REQUIRED with bind outcome detail', () => {
    const d = buildBlockedDiagnostics('HOST_SUBAGENT_TASK_REQUIRED', {
      obligationId: 'ob-bind',
      bindOutcome: 'bindable',
      reviewerSubagentType: 'flowguard-reviewer',
      phase: 'IMPL_REVIEW',
      policyMode: 'regulated',
    });
    expect(d?.diagnosticCode).toBe('REVIEW_HOST_TASK_EVIDENCE_MISSING');
    expect(d?.observed).toContain('obligationId=ob-bind');
    expect(d?.observed).toContain('bindOutcome=bindable');
    expect(d?.observed).toContain('reviewerSubagentType=flowguard-reviewer');
    expect(d?.phase).toBe('IMPL_REVIEW');
  });

  it('HOST_SUBAGENT_TASK_REQUIRED with no bindOutcome omits missingEvidence', () => {
    const d = buildBlockedDiagnostics('HOST_SUBAGENT_TASK_REQUIRED', {
      reason: 'no reviewer available',
    });
    expect(d?.missingEvidence).toBeUndefined();
    expect(d?.rootCause).toBe('no reviewer available');
  });

  it('SUBAGENT_EVIDENCE_MISSING with detail', () => {
    const d = buildBlockedDiagnostics('SUBAGENT_EVIDENCE_MISSING', {
      obligationId: 'ob-1',
      invocationId: 'inv-2',
    });
    expect(d?.diagnosticCode).toBe('REVIEW_INVOCATION_EVIDENCE_MISSING');
    expect(d?.observed).toContain('obligationId=ob-1');
    expect(d?.missingEvidence).toContain('review_invocation_evidence');
  });

  it('SUBAGENT_EVIDENCE_REUSED with all detail', () => {
    const d = buildBlockedDiagnostics('SUBAGENT_EVIDENCE_REUSED', {
      invocationId: 'inv-5',
      consumedBy: 'ob-old',
      obligationId: 'ob-new',
    });
    expect(d?.diagnosticCode).toBe('REVIEW_INVOCATION_EVIDENCE_REUSED');
    expect(d?.observed).toContain('invocationId=inv-5');
    expect(d?.observed).toContain('consumedBy=ob-old');
  });

  it('STRICT_REVIEW_ORCHESTRATION_FAILED with blocked code', () => {
    const d = buildBlockedDiagnostics('STRICT_REVIEW_ORCHESTRATION_FAILED', {
      obligationId: 'ob-x',
      code: 'REVIEWER_SESSION_MISMATCH',
    });
    expect(d?.observed).toContain('obligationId=ob-x');
    expect(d?.observed).toContain('blockedCode=REVIEWER_SESSION_MISMATCH');
  });

  it('PLUGIN_ENFORCEMENT_UNAVAILABLE with plugin inactive detail', () => {
    const d = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      pluginActive: 'false',
    });
    expect(d?.missingEvidence).toContain('active_flowguard_plugin');
  });

  it('PLUGIN_ENFORCEMENT_UNAVAILABLE with all detail', () => {
    const d = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      tool: '/review',
      phase: 'PLAN_REVIEW',
      policyMode: 'team',
      sessionId: 'ses-1',
      stateFile: '/tmp/ss.json',
      stateReadable: 'false',
      auditReadable: 'false',
      error: 'EACCES',
      reason: 'Cannot read state',
      required: 'session-state.json',
    });
    expect(d?.command).toBe('/review');
    expect(d?.phase).toBe('PLAN_REVIEW');
    expect(d?.policyMode).toBe('team');
    expect(d?.rootCause).toBe('Cannot read state');
    expect(d?.observed).toContain('sessionId=ses-1');
    expect(d?.observed).toContain('stateFile=/tmp/ss.json');
    expect(d?.observed).toContain('stateReadable=false');
    expect(d?.observed).toContain('auditReadable=false');
    expect(d?.observed).toContain('error=EACCES');
    expect(d?.required).toContain('required=session-state.json');
    expect(d?.missingEvidence).toContain('readable_session_state');
  });

  it('unknown code returns null', () => {
    expect(buildBlockedDiagnostics('SOME_RANDOM_CODE')).toBeNull();
    expect(buildBlockedDiagnostics('')).toBeNull();
  });
});
