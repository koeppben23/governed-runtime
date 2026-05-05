/**
 * @module cli/install-cli.test
 * @description Tests for formatResult, formatDoctor, and main() CLI entrypoint.
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { formatResult, formatDoctor, main } from './install.js';
import type { CliResult, DoctorCheck } from './install.js';
import {
  VERSION,
  tmpDir,
  repoArgs,
  createMockTarball,
  setupCliTestEnvironment,
} from './install-test-helpers.test.js';

// ─── Mock: child_process ──────────────────────────────────────────────────────
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

// ─── formatResult / formatDoctor ──────────────────────────────────────────────

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
        warnings: [],
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
        warnings: [],
      };
      const output = formatResult(result);
      expect(output).toContain('[error]');
      expect(output).toContain('something broke');
    });
  });

  describe('CORNER', () => {
    it('handles empty ops, errors, and warnings gracefully', () => {
      const result: CliResult = { target: '/tmp/test', ops: [], errors: [], warnings: [] };
      const output = formatResult(result);
      expect(typeof output).toBe('string');
    });

    it('formats warnings when present', () => {
      const result: CliResult = {
        target: '/tmp/test',
        ops: [],
        errors: [],
        warnings: ['something was modified'],
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
      const output = formatDoctor(checks);
      expect(output).toContain('2/3 checks passed');
    });

    it('formatDoctor shows status labels for all statuses', () => {
      const checks: DoctorCheck[] = [
        { file: 'a', status: 'ok' },
        { file: 'b', status: 'missing' },
        { file: 'c', status: 'modified', detail: 'digest mismatch' },
        { file: 'd', status: 'unmanaged' },
        { file: 'e', status: 'version_mismatch', detail: 'v1 != v2' },
        { file: 'f', status: 'instruction_missing' },
        { file: 'g', status: 'instruction_stale' },
        { file: 'h', status: 'error', detail: 'malformed' },
      ];
      const output = formatDoctor(checks);
      expect(output).toContain('[ok]');
      expect(output).toContain('[MISSING]');
      expect(output).toContain('[MODIFIED]');
      expect(output).toContain('[UNMANAGED]');
      expect(output).toContain('[VERSION]');
      expect(output).toContain('[INSTR_MISSING]');
      expect(output).toContain('[INSTR_STALE]');
      expect(output).toContain('[ERROR]');
    });
  });

  describe('PERF', () => {
    it('formatting 100 ops is sub-millisecond', () => {
      const ops = Array.from({ length: 100 }, (_, i) => ({
        path: `/tmp/file-${i}.ts`,
        action: 'written' as const,
      }));
      const result: CliResult = { target: '/tmp', ops, errors: [], warnings: [] };
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        formatResult(result);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ─── main ─────────────────────────────────────────────────────────────────────

describe('cli/main', () => {
  describe('HAPPY', () => {
    it('returns 0 for successful install (repo scope)', async () => {
      const tarball = await createMockTarball();
      const code = await main(['install', '--install-scope', 'repo', '--core-tarball', tarball]);
      expect(code).toBe(0);
    });

    it('returns 0 for doctor after install (repo scope)', async () => {
      const tarball = await createMockTarball();
      await main(['install', '--install-scope', 'repo', '--core-tarball', tarball]);
      const code = await main(['doctor', '--install-scope', 'repo']);
      expect(code).toBe(0);
    });
  });

  describe('BAD', () => {
    it('returns 1 for invalid args', async () => {
      const code = await main([]);
      expect(code).toBe(1);
    });

    it('returns 1 for unknown command', async () => {
      const code = await main(['deploy']);
      expect(code).toBe(1);
    });

    it('returns 1 when install is called without --core-tarball', async () => {
      const code = await main(['install', '--install-scope', 'repo']);
      expect(code).toBe(1);
    });
  });

  describe('CORNER', () => {
    it('returns 1 for doctor on empty directory (repo scope)', async () => {
      const code = await main(['doctor', '--install-scope', 'repo']);
      expect(code).toBe(1);
    });

    it('deprecated --project still works via main() but requires --core-tarball', async () => {
      const tarball = await createMockTarball();
      const code = await main(['install', '--project', '--core-tarball', tarball]);
      expect(code).toBe(0);
    });
  });

  describe('EDGE', () => {
    it('uninstall returns 0 even if nothing was installed (repo scope)', async () => {
      const code = await main(['uninstall', '--install-scope', 'repo']);
      expect(code).toBe(0);
    });

    it('doctor returns 0 when only warn checks present (no errors)', async () => {
      const tarball = await createMockTarball();
      await main(['install', '--install-scope', 'repo', '--core-tarball', tarball]);
      // Overwrite opencode.json to simulate desktop-owned config missing task hardening
      const ocPath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(
        ocPath,
        JSON.stringify(
          {
            plugin: ['flowguard-audit'],
            instructions: ['.opencode/flowguard-mandates.md'],
          },
          null,
          2,
        ),
        'utf-8',
      );
      const code = await main(['doctor', '--install-scope', 'repo']);
      // warn for task-hardening, but no hard error → exit 0
      expect(code).toBe(0);
    });

    it('doctor returns 1 when real errors exist', async () => {
      // Empty dir, no install → missing artifacts → exit 1
      const code = await main(['doctor', '--install-scope', 'repo']);
      expect(code).toBe(1);
    });
  });

  describe('PERF', () => {
    it('main dispatch overhead is negligible', async () => {
      const tarball = await createMockTarball();
      const start = performance.now();
      await main(['install', '--install-scope', 'repo', '--core-tarball', tarball]);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
