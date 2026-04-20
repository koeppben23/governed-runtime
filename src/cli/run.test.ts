/**
 * @module cli/run.test
 * @description Tests for headless run/serve wrapper.
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

    it('parses -- for prompt', () => {
      const result = parseRunArgs(['--', 'Run /hydrate']);
      expect(result).not.toBeNull();
      expect(result?.config.prompt).toBe('Run /hydrate');
    });

    it('parses double-dash with args', () => {
      const result = parseRunArgs(['--', 'Run', '/hydrate', 'policy=team']);
      expect(result).not.toBeNull();
      expect(result?.config.prompt).toBe('Run /hydrate policy=team');
    });

    it('parses --cwd', () => {
      const result = parseRunArgs(['--cwd', '/some/path', 'Run /validate']);
      expect(result).not.toBeNull();
      expect(result?.config.cwd).toBe('/some/path');
    });
  });

  describe('bad path', () => {
    it('returns null when prompt missing', () => {
      const result = parseRunArgs([]);
      expect(result).toBeNull();
    });

    it('returns null when --prompt missing value', () => {
      const result = parseRunArgs(['--prompt']);
      expect(result).toBeNull();
    });
  });

  describe('corner cases', () => {
    it('handles prompt with special chars', () => {
      const result = parseRunArgs(['Run /plan "quotes" <brackets>']);
      expect(result).not.toBeNull();
      expect(result?.config.prompt).toBe('Run /plan "quotes" <brackets>');
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

    it('parses --detach', () => {
      const result = parseServeArgs(['--detach']);
      expect(result).not.toBeNull();
      expect(result?.config.detach).toBe(true);
    });

    it('parses all flags', () => {
      const result = parseServeArgs(['--port', '8080', '--detach', '--cwd', '/ws']);
      expect(result).not.toBeNull();
      expect(result?.config.port).toBe(8080);
      expect(result?.config.detach).toBe(true);
      expect(result?.config.cwd).toBe('/ws');
    });
  });

  describe('bad path', () => {
    it('returns null when --port missing', () => {
      const result = parseServeArgs(['--port']);
      expect(result).toBeNull();
    });

    it('returns null when --port invalid', () => {
      const result = parseServeArgs(['--port', 'not-a-number']);
      expect(result).toBeNull();
    });

    it('returns null when --port out of range', () => {
      const result = parseServeArgs(['--port', '0']);
      expect(result).toBeNull();
    });
  });
});

describe('formatRunResult', () => {
  it('formats success with output', () => {
    const result = formatRunResult({ success: true, output: 'Output' });
    expect(result).toContain('Output');
  });

  it('formats failure', () => {
    const result = formatRunResult({ success: false, error: 'Failed' });
    expect(result).toContain('[error]');
    expect(result).toContain('Failed');
  });
});

describe('getRunUsage', () => {
  it('contains Usage', () => {
    expect(getRunUsage()).toContain('Usage:');
  });

  it('mentions OpenCode directly', () => {
    expect(getRunUsage()).toContain('opencode run');
  });
});

describe('getServeUsage', () => {
  it('contains Usage', () => {
    expect(getServeUsage()).toContain('Usage:');
  });

  it('mentions OpenCode directly', () => {
    expect(getServeUsage()).toContain('opencode serve');
  });
});