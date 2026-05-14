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

  it('HAPPY: builds session-directory-missing diagnostics with actionable recovery', () => {
    const diagnostics = buildBlockedDiagnostics('SESSION_DIR_NOT_FOUND', {
      sessionId: 'ses-abc',
      tool: 'bash',
      sessDir: '/tmp/ws/fp/ses-abc',
      stateReadable: 'false',
    });

    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.diagnosticCode).toBe('SESSION_DIRECTORY_MISSING');
    expect(diagnostics?.rootCause).toContain(
      'session directory from the workspace context, but the directory no longer exists',
    );
    expect(diagnostics?.observed).toContain('sessionId=ses-abc');
    expect(diagnostics?.observed).toContain('sessDir=/tmp/ws/fp/ses-abc');
    expect(diagnostics?.required).toContain(
      'expected directory: /tmp/ws/fp/ses-abc',
    );
    expect(diagnostics?.missingEvidence).toContain('existing_session_directory');
    expect(diagnostics?.safeNextActions).toContain(
      'Run /hydrate to recreate or bind a valid FlowGuard session.',
    );
  });

  it('HAPPY: builds session-directory-missing diagnostics with sparse detail (no crash)', () => {
    const diagnostics = buildBlockedDiagnostics('SESSION_DIR_NOT_FOUND');

    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.diagnosticCode).toBe('SESSION_DIRECTORY_MISSING');
    expect(diagnostics?.observed).toEqual([]);
    expect(diagnostics?.safeNextActions).toContain(
      'Run /hydrate to recreate or bind a valid FlowGuard session.',
    );
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
