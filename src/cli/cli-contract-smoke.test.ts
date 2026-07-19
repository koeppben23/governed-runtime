/**
 * @module cli/cli-contract-smoke.test
 * @description CLI Smoke Classification Suite (T5).
 *
 * This is intentionally process-level smoke coverage, not a second copy of the
 * tool-handler integration tests. It proves the built CLI entry point respects
 * exit codes, stdout/stderr separation, help behaviour, and error contract.
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
  describe('HAPPY — help and usage contract', () => {
    it('--help exits 0 and prints usage to stdout', async () => {
      const r = await runCli(['--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage:');
    });

    it('run --help exits 0', async () => {
      const r = await runCli(['run', '--help']);
      expect(r.code).toBe(0);
    });

    it('serve --help exits 0', async () => {
      const r = await runCli(['serve', '--help']);
      expect(r.code).toBe(0);
    });

    it('install --help exits 0', async () => {
      const r = await runCli(['install', '--help']);
      expect(r.code).toBe(0);
    });
  });

  describe('BAD — error contract', () => {
    it('no command exits 2 with error on stderr', async () => {
      const r = await runCli([]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('No command');
    });

    it('unknown command exits 2 with error on stderr', async () => {
      const r = await runCli(['unknown-cmd']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('Unknown command');
    });

    it('error text does not appear on stdout', async () => {
      const r = await runCli(['unknown-cmd']);
      expect(r.stdout).not.toContain('error');
      expect(r.stdout).not.toContain('Unknown');
    });

    it('invalid run host exits 2', async () => {
      const r = await runCli(['run', '--host', 'invalid', '--', 'x']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('Invalid host');
    });

    it('serve --port out of range exits 2', async () => {
      const r = await runCli(['serve', '--port', '99999']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--port');
    });

    it('run --host missing value exits 2', async () => {
      const r = await runCli(['run', '--host']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('requires a value');
    });

    it('run extra positional exits 2', async () => {
      const r = await runCli(['run', 'extra1', 'extra2']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('extra');
    });

    it('serve unexpected positional exits 2', async () => {
      const r = await runCli(['serve', 'unexpected']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('positional');
    });

    it('run -- without prompt exits 2', async () => {
      const r = await runCli(['run', '--']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('Prompt is required');
    });
  });

  describe('CORNER — doctor and install output', () => {
    it('doctor on empty repo reports NOT_VERIFIED with non-zero exit', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-smoke-doctor-'));
      try {
        const r = await runCli(['doctor', '--install-scope', 'repo'], { cwd: tmpDir });
        expect(r.code).toBe(1);
        expect(r.stdout).toContain('NOT_VERIFIED');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('install without tarball fails without crashing', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-smoke-install-'));
      try {
        const r = await runCli(['install', '--install-scope', 'repo'], { cwd: tmpDir });
        expect(r.code).toBe(1);
        expect(r.stdout + r.stderr).toMatch(/core-tarball|Error|Installing FlowGuard/i);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('EDGE — doctor output contains health status', () => {
    it('doctor on empty repo renders health status', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-smoke-doctor-status-'));
      try {
        const r = await runCli(['doctor', '--install-scope', 'repo'], { cwd: tmpDir });
        expect(r.stdout).toContain('Status:');
        expect(r.stdout).toMatch(/HEALTHY|HEALTHY_WITH_WARNINGS|NOT_VERIFIED/);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
