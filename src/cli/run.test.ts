/**
 * @module cli/run.test
 * @description Unit tests for the headless run wrapper.
 *
 * Tests the argument parsing and utilities.
 * Does NOT test actual OpenCode execution (requires opencode installed).
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

    it('returns null when prompt empty', () => {
      const result = parseRunArgs([]);
      expect(result).toBeNull();
    });
  });

  describe('corner cases', () => {
    it('handles prompt with special characters', () => {
      const result = parseRunArgs(['Run /plan with: "quotes" and <brackets>']);
      expect(result).not.toBeNull();
      expect(result?.config.prompt).toBe('Run /plan with: "quotes" and <brackets>');
    });

    it('ignores flag-like strings without values', () => {
      const result = parseRunArgs(['--force']);
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

    it('parses --detach flag', () => {
      const result = parseServeArgs(['--detach']);
      expect(result).not.toBeNull();
      expect(result?.config.detach).toBe(true);
    });

    it('parses all flags', () => {
      const result = parseServeArgs([
        '--port', '8080',
        '--hostname', '0.0.0.0',
        '--detach',
      ]);
      expect(result).not.toBeNull();
      expect(result?.config.port).toBe(8080);
      expect(result?.config.hostname).toBe('0.0.0.0');
      expect(result?.config.detach).toBe(true);
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

    it('handles port boundary (65535)', () => {
      const result = parseServeArgs(['--port', '65535']);
      expect(result).not.toBeNull();
      expect(result?.config.port).toBe(65535);
    });

    it('handles negative port', () => {
      const result = parseServeArgs(['--port', '-1']);
      expect(result).toBeNull();
    });
  });
});

describe('formatRunResult', () => {
  it('formats successful result with output', () => {
    const result = formatRunResult({
      success: true,
      output: 'Some output',
    });
    expect(result).toContain('Some output');
  });

  it('formats successful result without output', () => {
    const result = formatRunResult({
      success: true,
    });
    expect(result).toContain('[ok]');
  });

  it('formats failed result', () => {
    const result = formatRunResult({
      success: false,
      error: 'Error occurred',
    });
    expect(result).toContain('[error]');
    expect(result).toContain('Error occurred');
  });
});

describe('getRunUsage', () => {
  it('contains Usage', () => {
    const usage = getRunUsage();
    expect(usage).toContain('Usage:');
  });

  it('contains EXPERIMENTAL warning', () => {
    const usage = getRunUsage();
    expect(usage).toContain('EXPERIMENTAL');
  });

  it('contains examples', () => {
    const usage = getRunUsage();
    expect(usage).toContain('Examples:');
  });
});

describe('getServeUsage', () => {
  it('contains Usage', () => {
    const usage = getServeUsage();
    expect(usage).toContain('Usage:');
  });

  it('contains EXPERIMENTAL warning', () => {
    const usage = getServeUsage();
    expect(usage).toContain('EXPERIMENTAL');
  });

  it('contains default port', () => {
    const usage = getServeUsage();
    expect(usage).toContain('4096');
  });
});