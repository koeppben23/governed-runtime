import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { runProcess, snapshotWorkspace } from '../runners/process-runner.js';
import type { RunnerConfig } from '../schema.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FAKE_AGENT = join(FIXTURE, 'fake-agent.mjs');

function config(args: string[]): RunnerConfig {
  return {
    name: 'fake',
    command: process.execPath,
    promptTransport: 'stdin' as const,
    args: [FAKE_AGENT, ...args],
    timeoutMs: 15_000,
  };
}

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

describe('process-runner', () => {
  it('captures stdout from a passing process', async () => {
    const outcome = await runProcess(config(['pass']), FIXTURE, 'test prompt', true, process.cwd(), {});
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.stdout).toContain('All checks passed');
      expect(outcome.exitCode).toBe(0);
    }
  });

  it('captures stderr', async () => {
    const outcome = await runProcess(config(['exit-1']), FIXTURE, 'test prompt', true, process.cwd(), {});
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.stderr).toContain('something went wrong');
      expect(outcome.exitCode).toBe(1);
    }
  });

  it('detects timeout', async () => {
    const c = config(['timeout']);
    c.timeoutMs = 2000;
    const outcome = await runProcess(c, FIXTURE, 'test prompt', true, process.cwd(), {});
    expect(outcome.status).toBe('runner_error');
    expect(outcome).toMatchObject({
      status: 'runner_error',
      errorKind: 'timeout',
    });
  });

  it('detects process crash (exit code != 0)', async () => {
    const outcome = await runProcess(config(['crash']), FIXTURE, 'test prompt', true, process.cwd(), {});
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.exitCode).toBe(137);
    }
  });

  it('detects file creation in workspace', async () => {
    const outcome = await runProcess(config(['workspace-write']), FIXTURE, 'test prompt', true, process.cwd(), {});
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const hasNewFile = outcome.afterSnapshot.has('new-file.txt') ||
        Array.from(outcome.afterSnapshot.keys()).some((k) => k.endsWith('new-file.txt'));
      expect(hasNewFile).toBe(true);
    }
  });

  it('handles spawn error for missing command', async () => {
    const c: RunnerConfig = {
      name: 'nonexistent',
      command: '/this/command/does/not/exist',
      promptTransport: 'stdin' as const,
      args: [],
      timeoutMs: 5000,
    };
    const outcome = await runProcess(c, FIXTURE, 'test prompt', true, process.cwd(), {});
    expect(outcome.status).toBe('runner_error');
    expect(outcome).toMatchObject({
      status: 'runner_error',
      errorKind: 'spawn',
    });
  });

  it('passes the prompt to the process via stdin', async () => {
    const outcome = await runProcess(config(['echo-stdin']), FIXTURE, 'Hello from eval', true, process.cwd(), {});
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.stdout).toContain('Hello from eval');
    }
  });

  it('does not modify original fixture after workspace-copy run', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'eval-fixture-test-'));
    writeFileSync(join(fixtureDir, 'data.txt'), 'original');
    const hashBefore = sha256File(join(fixtureDir, 'data.txt'));

    const c: RunnerConfig = {
      name: 'write-test',
      command: process.execPath,
      promptTransport: 'stdin' as const,
      args: [FAKE_AGENT, 'workspace-write'],
      timeoutMs: 10_000,
    };

    await runProcess(c, fixtureDir, 'test prompt', true, process.cwd(), {});
    const hashAfter = sha256File(join(fixtureDir, 'data.txt'));

    expect(hashBefore).toBe(hashAfter);

    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('does not traverse directory symlinks in workspace snapshots', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'eval-symlink-test-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'eval-outside-'));

    writeFileSync(join(fixtureDir, 'real.txt'), 'real');
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret');

    try {
      symlinkSync(outsideDir, join(fixtureDir, 'external-dir'), 'dir');
    } catch {
      rmSync(fixtureDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    const { entries } = snapshotWorkspace(fixtureDir);
    const paths = Array.from(entries.keys());

    expect(paths).toContain('real.txt');
    // Directory symlink must not be traversed — secret.txt is unreachable
    expect(paths.some((p) => p.includes('secret.txt'))).toBe(false);

    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
