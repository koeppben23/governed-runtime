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

function runContributor(
  runnerConfig: RunnerConfig,
  fixtureRoot: string,
  prompt = 'test prompt',
  forceCopy = true,
) {
  return runProcess(
    runnerConfig,
    fixtureRoot,
    prompt,
    forceCopy,
    process.cwd(),
    {},
    'repository_contributor',
  );
}

describe('process-runner', () => {
  it('captures stdout from a passing process', async () => {
    const outcome = await runContributor(config(['pass']), FIXTURE);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.stdout).toContain('All checks passed');
      expect(outcome.exitCode).toBe(0);
    }
  });

  it('captures stderr', async () => {
    const outcome = await runContributor(config(['exit-1']), FIXTURE);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.stderr).toContain('something went wrong');
      expect(outcome.exitCode).toBe(1);
    }
  });

  it('detects timeout', async () => {
    const c = config(['timeout']);
    c.timeoutMs = 2000;
    const outcome = await runContributor(c, FIXTURE);
    expect(outcome.status).toBe('runner_error');
    expect(outcome).toMatchObject({ status: 'runner_error', errorKind: 'timeout' });
  });

  it('detects process crash (exit code != 0)', async () => {
    const outcome = await runContributor(config(['crash']), FIXTURE);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') expect(outcome.exitCode).toBe(137);
  });

  it('detects file creation in workspace', async () => {
    const outcome = await runContributor(config(['workspace-write']), FIXTURE);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const hasNewFile =
        outcome.afterSnapshot.has('new-file.txt') ||
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
    const outcome = await runContributor(c, FIXTURE);
    expect(outcome.status).toBe('runner_error');
    expect(outcome).toMatchObject({ status: 'runner_error', errorKind: 'spawn' });
  });

  it('passes the prompt to the process via stdin', async () => {
    const outcome = await runContributor(config(['echo-stdin']), FIXTURE, 'Hello from eval');
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.stdout).toContain('Hello from eval');
    }
  });

  it('materializes product mandates only for an explicit supported host', async () => {
    const outcome = await runProcess(
      config(['pass']),
      FIXTURE,
      'test prompt',
      true,
      process.cwd(),
      {},
      'flowguard_product',
      'opencode',
    );
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.instructionSurface).toBe('flowguard_product');
      expect(outcome.instructionHost).toBe('opencode');
      expect(outcome.afterContent.get('.opencode/flowguard-mandates.md')).toContain(
        '# FlowGuard Agent Rules',
      );
      expect(outcome.afterContent.get('opencode.json')).toContain(
        '.opencode/flowguard-mandates.md',
      );
    }
  });

  it('fails closed when a product evaluation omits its host', async () => {
    const outcome = await runProcess(
      config(['pass']),
      FIXTURE,
      'test prompt',
      true,
      process.cwd(),
      {},
      'flowguard_product',
    );
    expect(outcome).toMatchObject({
      status: 'runner_error',
      errorKind: 'workspace',
      instructionSurface: 'flowguard_product',
    });
  });

  it('merges product instructions into existing OpenCode config', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'eval-opencode-merge-'));
    writeFileSync(
      join(fixtureDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'example/provider-model',
        instructions: ['CUSTOM.md'],
      }),
    );

    const outcome = await runProcess(
      config(['pass']),
      fixtureDir,
      'test prompt',
      true,
      process.cwd(),
      {},
      'flowguard_product',
      'opencode',
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const parsed = JSON.parse(outcome.afterContent.get('opencode.json') ?? '{}') as {
        model?: string;
        instructions?: string[];
      };
      expect(parsed.model).toBe('example/provider-model');
      expect(parsed.instructions).toContain('CUSTOM.md');
      expect(parsed.instructions).toContain('.opencode/flowguard-mandates.md');
    }

    rmSync(fixtureDir, { recursive: true, force: true });
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

    await runContributor(c, fixtureDir);
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
    expect(paths.some((p) => p.includes('secret.txt'))).toBe(false);

    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
