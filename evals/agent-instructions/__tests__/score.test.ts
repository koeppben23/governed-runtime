import { describe, it, expect } from 'vitest';
import { scoreCase, summarizeResults } from '../score.js';

describe('scoreCase', () => {
  it('returns PASS when all hard assertions pass', () => {
    const result = scoreCase('test', [
      { description: 'a', type: 'output_contains', severity: 'hard', passed: true },
      { description: 'b', type: 'exit_code', severity: 'hard', passed: true },
    ], 100);
    expect(result.verdict).toBe('PASS');
  });

  it('returns PASS when advisory assertions fail', () => {
    const result = scoreCase('test', [
      { description: 'a', type: 'output_contains', severity: 'hard', passed: true },
      { description: 'b', type: 'output_contains', severity: 'advisory', passed: false },
    ], 100);
    expect(result.verdict).toBe('PASS');
  });

  it('returns FAIL when any hard assertion fails', () => {
    const result = scoreCase('test', [
      { description: 'a', type: 'output_contains', severity: 'hard', passed: false },
      { description: 'b', type: 'exit_code', severity: 'hard', passed: true },
    ], 100);
    expect(result.verdict).toBe('FAIL');
  });

  it('returns RUNNER_ERROR when runnerError is set', () => {
    const result = scoreCase('test', [], 100, 'timeout');
    expect(result.verdict).toBe('RUNNER_ERROR');
    expect(result.runnerError).toBe('timeout');
  });
});

describe('summarizeResults', () => {
  it('counts PASS, FAIL, and RUNNER_ERROR separately', () => {
    const results = [
      scoreCase('a', [{ description: 'x', type: 'exit_code', severity: 'hard', passed: true }], 10),
      scoreCase('b', [{ description: 'x', type: 'exit_code', severity: 'hard', passed: false }], 10),
      scoreCase('c', [], 10, 'timeout'),
      scoreCase('d', [{ description: 'x', type: 'exit_code', severity: 'hard', passed: true }], 10),
    ];
    const summary = summarizeResults('fake', results);
    expect(summary.schemaVersion).toBe(1);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.runnerErrors).toBe(1);
  });

  it('sorts cases by insertion order', () => {
    const results = [
      scoreCase('b', [{ description: 'x', type: 'exit_code', severity: 'hard', passed: true }], 10),
      scoreCase('a', [{ description: 'x', type: 'exit_code', severity: 'hard', passed: true }], 10),
    ];
    const summary = summarizeResults('fake', results);
    expect(summary.cases.map((c) => c.caseId)).toEqual(['b', 'a']);
  });
});
