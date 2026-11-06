/** Native ACP process lifecycle only; not an ACP conversation or governance proof. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createIsolatedOpenCodeEnvironment,
  resolvePinnedOpenCodeHost,
  type PinnedOpenCodeHost,
} from './opencode-live-host-test-helpers.js';

const ENABLED = process.env.RUN_OPENCODE_ACP_TESTS === '1';
describe.skipIf(!ENABLED)('ACP Smoke', () => {
  let root: string;
  let host: PinnedOpenCodeHost;
  let env: NodeJS.ProcessEnv;
  let child: ChildProcess | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let output = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'fg-native-acp-'));
    host = resolvePinnedOpenCodeHost();
    env = createIsolatedOpenCodeEnvironment(root, host);
  });
  async function stop() {
    if (!child || !closed) return;
    if (child.exitCode === null && child.signalCode === null) {
      const current = child;
      const signal = (value: NodeJS.Signals) => {
        if (process.platform !== 'win32' && current.pid) process.kill(-current.pid, value);
        else current.kill(value);
      };
      signal('SIGTERM');
      const deadline = setTimeout(() => signal('SIGKILL'), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(deadline);
      }
    }
    child.stdin?.destroy();
    child = undefined;
    closed = undefined;
  }
  afterEach(stop);
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (host?.env.npm_config_cache)
      await rm(host.env.npm_config_cache, { recursive: true, force: true });
  });
  function start() {
    output = '';
    child = spawn(host.command, [...host.argsPrefix, 'acp'], {
      cwd: root,
      env,
      // ACP is a stdio server: EOF is shutdown, not a keepalive.
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const current = child;
    closed = new Promise((resolve, reject) => {
      current.once('error', reject);
      current.once('close', (code, signal) => resolve({ code, signal }));
    });
    // The same failure is awaited below; do not leave an unhandled rejection
    // between process creation and the assertion.
    void closed.catch(() => {});
    current.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    current.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
  }
  async function remainsAlive(milliseconds: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed!.then((result) => {
          throw new Error(
            `ACP exited before the lifecycle observation: ${JSON.stringify(result)}\n${output}`,
          );
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
      ]);
      expect(child?.exitCode, output).toBeNull();
      expect(child?.signalCode, output).toBeNull();
    } finally {
      clearTimeout(timer);
    }
  }
  it('opencode command reports the exact native candidate version', () => {
    expect(
      execFileSync(host.command, [...host.argsPrefix, '--version'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      }).trim(),
    ).toBe(host.version);
  });
  it('acp subcommand remains alive with an open stdio input', async () => {
    start();
    await remainsAlive(3_000);
  }, 15_000);
  it('process can be terminated and its actual close is observed', async () => {
    start();
    await remainsAlive(500);
    const terminated = closed!;
    await stop();
    const result = await terminated;
    // The pinned native CLI handles SIGTERM and reports cancellation as 130;
    // Node may instead observe the signal directly. A kill request alone is
    // never success, nor is forced SIGKILL cleanup.
    expect(result.signal === 'SIGTERM' || result.code === 130, JSON.stringify(result)).toBe(true);
  }, 15_000);
});
