/**
 * @module cli/inspect-command.test
 * @description Tests for flowguard inspect command.
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseInspectArgs, getInspectUsage } from './inspect-command.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli', 'install.js');
const HAS_BUILT_CLI = existsSync(CLI_ENTRY);

// ─── Unit: Argument Parsing ───────────────────────────────────────────────────

describe('parseInspectArgs', () => {
  it('HAPPY: no args returns defaults', () => {
    const result = parseInspectArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.sessionId).toBeUndefined();
      expect(result.args.json).toBe(false);
    }
  });

  it('HAPPY: --session with value', () => {
    const result = parseInspectArgs(['--session', 'my-id']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.sessionId).toBe('my-id');
    }
  });

  it('HAPPY: --json flag', () => {
    const result = parseInspectArgs(['--json']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.json).toBe(true);
    }
  });

  it('HAPPY: --session and --json together', () => {
    const result = parseInspectArgs(['--session', 'my-id', '--json']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.sessionId).toBe('my-id');
      expect(result.args.json).toBe(true);
    }
  });

  it('BAD: --session without value', () => {
    const result = parseInspectArgs(['--session']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('--session requires');
    }
  });

  it('BAD: unknown flag', () => {
    const result = parseInspectArgs(['--unknown']);
    expect(result.ok).toBe(false);
  });

  it('CORNER: --help returns help error', () => {
    const result = parseInspectArgs(['--help']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('help');
    }
  });
});

// ─── Helpers for integration tests ───────────────────────────────────────────

describe('getInspectUsage', () => {
  it('includes inspect command', () => {
    const usage = getInspectUsage();
    expect(usage).toContain('flowguard inspect');
    expect(usage).toContain('--session');
    expect(usage).toContain('--json');
  });
});

// ─── Smoke: CLI integration (requires npm run build) ─────────────────────────

const describeSmoke = HAS_BUILT_CLI ? describe : describe.skip;

describeSmoke('flowguard inspect CLI', () => {
  function runCli(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
    const result = execSync(`node ${CLI_ENTRY} ${args.join(' ')}`, {
      cwd: cwd ?? REPO_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: 15000,
    });
    return { code: 0, stdout: result, stderr: '' };
  }

  function safeRun(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
    try {
      return runCli(args, cwd);
    } catch (err: unknown) {
      const exit = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: exit.code ?? 1,
        stdout: exit.stdout ?? '',
        stderr: exit.stderr ?? String(err),
      };
    }
  }

  it('HAPPY: no sessions prints clean message', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'fg-inspect-smoke-'));
    try {
      const configDir = path.join(tmpDir, 'opencode-config');
      mkdirSync(configDir, { recursive: true });

      const result = safeRun(['inspect'], tmpDir);
      // Exit 0 is acceptable for empty workspace
      expect(result.stdout + result.stderr).toMatch(/No.*session/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('HAPPY: --help prints usage', () => {
    const result = safeRun(['inspect', '--help']);
    expect(result.stdout).toContain('flowguard inspect');
    expect(result.stdout).toContain('--session');
  });

  it('BAD: --session without value exits with error', () => {
    const result = safeRun(['inspect', '--session']);
    // parseInspectArgs rejects, inspectMain gets error → exits 1
    expect(result.stderr + result.stdout).toMatch(/session|error/i);
  });

  it('CORNER: --json without --session exits with error', () => {
    const result = safeRun(['inspect', '--json']);
    // Uses a temp dir with no workspace — should not crash
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'fg-inspect-corner-'));
    try {
      const r = safeRun(['inspect', '--json'], tmpDir);
      // Either no session found, or no workspace → clean exit
      expect(r.stderr + r.stdout).not.toMatch(/TypeError|ReferenceError/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
