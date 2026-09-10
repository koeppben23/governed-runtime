import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeReports } from '../run.js';
import type { ExecutedEvalCase, EvalCase } from '../schema.js';
import type { RunnerOutcome } from '../runners/process-runner.js';

const BASE_CASE: EvalCase = {
  id: 'test-case',
  description: '',
  instructionSurface: 'repository_contributor',
  task: 'do something',
  mode: 'output-only',
  assertions: [
    {
      type: 'exit_code',
      value: 0,
      severity: 'hard',
      description: 'exit ok',
    },
  ],
};

function completedOutcome(): RunnerOutcome {
  const snap = new Map();
  return {
    status: 'completed',
    exitCode: 0,
    stdout: 'hello stdout',
    stderr: 'hello stderr',
    durationMs: 100,
    beforeSnapshot: snap,
    afterSnapshot: snap,
    beforeContent: new Map(),
    afterContent: new Map(),
    instructionSurface: 'repository_contributor',
  };
}

function runnerErrorOutcome(): RunnerOutcome {
  return {
    status: 'runner_error',
    errorKind: 'timeout',
    message: 'timed out',
    stdout: 'partial stdout',
    stderr: '',
    instructionSurface: 'repository_contributor',
  };
}

describe('writeReports', () => {
  it('writes summary.json with schemaVersion 1', () => {
    const c: ExecutedEvalCase = {
      evalCase: { ...BASE_CASE, id: 'c1' },
      result: {
        caseId: 'c1',
        instructionSurface: 'repository_contributor',
        verdict: 'PASS',
        durationMs: 100,
        assertionResults: [],
      },
      outcome: completedOutcome(),
    };

    const d = writeReports('fake-host', [c], { runId: 'test-run-1' });
    const s = JSON.parse(readFileSync(join(d, 'summary.json'), 'utf-8'));
    expect(s.schemaVersion).toBe(1);
    expect(s.runner).toBe('fake-host');
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.runnerErrors).toBe(0);
    expect(s.byInstructionSurface.repository_contributor.passed).toBe(1);
    expect(s.byInstructionSurface.flowguard_product.passed).toBe(0);

    rmSync(d, { recursive: true, force: true });
  });

  it('writes summary.md', () => {
    const c: ExecutedEvalCase = {
      evalCase: { ...BASE_CASE, id: 'c1' },
      result: {
        caseId: 'c1',
        instructionSurface: 'repository_contributor',
        verdict: 'FAIL',
        durationMs: 100,
        assertionResults: [],
      },
      outcome: completedOutcome(),
    };

    const d = writeReports('fake-host', [c], { runId: 'test-run-2' });
    const md = readFileSync(join(d, 'summary.md'), 'utf-8');
    expect(md).toContain('Eval Run: fake-host');
    expect(md).toContain('FAIL');
    expect(md).toContain('c1');

    rmSync(d, { recursive: true, force: true });
  });

  it('persists raw artifacts per case with instruction provenance', () => {
    const c: ExecutedEvalCase = {
      evalCase: { ...BASE_CASE, id: 'c1', task: 'fix the bug' },
      result: {
        caseId: 'c1',
        instructionSurface: 'repository_contributor',
        verdict: 'PASS',
        durationMs: 50,
        assertionResults: [],
      },
      outcome: completedOutcome(),
    };

    const d = writeReports('fake-host', [c], { runId: 'test-run-3' });
    const caseDir = join(d, 'cases', 'c1');

    const prompt = readFileSync(join(caseDir, 'prompt.txt'), 'utf-8');
    expect(prompt.trim()).toBe('fix the bug');

    const stdout = readFileSync(join(caseDir, 'stdout.txt'), 'utf-8');
    expect(stdout).toContain('hello stdout');

    const stderr = readFileSync(join(caseDir, 'stderr.txt'), 'utf-8');
    expect(stderr).toContain('hello stderr');

    const result = JSON.parse(readFileSync(join(caseDir, 'result.json'), 'utf-8'));
    expect(result.caseId).toBe('c1');
    expect(result.verdict).toBe('PASS');

    const outcome = JSON.parse(readFileSync(join(caseDir, 'outcome.json'), 'utf-8'));
    expect(outcome).toEqual({
      status: 'completed',
      exitCode: 0,
      durationMs: 100,
      instructionSurface: 'repository_contributor',
    });

    rmSync(d, { recursive: true, force: true });
  });

  it('persists artifacts for RUNNER_ERROR cases', () => {
    const c: ExecutedEvalCase = {
      evalCase: { ...BASE_CASE, id: 'c1' },
      result: {
        caseId: 'c1',
        instructionSurface: 'repository_contributor',
        verdict: 'RUNNER_ERROR',
        durationMs: 10,
        assertionResults: [],
        runnerError: 'timed out',
      },
      outcome: runnerErrorOutcome(),
    };

    const d = writeReports('fake-host', [c], { runId: 'test-run-4' });
    const stdout = readFileSync(join(d, 'cases', 'c1', 'stdout.txt'), 'utf-8');
    expect(stdout).toContain('partial stdout');

    const outcome = JSON.parse(readFileSync(join(d, 'cases', 'c1', 'outcome.json'), 'utf-8'));
    expect(outcome).toEqual({
      status: 'runner_error',
      errorKind: 'timeout',
      message: 'timed out',
      instructionSurface: 'repository_contributor',
    });

    rmSync(d, { recursive: true, force: true });
  });

  it('sorts cases by id', () => {
    const cases: ExecutedEvalCase[] = ['b', 'a'].map((id) => ({
      evalCase: { ...BASE_CASE, id },
      result: {
        caseId: id,
        instructionSurface: 'repository_contributor',
        verdict: 'PASS' as const,
        durationMs: 10,
        assertionResults: [],
      },
      outcome: completedOutcome(),
    }));

    const d = writeReports('fake-host', cases, { runId: 'test-run-5' });
    const s = JSON.parse(readFileSync(join(d, 'summary.json'), 'utf-8'));
    expect(s.cases[0].caseId).toBe('a');
    expect(s.cases[1].caseId).toBe('b');

    rmSync(d, { recursive: true, force: true });
  });

  it('contains no absolute tmp paths in summary.json', () => {
    const c: ExecutedEvalCase = {
      evalCase: BASE_CASE,
      result: {
        caseId: BASE_CASE.id,
        instructionSurface: 'repository_contributor',
        verdict: 'PASS',
        durationMs: 10,
        assertionResults: [],
      },
      outcome: completedOutcome(),
    };

    const d = writeReports('fake-host', [c], { runId: 'test-run-6' });
    const s = readFileSync(join(d, 'summary.json'), 'utf-8');
    expect(s).not.toContain(tmpdir());

    rmSync(d, { recursive: true, force: true });
  });

  it('redacts secrets from all persisted text artifacts', () => {
    const c: ExecutedEvalCase = {
      evalCase: { ...BASE_CASE, id: 'c1' },
      result: {
        caseId: 'c1',
        instructionSurface: 'repository_contributor',
        verdict: 'PASS',
        durationMs: 50,
        assertionResults: [],
      },
      outcome: {
        status: 'completed',
        exitCode: 0,
        stdout: 'using secret: my-secret-key-is-long-enough',
        stderr: '',
        durationMs: 100,
        beforeSnapshot: new Map(),
        afterSnapshot: new Map(),
        beforeContent: new Map(),
        afterContent: new Map(),
        instructionSurface: 'repository_contributor',
      },
    };

    const d = writeReports('fake-host', [c], {
      runId: 'test-run-redact',
      redactionValues: ['my-secret-key-is-long-enough'],
    });

    const caseDir = join(d, 'cases', 'c1');
    const allFiles = ['stdout.txt', 'stderr.txt', 'result.json', 'outcome.json'];
    for (const f of allFiles) {
      const content = readFileSync(join(caseDir, f), 'utf-8');
      expect(content).not.toContain('my-secret-key-is-long-enough');
    }
    expect(readFileSync(join(caseDir, 'stdout.txt'), 'utf-8')).toContain('***REDACTED***');
    expect(readFileSync(join(d, 'summary.json'), 'utf-8')).not.toContain('my-secret-key-is-long-enough');
    expect(readFileSync(join(d, 'summary.md'), 'utf-8')).not.toContain('my-secret-key-is-long-enough');

    rmSync(d, { recursive: true, force: true });
  });
});
