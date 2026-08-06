import { describe, it, expect } from 'vitest';
import { renderGitHubSummary } from '../github-summary.js';
import type { ExecutedEvalCase } from '../schema.js';

function ec(verdict: 'PASS' | 'FAIL' | 'RUNNER_ERROR', hardFails = 0, advisoryFails = 0): ExecutedEvalCase {
  const results: { description: string; type: string; severity: 'hard' | 'advisory'; passed: boolean }[] = [];
  for (let i = 0; i < hardFails; i++) {
    results.push({ description: 'h', type: 'output_contains', severity: 'hard', passed: false });
  }
  for (let i = 0; i < advisoryFails; i++) {
    results.push({ description: 'a', type: 'output_contains', severity: 'advisory', passed: false });
  }
  return {
    evalCase: { id: `case-${verdict}`, description: '', task: '', mode: 'output-only', assertions: [] },
    result: { caseId: `case-${verdict}`, verdict, durationMs: 10, assertionResults: results },
    outcome: {
      status: 'completed', exitCode: 0, stdout: '', stderr: '', durationMs: 10,
      beforeSnapshot: new Map(), afterSnapshot: new Map(),
      beforeContent: new Map(), afterContent: new Map(),
    },
  };
}

describe('renderGitHubSummary', () => {
  it('renders a table with all verdicts', () => {
    const s = renderGitHubSummary('fake-host', [
      ec('PASS'),
      ec('FAIL', 2, 1),
      ec('RUNNER_ERROR'),
    ]);
    expect(s).toContain('Eval: fake-host');
    expect(s).toContain('| Case | Verdict | Hard Failures | Advisory Failures |');
    expect(s).toContain('| case-PASS | PASS | 0 | 0 |');
    expect(s).toContain('| case-FAIL | FAIL | 2 | 1 |');
    expect(s).toContain('| case-RUNNER_ERROR | RUNNER_ERROR | 0 | 0 |');
  });

  it('does not contain raw output', () => {
    const s = renderGitHubSummary('fake', [ec('PASS')]);
    expect(s).not.toContain('All checks passed');
    expect(s).not.toContain('stdout');
  });
});
