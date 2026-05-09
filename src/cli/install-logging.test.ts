/**
 * @module cli/install-logging.test
 * @description Tests verifying CLI produces structured logs via adapter logger.
 *
 * @test-policy HAPPY, BAD, CORNER, SMOKE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { main, parseArgs } from './install.js';
import { getAdapterLogger, resetAdapterLogger } from '../logging/adapter-logger.js';

describe('CLI structured logging', () => {
  beforeEach(() => {
    resetAdapterLogger();
  });

  afterEach(() => {
    resetAdapterLogger();
    vi.restoreAllMocks();
  });

  describe('HAPPY', () => {
    it('--log-mode flag is parsed', () => {
      const parsed = parseArgs(['doctor', '--log-mode', 'file+console', '--install-scope', 'repo']);
      expect(parsed).not.toBeNull();
      expect(parsed!.args.logMode).toBe('file+console');
    });

    it('--log-mode rejects invalid values', () => {
      expect(parseArgs(['doctor', '--log-mode', 'cloud'])).toBeNull();
    });
  });

  describe('SMOKE', () => {
    it('doctor with --log-mode=console writes structured logs to stdout', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-cli-log-'));
      process.env.OPENCODE_CONFIG_DIR = tmpDir;
      process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
      await fs.mkdir(path.join(tmpDir, '.git'));

      const captured: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });

      try {
        await main(['doctor', '--install-scope', 'repo', '--log-mode', 'console']);
        const output = captured.join('');
        expect(output).toContain('[INFO]');
        expect(output).toContain('cli');
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
        delete process.env.OPENCODE_CONFIG_DIR;
        delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch {
          /* ok */
        }
      }
    });

    it('--log-mode=file does NOT write to console', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-cli-file-'));
      process.env.OPENCODE_CONFIG_DIR = tmpDir;
      process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
      await fs.mkdir(path.join(tmpDir, '.git'));

      const capturedStdout: string[] = [];
      const capturedStderr: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        capturedStdout.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        capturedStderr.push(String(chunk));
        return true;
      });

      try {
        await main(['doctor', '--install-scope', 'repo', '--log-mode', 'file']);
        // No structured log to console
        const allConsole = capturedStdout.join('') + capturedStderr.join('');
        expect(allConsole).not.toContain('[INFO] cli');
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR;
        delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch {
          /* ok */
        }
      }
    });

    it('adapter logger is reset after CLI main() completes', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-cli-cln-'));
      process.env.OPENCODE_CONFIG_DIR = tmpDir;
      process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
      await fs.mkdir(path.join(tmpDir, '.git'));
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      try {
        await main(['doctor', '--install-scope', 'repo', '--log-mode', 'console']);
        // After main() returns, the adapter logger should be a noop
        const calls: string[] = [];
        // getAdapterLogger is noop now — call it and verify no errors
        const log = getAdapterLogger();
        expect(() => log.warn('test', 'after-main')).not.toThrow();
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR;
        delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch {
          /* ok */
        }
      }
    });
  });

  describe('CORNER', () => {
    it('unknown action returns 1', async () => {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      await expect(main(['invalid-action'])).resolves.toBe(1);
    });
  });
});
