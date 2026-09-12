import { describe, expect, it } from 'vitest';
import { scoreCase, summarizeResults } from '../score.js';

const RUNNER_PROVENANCE = {
  name: 'fake',
  command: 'node',
  args: [],
  promptTransport: 'stdin' as const,
  provider: 'synthetic',
  model: 'fake-agent',
  modelVersion: '1',
  runnerVersion: '1',
  timeoutMs: 10_000,
  configDigest: 'c'.repeat(64),
  secretEnvNames: [],
};

const REPOSITORY_PROVENANCE = {
  gitCommit: 'a'.repeat(40),
  gitDirty: false,
  flowguardVersion: 'test-version',
  mandateDigest: 'b'.repeat(64),
  caseCorpusDigest: 'd'.repeat(64),
};

describe('scoreCase', () => {
  it('returns PASS when all hard assertions pass', () => {
    const result = scoreCase(
      'test',
      'repository_contributor',
      [
        { description: 'a', type: 'output_contains', severity: 'hard', passed: true },
        { description: 'b', type: 'exit_code', severity: 'hard', passed: true },
      ],
      100,
    );
    expect(result.verdict).toBe('PASS');
  });

  it('returns PASS when advisory assertions fail', () => {
    const result = scoreCase(
      'test',
      'repository_contributor',
      [
        { description: 'a', type: 'output_contains', severity: 'hard', passed: true },
        { description: 'b', type: 'output_contains', severity: 'advisory', passed: false },
      ],
      100,
    );
    expect(result.verdict).toBe('PASS');
  });

  it('returns FAIL when any hard assertion fails', () => {
    const result = scoreCase(
      'test',
      'flowguard_product',
      [
        { description: 'a', type: 'output_contains', severity: 'hard', passed: false },
        { description: 'b', type: 'exit_code', severity: 'hard', passed: true },
      ],
      100,
    );
    expect(result.verdict).toBe('FAIL');
  });

  it('returns RUNNER_ERROR when runnerError is set', () => {
    const result = scoreCase('test', 'flowguard_product', [], 100, 'timeout');
    expect(result.verdict).toBe('RUNNER_ERROR');
    expect(result.runnerError).toBe('timeout');
  });
});

describe('summarizeResults', () => {
  it('counts verdicts by instruction surface and product host', () => {
    const results = [
      scoreCase(
        'a',
        'repository_contributor',
        [{ description: 'x', type: 'exit_code', severity: 'hard', passed: true }],
        10,
      ),
      scoreCase(
        'b',
        'repository_contributor',
        [{ description: 'x', type: 'exit_code', severity: 'hard', passed: false }],
        10,
      ),
      scoreCase('c', 'flowguard_product', [], 10, 'timeout', undefined, 'claude-code'),
      scoreCase(
        'd',
        'flowguard_product',
        [{ description: 'x', type: 'exit_code', severity: 'hard', passed: true }],
        10,
        undefined,
        undefined,
        'opencode',
      ),
    ];
    const summary = summarizeResults(RUNNER_PROVENANCE, REPOSITORY_PROVENANCE, results);
    expect(summary.schemaVersion).toBe(3);
    expect(summary.runner).toEqual(RUNNER_PROVENANCE);
    expect(summary.repository).toEqual(REPOSITORY_PROVENANCE);
    expect(summary).not.toHaveProperty('passed');
    expect(summary).not.toHaveProperty('failed');
    expect(summary).not.toHaveProperty('runnerErrors');
    expect(summary.byInstructionSurface.repository_contributor).toEqual({
      passed: 1,
      failed: 1,
      runnerErrors: 0,
    });
    expect(summary.byInstructionSurface.flowguard_product).toEqual({
      passed: 1,
      failed: 0,
      runnerErrors: 1,
    });
    expect(summary.byInstructionHost.opencode).toEqual({
      passed: 1,
      failed: 0,
      runnerErrors: 0,
    });
    expect(summary.byInstructionHost['claude-code']).toEqual({
      passed: 0,
      failed: 0,
      runnerErrors: 1,
    });
    expect(summary.byInstructionHost.codex).toEqual({
      passed: 0,
      failed: 0,
      runnerErrors: 0,
    });
  });

  it('preserves case insertion order', () => {
    const results = [
      scoreCase(
        'b',
        'repository_contributor',
        [{ description: 'x', type: 'exit_code', severity: 'hard', passed: true }],
        10,
      ),
      scoreCase(
        'a',
        'flowguard_product',
        [{ description: 'x', type: 'exit_code', severity: 'hard', passed: true }],
        10,
        undefined,
        undefined,
        'codex',
      ),
    ];
    const summary = summarizeResults(RUNNER_PROVENANCE, REPOSITORY_PROVENANCE, results);
    expect(summary.cases.map((c) => c.caseId)).toEqual(['b', 'a']);
  });
});
