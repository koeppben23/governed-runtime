import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../runners/process-runner.js';
import type { RunnerConfig } from '../schema.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FAKE_AGENT = join(FIXTURE, 'fake-agent.mjs');

function config(args: string[]): RunnerConfig {
  return {
    name: 'fake',
    command: process.execPath,
    args: [FAKE_AGENT, ...args],
    timeoutMs: 15_000,
    workspaceMode: 'copy',
  };
}

describe('process-runner', () => {
  it('captures stdout from a passing process', async () => {
    const outcome = await runProcess(config(['pass']), FIXTURE);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.stdout).toContain('All checks passed');
      expect(outcome.exitCode).toBe(0);
    }
  });

  it('captures stderr', async () => {
    const outcome = await runProcess(config(['exit-1']), FIXTURE);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.stderr).toContain('something went wrong');
      expect(outcome.exitCode).toBe(1);
    }
  });

  it('detects timeout', async () => {
    const c = config(['timeout']);
    c.timeoutMs = 2000;
    const outcome = await runProcess(c, FIXTURE);
    // Timeout may result in 'runner_error' (timeout) or 'runner_error' (signal)
    // depending on whether the runner's kill or the process close fires first.
    // Both are valid: the key invariant is that a hanging process does not
    // return status 'completed'.
    expect(outcome.status).toBe('runner_error');
  });

  it('detects process crash (exit code != 0)', async () => {
    const outcome = await runProcess(config(['crash']), FIXTURE);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.exitCode).toBe(137);
    }
  });

  it('detects file creation in workspace', async () => {
    const outcome = await runProcess(config(['workspace-write']), FIXTURE);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      // The workspace-write mode writes new-file.txt
      // Workspace is a copy, so the after snapshot should have it
      const hasNewFile = outcome.afterSnapshot.has('new-file.txt') ||
        Array.from(outcome.afterSnapshot.keys()).some((k) => k.endsWith('new-file.txt'));
      expect(hasNewFile).toBe(true);
    }
  });
});
