/**
 * @module cli/run.test
 * @description Unit tests for the headless run wrapper.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseRunArgs,
  parseServeArgs,
  formatRunResult,
  getRunUsage,
  getServeUsage,
} from './run';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    kill: vi.fn(),
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  })),
}));

vi.mock('node:net', () => ({
  createServer: vi.fn(() => ({
    once: vi.fn(),
    listen: vi.fn(),
    close: vi.fn(),
  })),
}));

describe('parseRunArgs', () => {
  describe('happy path', () => {
    it('parses positional prompt', () => {
      const result = parseRunArgs(['Run /hydrate']);
      expect(result).not.toBeNull();
      expect(result?.config.prompt).toBe('Run /hydrate');
    });

    it('parses --prompt flag', () => {
      const result = parseRunArgs(['--prompt', 'Run /validate']);
      expect(result).not.toBeNull();
      expect(result?.config.prompt).toBe('Run /validate');
    });

    it('parses --server-url', () => {
      const result = parseRunArgs(['--server-url', 'http://localhost:4096', 'Run /validate']);
      expect(result).not.toBeNull();
      expect(result?.config.serverUrl).toBe('http://localhost:4096');
    });

    it('parses --attach flag with prompt', () => {
      const result = parseRunArgs(['--attach', 'Run /validate']);
      expect(result).not.toBeNull();
      expect(result?.config.attach).toBe(true);
      expect(result?.config.prompt).toBe('Run /validate');
    });

    it('parses --no-stop flag with prompt', () => {
      const result = parseRunArgs(['--no-stop', 'Run /validate']);
      expect(result).not.toBeNull();
      expect(result?.config.stopServerAfter).toBe(false);
    });

    it('parses --cwd', () => {
      const result = parseRunArgs(['--cwd', '/some/path', 'Run /validate']);
      expect(result).not.toBeNull();
      expect(result?.config.cwd).toBe('/some/path');
    });
  });

  describe('bad path', () => {
    it('returns null when --prompt missing value', () => {
      const result = parseRunArgs(['--prompt']);
      expect(result).toBeNull();
    });

    it('returns null when prompt and server-url both missing', () => {
      const result = parseRunArgs(['--attach']);
      expect(result).toBeNull();
    });
  });

  describe('corner cases', () => {
    it('handles prompt with special characters', () => {
      const result = parseRunArgs(['Run /plan with: special chars "quotes" and <brackets>']);
      expect(result).not.toBeNull();
      expect(result?.config.prompt).toBe('Run /plan with: special chars "quotes" and <brackets>');
    });

    it('flag-like string without prompt returns null', () => {
      const result = parseRunArgs(['--force-validate']);
      expect(result).toBeNull();
    });
  });
});

describe('parseServeArgs', () => {
  describe('happy path', () => {
    it('parses defaults', () => {
      const result = parseServeArgs([]);
      expect(result).not.toBeNull();
    });

    it('parses --port', () => {
      const result = parseServeArgs(['--port', '3000']);
      expect(result).not.toBeNull();
      expect(result?.config.port).toBe(3000);
    });

    it('parses --hostname', () => {
      const result = parseServeArgs(['--hostname', '0.0.0.0']);
      expect(result).not.toBeNull();
      expect(result?.config.hostname).toBe('0.0.0.0');
    });

    it('parses --mdns', () => {
      const result = parseServeArgs(['--mdns']);
      expect(result).not.toBeNull();
      expect(result?.config.mdns).toBe(true);
    });

    it('parses all flags together', () => {
      const result = parseServeArgs([
        '--port', '8080',
        '--hostname', '0.0.0.0',
        '--mdns',
      ]);
      expect(result).not.toBeNull();
      expect(result?.config.port).toBe(8080);
      expect(result?.config.hostname).toBe('0.0.0.0');
      expect(result?.config.mdns).toBe(true);
    });
  });

  describe('bad path', () => {
    it('returns null when --port missing value', () => {
      const result = parseServeArgs(['--port']);
      expect(result).toBeNull();
    });

    it('returns null when --port is not a number', () => {
      const result = parseServeArgs(['--port', 'not-a-number']);
      expect(result).toBeNull();
    });
  });

  describe('corner cases', () => {
    it('handles port boundary (1)', () => {
      const result = parseServeArgs(['--port', '1']);
      expect(result).not.toBeNull();
      expect(result?.config.port).toBe(1);
    });
  });
});

describe('formatRunResult', () => {
  it('formats successful result', () => {
    const result = formatRunResult({
      success: true,
      output: 'Some output',
    });
    expect(result).toContain('[ok] Command executed successfully');
  });

  it('formats failed result', () => {
    const result = formatRunResult({
      success: false,
      error: 'Something went wrong',
    });
    expect(result).toContain('[error] Something went wrong');
  });
});

describe('getRunUsage', () => {
  it('returns non-empty string', () => {
    const usage = getRunUsage();
    expect(usage.length).toBeGreaterThan(0);
  });

  it('contains Usage keyword', () => {
    const usage = getRunUsage();
    expect(usage).toContain('Usage:');
  });
});

describe('getServeUsage', () => {
  it('returns non-empty string', () => {
    const usage = getServeUsage();
    expect(usage.length).toBeGreaterThan(0);
  });

  it('contains default port', () => {
    const usage = getServeUsage();
    expect(usage).toContain('4096');
  });
});