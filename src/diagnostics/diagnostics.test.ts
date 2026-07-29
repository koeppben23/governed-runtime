/**
 * @module diagnostics/diagnostics.test
 * @description Builder/domain tests (preserved) + golden fixture + projection tests.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildBlockedDiagnostics, formatDiagnosticCard } from './index.js';
import { buildBlockedDiagnosticDocument } from './format-card.js';
import { renderMarkdown } from '../presentation/markdown.js';
import type { RuntimeDiagnostics } from './types.js';

async function readGolden(name: string): Promise<string> {
  const p = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return (await readFile(p, 'utf-8')).trimEnd();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Builder / domain tests — preserved from original file
// ═══════════════════════════════════════════════════════════════════════════════

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

  it('EDGE: surfaces the denied review-acceptance path when provided (#419)', () => {
    const diagnostics = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      deniedReviewPath: 'native',
    });

    expect(diagnostics?.deniedReviewPath).toBe('native');
  });

  it('EDGE: omits the denied review-acceptance path when absent (#419)', () => {
    const diagnostics = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE');

    expect(diagnostics?.deniedReviewPath).toBeUndefined();
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
    expect(diagnostics?.required).toContain('expected directory: /tmp/ws/fp/ses-abc');
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

// ═══════════════════════════════════════════════════════════════════════════════
// Golden fixture tests — via real producers
// ═══════════════════════════════════════════════════════════════════════════════

describe('diagnostic golden fixtures', () => {
  it('diagnostic-gate-policy matches golden output', async () => {
    const d = buildBlockedDiagnostics('HOST_TOOL_PHASE_DENIED', {
      phase: 'PLAN_REVIEW',
      command: '/plan',
      policyMode: 'team',
      reason: 'Plan review is required before execution.',
    });
    const out = formatDiagnosticCard({
      code: 'HOST_TOOL_PHASE_DENIED',
      message: 'Plan review is required.',
      diagnostics: d!,
    });
    const golden = await readGolden('diagnostic-gate-policy.md');
    expect(out).toBe(golden);
  });

  it('diagnostic-enforcement-unavailable matches golden output', async () => {
    const d = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: 'Required evidence slots are missing.',
    });
    const out = formatDiagnosticCard({
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      message: 'Required evidence is missing.',
      diagnostics: d!,
    });
    const golden = await readGolden('diagnostic-enforcement-unavailable.md');
    expect(out).toBe(golden);
  });

  it('diagnostic-review-deny matches golden output', async () => {
    const d = buildBlockedDiagnostics('STRICT_REVIEW_ORCHESTRATION_FAILED', {
      phase: 'PLAN_REVIEW',
      policyMode: 'regulated',
      reason: 'Review was denied at plan-reviewer-iteration-3.',
      obligationId: 'oblig-plan-reviewer-3',
      code: 'REVIEW_DENIED',
    });
    const out = formatDiagnosticCard({
      code: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
      message: 'Review returned with blocking issues.',
      diagnostics: d!,
    });
    const golden = await readGolden('diagnostic-review-deny.md');
    expect(out).toBe(golden);
  });

  it('diagnostic-minimal matches golden output', async () => {
    const d: RuntimeDiagnostics = {
      diagnosticCode: 'MINIMAL',
      severity: 'error',
      rootCause: '',
      observed: [],
      required: [],
      missingEvidence: [],
      safeNextActions: [],
    };
    const out = formatDiagnosticCard({
      code: 'MINIMAL',
      message: 'Minimal diagnostic test.',
      diagnostics: d,
    });
    const golden = await readGolden('diagnostic-minimal.md');
    expect(out).toBe(golden);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Projection / formatter tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildBlockedDiagnosticDocument', () => {
  it('produces diagnostic_card kind', () => {
    const d = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE')!;
    const doc = buildBlockedDiagnosticDocument({
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      message: 'Test.',
      diagnostics: d,
    });
    expect(doc.kind).toBe('diagnostic_card');
  });

  it('does not include a conclusion', () => {
    const d = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE')!;
    const doc = buildBlockedDiagnosticDocument({
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      message: 'Test.',
      diagnostics: d,
    });
    expect(doc.conclusion).toMatchObject({ kind: 'recovery' });
  });

  it('always includes root cause even when empty', () => {
    const out = formatDiagnosticCard({
      code: 'TEST',
      message: 'Test.',
      diagnostics: {
        diagnosticCode: 'T',
        severity: 'error',
        rootCause: '',
        observed: [],
        required: [],
        missingEvidence: [],
        safeNextActions: [],
      },
    });
    expect(out).toContain('Root cause');
  });

  it('formatDiagnosticCard returns string from shared renderer', () => {
    const d = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE')!;
    const out = formatDiagnosticCard({
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      message: 'Test.',
      diagnostics: d,
    });
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).not.toBe('\n');
    expect(out[out.length - 1]).not.toBe('\n');
  });

  it('wraps reason code in backticks', () => {
    const d = buildBlockedDiagnostics('HOST_TOOL_PHASE_DENIED', {
      reason: 'Denied.',
    })!;
    const out = formatDiagnosticCard({
      code: 'HOST_TOOL_PHASE_DENIED',
      message: 'Denied.',
      diagnostics: d,
    });
    expect(out).toContain('`HOST_TOOL_PHASE_DENIED`');
  });
});
