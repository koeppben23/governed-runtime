import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeReports } from '../run.js';
import type { EvalCase, ExecutedEvalCase, RunnerConfig } from '../schema.js';
import type { RunnerOutcome } from '../runners/process-runner.js';

const RUNNER_CONFIG: RunnerConfig = {
  name: 'fake-host',
  command: 'node',
  provider: 'synthetic',
  model: 'fake-agent',
  modelVersion: '1',
  runnerVersion: '1',
  runnerKind: 'synthetic',
  promptTransport: 'stdin',
  args: [],
  staticEnv: {},
  secretEnvNames: [],
  timeoutMs: 1_000,
};

const BASE_CASE: EvalCase = {
  id: 'test-case',
  description: 'test case',
  instructionSurface: 'repository_contributor',
  task: 'do something',
  mode: 'output-only',
  workspace: { mode: 'empty' },
  syntheticSecrets: {},
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
  it('writes schemaVersion 3 with reproducible runner and repository provenance', () => {
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

    const d = writeReports(RUNNER_CONFIG, [c], { runId: 'test-run-1' });
    const s = JSON.parse(readFileSync(join(d, 'summary.json'), 'utf-8'));
    expect(s.schemaVersion).toBe(3);
    expect(s.runner).toMatchObject({
      name: 'fake-host',
      provider: 'synthetic',
      model: 'fake-agent',
      modelVersion: '1',
      runnerVersion: '1',
      runnerKind: 'synthetic',
      timeoutMs: 1_000,
    });
    expect(s.runner.configDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(s.repository.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof s.repository.gitDirty).toBe('boolean');
    expect(s.repository.flowguardVersion).toBeTruthy();
    expect(s.repository.mandateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(s.repository.caseCorpusDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(s.byInstructionSurface.repository_contributor.passed).toBe(1);
    expect(s.byInstructionHost.opencode).toEqual({ passed: 0, failed: 0, runnerErrors: 0 });

    rmSync(d, { recursive: true, force: true });
  });

  it('writes summary.md with provenance, surface totals, and host totals', () => {
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

    const d = writeReports(RUNNER_CONFIG, [c], { runId: 'test-run-2' });
    const md = readFileSync(join(d, 'summary.md'), 'utf-8');
    expect(md).toContain('Eval Run: fake-host');
    expect(md).toContain('Provider/model: synthetic/fake-agent (1)');
    expect(md).toContain('By Instruction Surface');
    expect(md).toContain('By Product Host');
    expect(md).toContain('Runner config digest:');
    expect(md).toContain('Case corpus digest:');
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

    const d = writeReports(RUNNER_CONFIG, [c], { runId: 'test-run-3' });
    const caseDir = join(d, 'cases', 'c1');

    expect(readFileSync(join(caseDir, 'prompt.txt'), 'utf-8').trim()).toBe('fix the bug');
    expect(readFileSync(join(caseDir, 'stdout.txt'), 'utf-8')).toContain('hello stdout');
    expect(readFileSync(join(caseDir, 'stderr.txt'), 'utf-8')).toContain('hello stderr');

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

    const d = writeReports(RUNNER_CONFIG, [c], { runId: 'test-run-4' });
    expect(readFileSync(join(d, 'cases', 'c1', 'stdout.txt'), 'utf-8')).toContain(
      'partial stdout',
    );

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

    const d = writeReports(RUNNER_CONFIG, cases, { runId: 'test-run-5' });
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

    const d = writeReports(RUNNER_CONFIG, [c], { runId: 'test-run-6' });
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

    const d = writeReports(RUNNER_CONFIG, [c], {
      runId: 'test-run-redact',
      redactionValues: ['my-secret-key-is-long-enough'],
    });

    const caseDir = join(d, 'cases', 'c1');
    for (const f of ['stdout.txt', 'stderr.txt', 'result.json', 'outcome.json']) {
      const content = readFileSync(join(caseDir, f), 'utf-8');
      expect(content).not.toContain('my-secret-key-is-long-enough');
    }
    expect(readFileSync(join(caseDir, 'stdout.txt'), 'utf-8')).toContain('***REDACTED***');
    expect(readFileSync(join(d, 'summary.json'), 'utf-8')).not.toContain(
      'my-secret-key-is-long-enough',
    );
    expect(readFileSync(join(d, 'summary.md'), 'utf-8')).not.toContain(
      'my-secret-key-is-long-enough',
    );

    rmSync(d, { recursive: true, force: true });
  });
});
