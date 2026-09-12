/**
 * @module cli/install-cli.test
 * @description Tests for formatResult, formatDoctor, and main() CLI entrypoint.
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { formatResult, formatDoctor, main } from './install.js';
import type { CliResult, DoctorCheck } from './install-types.js';
import { createMockTarball, setupCliTestEnvironment } from './install-test-helpers.test.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const mockImpl = (
    cmd: string,
    args?: string[] | { cwd?: string; stdio?: unknown; timeout?: number },
    opts?: { cwd?: string; stdio?: unknown; timeout?: number },
  ) => {
    const isVersion =
      typeof cmd === 'string' &&
      (cmd.includes('--version') || (Array.isArray(args) && args[0] === '--version'));
    if (isVersion) return Buffer.from('1.0.0\n');
    const cwd =
      (typeof opts === 'object' && opts?.cwd) ||
      (typeof args === 'object' && !Array.isArray(args) && args?.cwd);
    if (cwd) {
      const corePath = path.join(cwd, 'node_modules', '@flowguard', 'core');
      mkdirSync(corePath, { recursive: true });
      return Buffer.from('');
    }
    return Buffer.from('');
  };
  return {
    ...original,
    execFileSync: vi.fn(mockImpl),
    execSync: vi.fn(mockImpl),
  };
});

setupCliTestEnvironment();

describe('cli/formatResult', () => {
  describe('HAPPY', () => {
    it('formats install result with summary lines', () => {
      const result: CliResult = {
        target: '/tmp/test',
        ops: [
          { path: '/tmp/test/a', action: 'written' },
          { path: '/tmp/test/b', action: 'merged' },
          { path: '/tmp/test/c', action: 'skipped', reason: 'already exists' },
        ],
        errors: [],
        errorDetails: [],
        warnings: [],
        notices: [],
      };
      const output = formatResult(result);
      expect(output).toContain('Written: 1 files');
      expect(output).toContain('Merged:  1 files');
      expect(output).toContain('Skipped: 1 files');
      expect(output).toContain('already exists');
    });
  });

  describe('BAD', () => {
    it('formats errors when present', () => {
      const result: CliResult = {
        target: '/tmp/test',
        ops: [],
        errors: ['something broke'],
        errorDetails: [],
        warnings: [],
        notices: [],
      };
      const output = formatResult(result);
      expect(output).toContain('[error]');
      expect(output).toContain('something broke');
    });
  });

  describe('CORNER', () => {
    it('handles empty ops, errors, and warnings gracefully', () => {
      const result: CliResult = {
        target: '/tmp/test',
        ops: [],
        errors: [],
        errorDetails: [],
        warnings: [],
        notices: [],
      };
      expect(typeof formatResult(result)).toBe('string');
    });

    it('formats warnings when present', () => {
      const result: CliResult = {
        target: '/tmp/test',
        ops: [],
        errors: [],
        errorDetails: [],
        warnings: ['something was modified'],
        notices: [],
      };
      const output = formatResult(result);
      expect(output).toContain('[warn]');
      expect(output).toContain('something was modified');
    });
  });

  describe('EDGE', () => {
    it('formatDoctor shows ok/total counts', () => {
      const checks: DoctorCheck[] = [
        { file: 'a.ts', status: 'ok' },
        { file: 'b.ts', status: 'missing' },
        { file: 'c.ts', status: 'ok' },
      ];
      expect(formatDoctor(checks, 'opencode')).toContain('2/3 actionable checks passed');
    });

    it('formatDoctor shows status labels for all statuses', () => {
      const checks: DoctorCheck[] = [
        { file: 'a', status: 'ok' },
        { file: 'b', status: 'missing' },
        { file: 'c', status: 'modified', detail: 'digest mismatch' },
        { file: 'd', status: 'unmanaged' },
        { file: 'e', status: 'version_mismatch', detail: 'v1 != v2' },
        { file: 'f', status: 'instruction_missing' },
        { file: 'g', status: 'error', detail: 'malformed' },
      ];
      const output = formatDoctor(checks, 'opencode');
      expect(output).toContain('[ok]');
      expect(output).toContain('[MISSING]');
      expect(output).toContain('[MODIFIED]');
      expect(output).toContain('[UNMANAGED]');
      expect(output).toContain('[VERSION]');
      expect(output).toContain('[INSTR_MISSING]');
      expect(output).toContain('[ERROR]');
    });

    it('all-info checks produce NOT_VERIFIED status', () => {
      const checks: DoctorCheck[] = [
        { file: 'trust://opencode/authority', status: 'info' },
        { file: 'trust://opencode/capabilities', status: 'info' },
      ];
      const output = formatDoctor(checks, 'opencode');
      expect(output).toContain('Status: NOT_VERIFIED');
      expect(output).toContain('0/0 actionable checks passed');
    });
  });

  describe('PERF', () => {
    it('formatting 100 ops is sub-millisecond', () => {
      const ops = Array.from({ length: 100 }, (_, i) => ({
        path: `/tmp/file-${i}.ts`,
        action: 'written' as const,
      }));
      const result: CliResult = {
        target: '/tmp',
        ops,
        errors: [],
        errorDetails: [],
        warnings: [],
        notices: [],
      };
      const start = performance.now();
      for (let i = 0; i < 100; i++) formatResult(result);
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});

describe('cli/main', () => {
  describe('HAPPY', () => {
    it('returns 0 for successful install (repo scope)', async () => {
      const tarball = await createMockTarball();
      const code = await main(['install', '--install-scope', 'repo', '--core-tarball', tarball]);
      expect(code).toBe(0);
    });
  });

  describe('BAD', () => {
    it('returns 2 for invalid args', async () => {
      await expect(main([])).resolves.toBe(2);
    });

    it('returns 2 for unknown command', async () => {
      await expect(main(['deploy'])).resolves.toBe(2);
    });

    it('returns 1 when install is called without --core-tarball', async () => {
      await expect(main(['install', '--install-scope', 'repo'])).resolves.toBe(1);
    });

    it.each([
      ['--mode', 'team'],
      ['--global'],
      ['--project'],
    ])('returns 2 for removed install option %s', async (...args) => {
      await expect(main(['install', ...args])).resolves.toBe(2);
    });
  });

  describe('CORNER', () => {
    it('returns 1 for doctor on empty directory (repo scope)', async () => {
      await expect(main(['doctor', '--install-scope', 'repo'])).resolves.toBe(1);
    });
  });

  describe('EDGE', () => {
    it('uninstall returns 0 even if nothing was installed (repo scope)', async () => {
      await expect(main(['uninstall', '--install-scope', 'repo'])).resolves.toBe(0);
    });

    it('doctor returns 1 when real errors exist', async () => {
      await expect(main(['doctor', '--install-scope', 'repo'])).resolves.toBe(1);
    });
  });

  describe('PERF', () => {
    it('main dispatch overhead is negligible', async () => {
      const tarball = await createMockTarball();
      const start = performance.now();
      await main(['install', '--install-scope', 'repo', '--core-tarball', tarball]);
      expect(performance.now() - start).toBeLessThan(1000);
    });
  });
});
