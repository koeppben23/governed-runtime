/**
 * @module cli/cli-contract-smoke.test
 * @description CLI Smoke Classification Suite (T5).
 *
 * This is intentionally process-level smoke coverage, not a second copy of the
 * tool-handler integration tests. It proves the built CLI entry point starts,
 * reports usage, and reaches doctor/run routing without crashing.
 *
 * Run with: npm run test:smoke
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli', 'install.js');
const HAS_BUILT_CLI = existsSync(CLI_ENTRY);

if (process.env.CI === 'true' && !HAS_BUILT_CLI) {
  throw new Error('Built CLI missing; run npm run build before test:smoke');
}

function runCli(
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      resolve({ code: 124, stdout, stderr });
    }, options.timeoutMs ?? 10_000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: code ?? 0, stdout, stderr });
    });
    proc.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: 1, stdout, stderr: stderr + String(error) });
    });
  });
}

(HAS_BUILT_CLI ? describe : describe.skip)('CLI smoke classification', () => {
  it('HAPPY: built flowguard entrypoint starts and prints usage without args', async () => {
    const result = await runCli([]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Usage: flowguard');
  });

  it('BAD: install without required tarball fails without crashing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-smoke-install-'));
    try {
      const result = await runCli(['install', '--install-scope', 'repo'], { cwd: tmpDir });
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/core-tarball|Error|Installing FlowGuard/i);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('CORNER: doctor on empty repo starts and reports checks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-smoke-doctor-'));
    try {
      const result = await runCli(['doctor', '--install-scope', 'repo'], { cwd: tmpDir });
      expect(result.code).not.toBe(124);
      expect(result.stdout).toContain('Checking FlowGuard installation');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('EDGE: run subcommand exposes non-interactive usage path', async () => {
    const result = await runCli(['run', '--help']);
    expect(result.code).not.toBe(124);
    expect(result.stdout + result.stderr).toMatch(/flowguard run|Usage|prompt/i);
  });
});
