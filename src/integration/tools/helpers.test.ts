/**
 * @module integration/tools/helpers.test
 * @description Contract tests for the most widely consumed public functions
 * of helpers.ts. Covers the pure/deterministic functions used by 3+ callers.
 *
 * Functions requiring filesystem I/O or full session state are intentionally
 * left to integration-level tests.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect } from 'vitest';
import {
  formatBlocked,
  formatAutoAdvanceOverflow,
  formatError,
  getWorktree,
  extractSections,
  formatEval,
  formatRailResult,
} from './helpers.js';
import type { EvalResult } from '../../machine/evaluate.js';
import type { RailResult, AutoAdvanceOverflow } from '../../rails/types.js';
import { makeProgressedState } from '../../fixtures.js';

function parseJSON(s: string): Record<string, unknown> {
  return JSON.parse(s);
}

describe('formatBlocked', () => {
  it('formats a known reason code with recovery', () => {
    const result = parseJSON(formatBlocked('COMMAND_NOT_ALLOWED'));
    expect(result.error).toBe(true);
    expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    expect(typeof result.message).toBe('string');
    expect(result.recovery).toBeDefined();
  });

  it('interpolates template variables for known codes', () => {
    const result = parseJSON(
      formatBlocked('COMMAND_NOT_ALLOWED', { command: '/test', phase: 'PLAN' }),
    );
    expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    expect(result.message).toContain('/test');
    expect(result.message).toContain('PLAN');
  });

  it('produces valid JSON for unknown codes (fallback, no crash)', () => {
    const result = parseJSON(formatBlocked('NONEXISTENT_CODE'));
    expect(result.error).toBe(true);
    expect(result.code).toBe('NONEXISTENT_CODE');
    expect(typeof result.message).toBe('string');
  });

  it('omits presentation.markdown for codes without a diagnostic builder', () => {
    const result = parseJSON(formatBlocked('COMMAND_NOT_ALLOWED'));
    expect(result.diagnostics).toBeUndefined();
    expect(result.presentation).toBeUndefined();
  });

  it('renders presentation.markdown via the shared renderer for diagnostic-bearing codes', () => {
    const result = parseJSON(formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE'));
    expect(result.diagnostics).toBeDefined();
    const presentation = result.presentation as { markdown: string } | undefined;
    expect(presentation).toBeDefined();
    expect(typeof presentation!.markdown).toBe('string');
    // Rendered through the shared renderer: blocker section + no leading/trailing newline.
    expect(presentation!.markdown).toContain('FlowGuard blocked this action.');
    expect(presentation!.markdown.startsWith('\n')).toBe(false);
    expect(presentation!.markdown.endsWith('\n')).toBe(false);
  });

  it('adds the migrated headline field only for migrated codes', () => {
    const migrated = parseJSON(
      formatBlocked('DISCOVERY_DRIFT_BLOCKED', { driftStatus: 'drifted' }),
    );
    expect(migrated.headline).toBe('Discovery drift blocks mutating tools');
    // The registry-verbatim interpolated message is preserved in `message`,
    // distinct from the context-free headline.
    expect(migrated.message).toContain('Discovery drift verdict is drifted');
    expect(migrated.message).not.toBe(migrated.headline);

    const unmigrated = parseJSON(formatBlocked('COMMAND_NOT_ALLOWED'));
    expect(unmigrated.headline).toBeUndefined();
  });
});

describe('formatAutoAdvanceOverflow', () => {
  it('formats overflow with phase and limit', () => {
    const result = parseJSON(
      formatAutoAdvanceOverflow({ phase: 'PLAN', limit: 10 } as AutoAdvanceOverflow),
    );
    expect(result.error).toBe(true);
    const overflow = result.autoAdvanceOverflow as Record<string, unknown>;
    expect(overflow.phase).toBe('PLAN');
    expect(overflow.limit).toBe(10);
  });
});

describe('formatError', () => {
  it('maps a plain Error to INTERNAL_ERROR', () => {
    const result = parseJSON(formatError(new Error('something broke')));
    expect(result.error).toBe(true);
    expect(result.code).toBe('INTERNAL_ERROR');
  });

  it('preserves an error code when present', () => {
    const err = Object.assign(new Error('custom'), { code: 'E1' });
    const result = parseJSON(formatError(err));
    expect(result.code).toBe('E1');
  });
});

describe('getWorktree', () => {
  it('returns worktree when non-empty', () => {
    expect(getWorktree({ worktree: '/ws', directory: '/tmp', sessionID: 's1' })).toBe('/ws');
  });

  it('falls back to directory when worktree is empty', () => {
    expect(getWorktree({ worktree: '', directory: '/tmp', sessionID: 's1' })).toBe('/tmp');
  });
});

describe('extractSections', () => {
  it('extracts H2 and H3 headers', () => {
    expect(extractSections('## A\n### B\n## C')).toEqual(['A', 'B', 'C']);
  });

  it('returns empty array for text without headers', () => {
    expect(extractSections('plain text')).toEqual([]);
  });
});

describe('formatEval', () => {
  it('returns terminal message for kind terminal', () => {
    const result = formatEval({ kind: 'terminal' } as EvalResult);
    expect(result).toBe('Workflow complete. Session is terminal.');
  });

  it('returns transition message for kind transition', () => {
    const result = formatEval({
      kind: 'transition',
      target: 'PLAN',
      event: 'PLAN_READY',
    } as EvalResult);
    expect(result).toContain('PLAN');
  });
});

describe('formatRailResult', () => {
  it('formats a blocked rail result as error JSON', () => {
    const result = formatRailResult({
      kind: 'blocked',
      code: 'TICKET_REQUIRED',
      reason: 'No ticket',
    } as RailResult);
    const parsed = parseJSON(result as string);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('TICKET_REQUIRED');
    expect(parsed.message).toBe('No ticket');
  });

  it('renders ProofGraph and only /export after evidence approval completes', () => {
    const state = makeProgressedState('COMPLETE');
    const result = formatRailResult(
      {
        kind: 'ok',
        state,
        evalResult: { kind: 'terminal' },
        transitions: [
          {
            from: 'EVIDENCE_REVIEW',
            to: 'COMPLETE',
            event: 'APPROVE',
            at: '2025-01-01T00:00:00Z',
          },
        ],
      } as RailResult,
      { evidenceApprovalCompletion: true },
    );
    const output = typeof result === 'string' ? result : result.output;
    const presentation = parseJSON(output).presentation as { markdown: string };
    expect(presentation.markdown).toContain('## ProofGraph');
    expect(presentation.markdown).toContain('/export');
    expect(presentation.markdown).not.toContain('/approve');
  });
});
