/**
 * @module cli/runtime-flow-smoke.test
 * @description Opt-in real host runtime smoke tests for FlowGuard command flows.
 *
 * These tests intentionally do not run in default CI. They require real host
 * CLIs, configured model/auth credentials, and native plugin loading.
 *
 * Enable with:
 *   RUN_FLOWGUARD_RUNTIME_SMOKE=1 npm run test:runtime-smoke
 *
 * Optional host subset:
 *   FLOWGUARD_RUNTIME_SMOKE_HOSTS=opencode,claude-code,codex
 *
 * Optional timeout per host invocation:
 *   FLOWGUARD_RUNTIME_SMOKE_TIMEOUT_MS=180000
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostId } from '../shared/hosts.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli', 'install.js');
const RUNTIME_SMOKE_ENABLED = process.env.RUN_FLOWGUARD_RUNTIME_SMOKE === '1';
const HOSTS = ['opencode', 'claude-code', 'codex'] as const satisfies readonly HostId[];
const HOST_BINARY: Readonly<Record<HostId, string>> = {
  opencode: 'opencode',
  'claude-code': 'claude',
  codex: 'codex',
};
const DEFAULT_TIMEOUT_MS = 120_000;

type SmokeFlow = 'main' | 'architecture' | 'review';

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RuntimeProject {
  readonly host: HostId;
  readonly flow: SmokeFlow;
  readonly projectDir: string;
  readonly configDir: string;
}

function selectedHosts(): readonly HostId[] {
  const raw = process.env.FLOWGUARD_RUNTIME_SMOKE_HOSTS;
  if (!raw) return HOSTS;
  const parsed = raw
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const invalid = parsed.filter((host) => !HOSTS.includes(host as HostId));
  if (invalid.length > 0) {
    throw new Error(`Invalid FLOWGUARD_RUNTIME_SMOKE_HOSTS value(s): ${invalid.join(', ')}`);
  }
  return parsed as HostId[];
}

function invocationTimeoutMs(): number {
  const raw = process.env.FLOWGUARD_RUNTIME_SMOKE_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`FLOWGUARD_RUNTIME_SMOKE_TIMEOUT_MS must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): RunResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env, FORCE_COLOR: '0' },
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? '',
    stderr: [result.stderr ?? '', result.error?.message ?? ''].filter(Boolean).join('\n'),
  };
}

function runRequired(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): string {
  const result = runCommand(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function assertHostBinaryAvailable(host: HostId): void {
  const binary = HOST_BINARY[host];
  const result = runCommand(binary, ['--version'], { timeoutMs: 10_000 });
  if (result.status !== 0) {
    throw new Error(
      `Host binary is required for runtime smoke but failed: ${binary} --version\n` +
        `${result.stdout}\n${result.stderr}`,
    );
  }
}

function createRuntimeProject(rootDir: string, host: HostId, flow: SmokeFlow): RuntimeProject {
  const projectDir = path.join(rootDir, `${host}-${flow}`);
  const configDir = path.join(rootDir, `${host}-${flow}-config`);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: `flowguard-runtime-smoke-${host}-${flow}`, private: true }, null, 2),
  );
  writeFileSync(path.join(projectDir, 'README.md'), `# FlowGuard runtime smoke ${host} ${flow}\n`);
  return { host, flow, projectDir, configDir };
}

function installFlowGuard(project: RuntimeProject, tarballPath: string): void {
  runRequired(
    process.execPath,
    [
      CLI_ENTRY,
      'install',
      '--install-scope',
      'repo',
      '--platform',
      project.host,
      '--policy-mode',
      'solo',
      '--core-tarball',
      tarballPath,
      '--force',
    ],
    {
      cwd: project.projectDir,
      env: runtimeEnv(project),
      timeoutMs: 60_000,
    },
  );
}

function runtimeEnv(project: RuntimeProject): NodeJS.ProcessEnv {
  return {
    OPENCODE_CONFIG_DIR: project.configDir,
    FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
    FLOWGUARD_HOST_PLATFORM: project.host,
  };
}

function assertInstalledHostArtifacts(project: RuntimeProject): void {
  const expectedPaths: Readonly<Record<HostId, readonly string[]>> = {
    opencode: [
      '.opencode/tools/flowguard.ts',
      '.opencode/plugins/flowguard-audit.ts',
      '.opencode/commands/plan.md',
      '.opencode/commands/implement.md',
      '.opencode/commands/review.md',
      '.opencode/commands/architecture.md',
      '.opencode/agents/flowguard-reviewer.md',
      'opencode.json',
    ],
    'claude-code': [
      '.claude/flowguard-plugin/.claude-plugin/plugin.json',
      '.claude/flowguard-plugin/.mcp.json',
      '.claude/flowguard-plugin/hooks/hooks.json',
      '.claude/flowguard-plugin/skills/plan/SKILL.md',
      '.claude/flowguard-plugin/agents/flowguard-reviewer.md',
    ],
    codex: [
      'plugins/flowguard/.codex-plugin/plugin.json',
      'plugins/flowguard/.mcp.json',
      'plugins/flowguard/hooks/hooks.json',
      'plugins/flowguard/skills/plan/SKILL.md',
      'plugins/flowguard/subagents/flowguard-reviewer.md',
      '.agents/plugins/marketplace.json',
    ],
  };

  for (const relativePath of expectedPaths[project.host]) {
    expect(existsSync(path.join(project.projectDir, relativePath)), relativePath).toBe(true);
  }
}

function hostArgs(project: RuntimeProject, prompt: string): string[] {
  if (project.host === 'opencode') return ['run', prompt];
  if (project.host === 'claude-code') {
    return [
      '--plugin-dir',
      path.join(project.projectDir, '.claude', 'flowguard-plugin'),
      '-p',
      prompt,
      '--output-format',
      'stream-json',
    ];
  }
  return ['--non-interactive', '--prompt', prompt];
}

function flowPrompt(flow: SmokeFlow): string {
  if (flow === 'main') {
    return [
      'Run a FlowGuard runtime smoke test in this repository.',
      'Execute the main flow exactly once: /start, /task, /plan, and /implement.',
      'Use a STANDARD task class and the objective "runtime smoke verifies MCP review convergence".',
      'Keep all generated evidence minimal and deterministic.',
      'If a reviewer is required, invoke the configured FlowGuard reviewer transport and submit validated findings.',
      'Stop after /implement records implementation evidence.',
    ].join(' ');
  }
  if (flow === 'architecture') {
    return [
      'Run a FlowGuard architecture runtime smoke test in this repository.',
      'Execute /start, then /architecture for an ADR titled "Runtime Smoke ADR".',
      'Use the decision "Keep FlowGuard state as the review SSOT" with minimal context and consequences.',
      'If a reviewer is required, invoke the configured FlowGuard reviewer transport and submit validated findings.',
      'Stop after architecture evidence is recorded or completed.',
    ].join(' ');
  }
  return [
    'Run a FlowGuard standalone review runtime smoke test in this repository.',
    'Execute /start, then /review with manual text: "Runtime smoke validates FlowGuard review report generation."',
    'If a reviewer is required, invoke the configured FlowGuard reviewer transport and submit validated findings.',
    'Stop after the review report evidence is recorded.',
  ].join(' ');
}

function runHostFlow(project: RuntimeProject): void {
  const result = runCommand(
    HOST_BINARY[project.host],
    hostArgs(project, flowPrompt(project.flow)),
    {
      cwd: project.projectDir,
      env: runtimeEnv(project),
      timeoutMs: invocationTimeoutMs(),
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `${project.host} ${project.flow} runtime smoke failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function readLatestState(project: RuntimeProject): Record<string, unknown> {
  const pointerPath = path.join(project.configDir, 'SESSION_POINTER.json');
  if (!existsSync(pointerPath)) {
    throw new Error(`Runtime smoke did not create ${pointerPath}`);
  }
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { activeSessionDir?: string };
  if (!pointer.activeSessionDir)
    throw new Error('Runtime smoke session pointer has no activeSessionDir');
  const statePath = path.join(pointer.activeSessionDir, 'session-state.json');
  if (!existsSync(statePath)) throw new Error(`Runtime smoke did not create ${statePath}`);
  return JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
}

function assertFlowEvidence(flow: SmokeFlow, state: Record<string, unknown>): void {
  expect(typeof state.phase).toBe('string');
  if (flow === 'main') {
    expect(state.ticket, 'ticket evidence').toBeTruthy();
    expect(state.plan, 'plan evidence').toBeTruthy();
    expect(state.implementation, 'implementation evidence').toBeTruthy();
    return;
  }
  if (flow === 'architecture') {
    expect(state.architecture, 'architecture evidence').toBeTruthy();
    return;
  }
  expect(state.reviewReportPath, 'review report path').toEqual(expect.any(String));
}

const describeRuntimeSmoke = RUNTIME_SMOKE_ENABLED ? describe : describe.skip;

describeRuntimeSmoke('FlowGuard real host runtime smoke', () => {
  let rootDir = '';
  let tarballPath = '';

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error('Built CLI missing; run npm run build before runtime smoke tests.');
    }

    rootDir = mkdtempSync(path.join(tmpdir(), 'fg-runtime-smoke-'));
    const packDir = path.join(rootDir, 'pack');
    mkdirSync(packDir, { recursive: true });
    const packOutput = runRequired('npm', ['pack', '--pack-destination', packDir, '--silent'], {
      timeoutMs: 60_000,
    });
    const tarballName = packOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!tarballName) throw new Error(`npm pack did not return a tarball name: ${packOutput}`);
    tarballPath = path.join(packDir, tarballName);
  }, 120_000);

  afterAll(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  for (const host of selectedHosts()) {
    for (const flow of ['main', 'architecture', 'review'] as const satisfies readonly SmokeFlow[]) {
      it(`${host} executes ${flow} flow and persists FlowGuard evidence`, () => {
        assertHostBinaryAvailable(host);
        const project = createRuntimeProject(rootDir, host, flow);
        installFlowGuard(project, tarballPath);
        assertInstalledHostArtifacts(project);
        runHostFlow(project);
        assertFlowEvidence(flow, readLatestState(project));
      });
    }
  }
});
