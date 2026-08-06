import { describe, it, expect } from 'vitest';
import { determineExitCode } from '../exit-code.js';
import type { ExecutedEvalCase } from '../schema.js';

function makeExecuted(
  verdict: 'PASS' | 'FAIL' | 'RUNNER_ERROR',
): ExecutedEvalCase {
  return {
    evalCase: {
      id: 'test',
      description: '',
      task: '',
      mode: 'output-only',
      assertions: [],
    },
    result: {
      caseId: 'test',
      verdict,
      durationMs: 10,
      assertionResults: [],
    },
    outcome: {
      status: 'completed',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 10,
      beforeSnapshot: new Map(),
      afterSnapshot: new Map(),
      beforeContent: new Map(),
      afterContent: new Map(),
    },
  };
}

describe('determineExitCode', () => {
  it('returns 0 when all PASS in normal mode', () => {
    expect(
      determineExitCode([makeExecuted('PASS')], false),
    ).toBe(0);
  });

  it('returns 1 when FAIL in normal mode', () => {
    expect(
      determineExitCode([makeExecuted('PASS'), makeExecuted('FAIL')], false),
    ).toBe(1);
  });

  it('returns 0 when FAIL in advisory mode', () => {
    expect(
      determineExitCode([makeExecuted('FAIL')], true),
    ).toBe(0);
  });

  it('returns 2 when RUNNER_ERROR in normal mode', () => {
    expect(
      determineExitCode([makeExecuted('RUNNER_ERROR')], false),
    ).toBe(2);
  });

  it('returns 2 when RUNNER_ERROR in advisory mode', () => {
    expect(
      determineExitCode([makeExecuted('RUNNER_ERROR')], true),
    ).toBe(2);
  });

  it('returns 2 when FAIL + RUNNER_ERROR in advisory mode', () => {
    expect(
      determineExitCode(
        [makeExecuted('FAIL'), makeExecuted('RUNNER_ERROR')],
        true,
      ),
    ).toBe(2);
  });
});
