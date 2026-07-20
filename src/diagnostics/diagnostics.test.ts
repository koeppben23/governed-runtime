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
    const d = diag({
      diagnosticCode: 'POLICY_DENIAL',
      phase: 'PLAN_REVIEW',
      command: '/plan',
      policyMode: 'team',
      rootCause: 'Policy requires plan review before execution.',
      observed: ['Phase: PLAN_REVIEW', 'Command: /plan'],
      required: ['Approved plan review'],
      safeNextActions: ['/review-decision', '/continue'],
    });
    const out = formatDiagnosticCard({
      code: 'POLICY_DENIAL',
      message: 'Plan review is required.',
      diagnostics: d,
    });
    const golden = await readGolden('diagnostic-gate-policy.md');
    expect(out).toBe(golden);
  });

  it('diagnostic-evidence matches golden output', async () => {
    const d = diag({
      diagnosticCode: 'EVIDENCE_MISSING',
      rootCause: 'Required evidence slots are missing.',
      required: ['ticket', 'plan', 'validation'],
      missingEvidence: [
        'ticket — Run /ticket to record the task.',
        'plan — Run /plan to create an implementation plan.',
      ],
      safeNextActions: ['/ticket', '/plan'],
    });
    const out = formatDiagnosticCard({
      code: 'EVIDENCE_MISSING',
      message: 'Required evidence is missing.',
      diagnostics: d,
    });
    const golden = await readGolden('diagnostic-evidence.md');
    expect(out).toBe(golden);
  });

  it('diagnostic-review-deny matches golden output', async () => {
    const d = diag({
      diagnosticCode: 'REVIEW_DENIED',
      deniedReviewPath: 'plan-reviewer-iteration-3',
      rootCause: 'Review was denied at plan-reviewer-iteration-3.',
      observed: ['Review denial', 'Blocking issues: 2'],
      required: ['Approved review'],
      safeNextActions: ['/review-decision', '/reject'],
    });
    const out = formatDiagnosticCard({
      code: 'REVIEW_DENIED',
      message: 'Review returned with blocking issues.',
      diagnostics: d,
    });
    const golden = await readGolden('diagnostic-review-deny.md');
    expect(out).toBe(golden);
  });

  it('diagnostic-minimal matches golden output', async () => {
    const d = diag({
      diagnosticCode: 'MINIMAL',
      rootCause: '',
      observed: [],
      required: [],
      missingEvidence: [],
      safeNextActions: [],
    });
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
