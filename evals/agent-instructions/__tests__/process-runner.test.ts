import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProcess, snapshotWorkspace } from '../runners/process-runner.js';
import type { RunnerConfig } from '../schema.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FAKE_AGENT = join(FIXTURE, 'fake-agent.mjs');
const REQUIRED_RUNNER_PROVENANCE = {
  provider: 'synthetic',
  model: 'fake-agent',
  modelVersion: '1',
  runnerVersion: '1',
} as const;

function config(args: string[]): RunnerConfig {
  return {
    name: 'fake',
    ...REQUIRED_RUNNER_PROVENANCE,
    command: process.execPath,
    promptTransport: 'stdin' as const,
    args: [FAKE_AGENT, ...args],
    timeoutMs: 15_000,
    staticEnv: {},
    secretEnvNames: [],
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
      ...REQUIRED_RUNNER_PROVENANCE,
      command: '/this/command/does/not/exist',
      promptTransport: 'stdin' as const,
      args: [],
      timeoutMs: 5000,
      staticEnv: {},
      secretEnvNames: [],
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

  it('materializes product mandates for OpenCode through the production merge path', async () => {
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

  it('materializes the production Claude Code plugin transport', async () => {
    const outcome = await runProcess(
      config(['pass']),
      FIXTURE,
      'test prompt',
      true,
      process.cwd(),
      {},
      'flowguard_product',
      'claude-code',
    );
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.instructionHost).toBe('claude-code');
      expect(outcome.afterContent.get('flowguard-plugin/.claude-plugin/plugin.json')).toContain(
        'FlowGuard Governance',
      );
      expect(outcome.afterContent.get('flowguard-plugin/skills/start/SKILL.md')).toContain(
        '# FlowGuard Start',
      );
      expect(outcome.afterContent.get('flowguard-plugin/.mcp.json')).toContain(
        'FLOWGUARD_HOST_PLATFORM',
      );
    }
  });

  it('materializes the production Codex plugin transport and registration', async () => {
    const outcome = await runProcess(
      config(['pass']),
      FIXTURE,
      'test prompt',
      true,
      process.cwd(),
      {},
      'flowguard_product',
      'codex',
    );
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.instructionHost).toBe('codex');
      expect(outcome.afterContent.get('plugins/flowguard/AGENTS.md')).toContain(
        '# FlowGuard Codex Plugin',
      );
      const marketplace = JSON.parse(
        outcome.afterContent.get('.agents/plugins/marketplace.json') ?? '{}',
      ) as { plugins?: Array<{ source?: { path?: string } }> };
      expect(marketplace.plugins?.[0]?.source?.path).toBe('./plugins/flowguard');
    }
  });

  it('resolves workspaceRoot runner argument placeholders against the isolated workspace', async () => {
    const c = config(['pass']);
    c.args = [FAKE_AGENT, 'pass', '{workspaceRoot}'];
    const outcome = await runProcess(
      c,
      FIXTURE,
      'test prompt',
      true,
      process.cwd(),
      {},
      'flowguard_product',
      'claude-code',
    );
    expect(outcome.status).toBe('completed');
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
      ...REQUIRED_RUNNER_PROVENANCE,
      command: process.execPath,
      promptTransport: 'stdin' as const,
      args: [FAKE_AGENT, 'workspace-write'],
      timeoutMs: 10_000,
      staticEnv: {},
      secretEnvNames: [],
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
