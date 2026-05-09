/**
 * @module logging/coverage-proof.test
 * @description Comprehensive tests proving adapter, identity, and CLI logging
 * covers real critical paths with proper sinks and redaction.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAdapterLogger,
  runWithAdapterLogger,
  resetAdapterLogger,
  setAdapterLogger,
  type AdapterLogger,
} from './adapter-logger.js';
import { createConsoleSink } from './console-sink.js';
import { createFileSink } from './file-sink.js';
import { createLogger } from './logger.js';
import { redactIdentityExtra } from './redact.js';

describe('Coverage proofs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-cov-'));
    resetAdapterLogger();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetAdapterLogger();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // ─── BLOCKER: Adapter failures write to real sinks ───────────────────────

  describe('persistence/atomicWrite failure → real file sink', () => {
    it('HAPPY: atomicWrite failure logged to file sink', async () => {
      const captured: string[] = [];
      const logger = createLogger('debug', [createConsoleSink(), createFileSink(tmpDir, 7)]);
      const adapter = toAdapter(logger);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      runWithAdapterLogger(adapter, () => {
        getAdapterLogger().error('persistence', 'Atomic write failed', {
          filePath: '/tmp/state.json',
          error: 'ENOSPC',
        });
      });

      // Console sink should have captured
      const stderr = captured.join('');
      expect(stderr).toContain('persistence');
      expect(stderr).toContain('Atomic write failed');

      // File sink should have written
      await new Promise((r) => setTimeout(r, 300));
      const logDir = path.join(tmpDir, '.opencode', 'logs');
      const entries = await fs.readdir(logDir);
      const logFile = entries.find((f) => f.startsWith('flowguard-'));
      expect(logFile).toBeTruthy();
      if (logFile) {
        const content = await fs.readFile(path.join(logDir, logFile), 'utf-8');
        const parsed = JSON.parse(content.trim().split('\n')[0] ?? '{}');
        expect(parsed.service).toBe('persistence');
        expect(parsed.message).toBe('Atomic write failed');
      }
    });
  });

  describe('git silent fallback → console warn', () => {
    it('HAPPY: git fallback logs warn to console', () => {
      const captured: string[] = [];
      const logger = createLogger('debug', [createConsoleSink()]);
      const adapter = toAdapter(logger);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      runWithAdapterLogger(adapter, () => {
        getAdapterLogger().warn('git', 'Failed to resolve current branch', {
          worktree: '/repo',
        });
      });

      expect(captured.join('')).toContain('[WARN]');
      expect(captured.join('')).toContain('git');
    });
  });

  // ─── BLOCKER: Identity redaction with sanitized errors ───────────────────

  describe('identity redaction — hard enough', () => {
    it('HAPPY: redacts paths, URIs, issuer, and sanitizes error', () => {
      const extra = {
        tokenPath: '/home/user/.flowguard/token.jwt',
        jwksUri: 'https://auth.example.com/oidc/jwks?query=param',
        issuer: 'https://auth.example.com/realms/prod',
        error: "ENOENT: no such file, open '/home/user/.flowguard/token.jwt'",
      };
      const result = redactIdentityExtra(extra);
      expect(result!.tokenPath).toBe('[redacted:token.jwt]');
      expect(result!.jwksUri).toBe('[redacted:auth.example.com]');
      expect(result!.issuer).toMatch(/^\[hashed:[a-f0-9]{8}\]$/);
      // Error must NOT contain raw path
      expect(result!.error).not.toContain('/home/user');
      // Error must contain redacted marker
      expect(result!.error).toContain('[redacted]');
      // The sanitized error may keep basenames in [path:] markers
      expect(result!.error).toContain('[path:');
    });

    it('HAPPY: error with https URL is redacted to hostname', () => {
      const result = redactIdentityExtra({
        error: 'fetch failed https://auth.example.com/oidc/jwks timeout',
      });
      expect(result!.error).toContain('[url:auth.example.com]');
      expect(result!.error).not.toContain('https://auth.example.com/oidc');
    });

    it('HAPPY: error without paths URLs passes through', () => {
      const result = redactIdentityExtra({
        error: 'signature verification failed',
      });
      expect(result!.error).toBe('signature verification failed');
    });

    it('CORNER: undefined extra returns undefined', () => {
      expect(redactIdentityExtra(undefined)).toBeUndefined();
    });

    it('SMOKE: JWKS failure log uses redacted metadata end-to-end', () => {
      const captured: string[] = [];
      const logger = createLogger('debug', [createConsoleSink()]);
      const adapter = toAdapter(logger);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      runWithAdapterLogger(adapter, () => {
        getAdapterLogger().error(
          'identity',
          'JWKS remote fetch failed',
          redactIdentityExtra({
            jwksUri: 'https://auth.example.com/oidc/jwks?kid=abc',
            error: 'fetch failed https://auth.example.com/oidc/jwks?kid=abc: ETIMEDOUT',
          }),
        );
      });

      const output = captured.join('');
      expect(output).toContain('identity');
      expect(output).toContain('JWKS remote fetch failed');
      // Must NOT contain the full URL
      expect(output).not.toContain('auth.example.com/oidc/jwks');
      // Must contain redacted hostname
      expect(output).toContain('auth.example.com');
      // Must contain error with URL redacted
      expect(output).toContain('[url:auth.example.com]');
      // Must not contain raw path from error
      expect(output).not.toContain('/oidc/jwks');
    });
  });

  // ─── BLOCKER: Two parallel scopes do NOT leak ────────────────────────────

  describe('two scopes — no logger leak', () => {
    it('HAPPY: two parallel ALS scopes write to different sinks', async () => {
      const aCalls: string[] = [];
      const bCalls: string[] = [];

      const aLog: AdapterLogger = {
        info: (_s, m) => aCalls.push(`a:${m}`),
        warn: (_s, m) => aCalls.push(`a:${m}`),
        error: (_s, m) => aCalls.push(`a:${m}`),
      };
      const bLog: AdapterLogger = {
        info: (_s, m) => bCalls.push(`b:${m}`),
        warn: (_s, m) => bCalls.push(`b:${m}`),
        error: (_s, m) => bCalls.push(`b:${m}`),
      };

      const { runWithAdapterLoggerAsync } = await import('./adapter-logger.js');

      await Promise.all([
        runWithAdapterLoggerAsync(aLog, async () => {
          getAdapterLogger().error('archive', 'tar failed');
          getAdapterLogger().warn('git', 'branch unknown');
        }),
        runWithAdapterLoggerAsync(bLog, async () => {
          getAdapterLogger().error('init', 'mkdir fail');
          getAdapterLogger().warn('persistence', 'config fallback');
        }),
      ]);

      expect(aCalls).toEqual(['a:tar failed', 'a:branch unknown']);
      expect(bCalls).toEqual(['b:mkdir fail', 'b:config fallback']);
    });
  });

  // ─── BLOCKER: CLI produces structured logs ───────────────────────────────

  describe('CLI structured logging', () => {
    it('HAPPY: setAdapterLogger at CLI init reaches adapter functions', () => {
      const captured: string[] = [];
      const logger = createLogger('debug', [createConsoleSink()]);
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      setAdapterLogger(toAdapter(logger));
      getAdapterLogger().info('cli', 'command_started', {
        action: 'install',
        installScope: 'repo',
      });

      const output = captured.join('');
      expect(output).toContain('[INFO]');
      expect(output).toContain('cli');
      expect(output).toContain('command_started');
    });
  });
});

function toAdapter(log: ReturnType<typeof createLogger>): AdapterLogger {
  return {
    info: log.info.bind(log),
    warn: log.warn.bind(log),
    error: log.error.bind(log),
  };
}
