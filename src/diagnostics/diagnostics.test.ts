/**
 * @module diagnostics/diagnostics.test
 * @description Golden fixture + projection tests for diagnostic formatting.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildBlockedDiagnostics } from './builders.js';
import { formatDiagnosticCard, buildBlockedDiagnosticDocument } from './format-card.js';
import { renderMarkdown } from '../presentation/markdown.js';
import type { RuntimeDiagnostics } from './types.js';

function diag(overrides: Partial<RuntimeDiagnostics> = {}): RuntimeDiagnostics {
  return {
    diagnosticCode: 'TEST_001',
    severity: 'error',
    rootCause: 'No ticket evidence recorded.',
    observed: [],
    required: ['ticket', 'plan'],
    missingEvidence: [],
    safeNextActions: ['/ticket', '/status'],
    ...overrides,
  };
}

async function readGolden(name: string): Promise<string> {
  const p = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return readFile(p, 'utf-8');
}

// ─── Golden Fixture Tests ────────────────────────────────────────────────────────

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

  it('diagnostic-evidence matches golden output', async () => {
    const d = buildBlockedDiagnostics('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: 'Required evidence slots are missing.',
    });
    const out = formatDiagnosticCard({
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      message: 'Required evidence is missing.',
      diagnostics: d!,
    });
    const golden = await readGolden('diagnostic-evidence.md');
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
    // Synthetic minimal case — no real producer exists for fully empty diagnostics.
    // This tests the formatter contract for degenerate input.
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

// ─── Projection Tests ────────────────────────────────────────────────────────────

describe('buildBlockedDiagnosticDocument', () => {
  it('produces diagnostic_card kind', () => {
    const d = diag();
    const doc = buildBlockedDiagnosticDocument({ code: 'TEST', message: 'Test.', diagnostics: d });
    expect(doc.kind).toBe('diagnostic_card');
  });

  it('does not include a conclusion', () => {
    const d = diag();
    const doc = buildBlockedDiagnosticDocument({ code: 'TEST', message: 'Test.', diagnostics: d });
    expect(doc.conclusion).toBeUndefined();
  });

  it('always includes root cause even when empty', () => {
    const d = diag({ rootCause: '' });
    const out = formatDiagnosticCard({ code: 'TEST', message: 'Test.', diagnostics: d });
    expect(out).toContain('Root cause');
  });

  it('omits observed section when empty', () => {
    const d = diag({ observed: [] });
    const out = formatDiagnosticCard({ code: 'TEST', message: 'Test.', diagnostics: d });
    expect(out).not.toContain('## Observed');
  });

  it('includes observed section when non-empty', () => {
    const d = diag({ observed: ['Item 1', 'Item 2'] });
    const out = formatDiagnosticCard({ code: 'TEST', message: 'Test.', diagnostics: d });
    expect(out).toContain('## Observed');
    expect(out).toContain('• Item 1');
  });

  it('includes missing evidence section when set', () => {
    const d = diag({ missingEvidence: ['Slot A', 'Slot B'] });
    const out = formatDiagnosticCard({ code: 'TEST', message: 'Test.', diagnostics: d });
    expect(out).toContain('## Missing evidence');
  });

  it('formatDiagnosticCard returns string from shared renderer', () => {
    const d = diag();
    const out = formatDiagnosticCard({ code: 'TEST', message: 'Test.', diagnostics: d });
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // No leading/trailing newline
    expect(out[0]).not.toBe('\n');
    expect(out[out.length - 1]).not.toBe('\n');
  });

  it('wraps reason code in backticks in blocker section', () => {
    const d = diag();
    const out = formatDiagnosticCard({
      code: 'TEST_CODE',
      message: 'Test message.',
      diagnostics: d,
    });
    expect(out).toContain('`TEST_CODE`');
  });
});
