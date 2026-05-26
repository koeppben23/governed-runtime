/**
 * @module cli/run.test
 * @description Tests for headless run/serve wrapper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveHost } from './host-resolver.js';
import {
  parseRunArgs,
  parseServeArgs,
  formatRunResult,
  getRunUsage,
  getServeUsage,
  run,
  serve,
} from './run.js';

const netState = vi.hoisted(() => ({ serverRunning: false }));

vi.mock('./host-resolver.js', () => ({
  resolveHost: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    netState.serverRunning = true;
    return {
      pid: 12345,
      kill: vi.fn(),
      unref: vi.fn(),
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: {
        on: vi.fn((event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') callback(Buffer.from('host output'));
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, callback: (code?: number) => void) => {
        if (event === 'close') queueMicrotask(() => callback(0));
      }),
    };
  }),
}));

vi.mock('node:net', () => ({
  createServer: vi.fn(() => {
    const handlers: Record<string, () => void> = {};
    return {
      once: vi.fn((event: string, callback: () => void) => {
        handlers[event] = callback;
      }),
      listen: vi.fn(() => {
        queueMicrotask(() => {
          if (netState.serverRunning) handlers.error?.();
          else handlers.listening?.();
        });
      }),
      close: vi.fn(),
    };
  }),
}));

async function createExecutable(
  name: string,
): Promise<{ binDir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fg-host-bin-'));
  const ext = platform() === 'win32' ? '.cmd' : '';
  const file = join(dir, `${name}${ext}`);
  await writeFile(file, platform() === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(file, 0o755);
  return { binDir: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

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

    it('parses --cwd', () => {
      const result = parseRunArgs(['--cwd', '/some/path', 'Run /validate']);
      expect(result).not.toBeNull();
      expect(result?.config.cwd).toBe('/some/path');
    });

    it('parses --host', () => {
      const result = parseRunArgs(['--host', 'claude-code', '--', 'Run /validate']);
      expect(result).not.toBeNull();
      expect(result?.config.host).toBe('claude-code');
      expect(result?.config.prompt).toBe('Run /validate');
    });
  });

  describe('bad path', () => {
    it('returns null when prompt missing', () => {
      expect(parseRunArgs([])).toBeNull();
    });

    it('returns null when --prompt missing value', () => {
      expect(parseRunArgs(['--prompt'])).toBeNull();
    });

    it('returns null for unknown flag', () => {
      expect(parseRunArgs(['--unknown', 'value'])).toBeNull();
    });

    it('returns null for invalid host value', () => {
      expect(parseRunArgs(['--host', 'unknown-host', '--', 'Run /hydrate'])).toBeNull();
    });

    it('returns null when --host is missing a value', () => {
      expect(parseRunArgs(['--host'])).toBeNull();
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
      expect(parseServeArgs([])).not.toBeNull();
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

    it('parses all flags', () => {
      const result = parseServeArgs([
        '--host',
        'opencode',
        '--port',
        '8080',
        '--hostname',
        '0.0.0.0',
        '--cwd',
        '/ws',
      ]);
      expect(result).not.toBeNull();
      expect(result?.config.host).toBe('opencode');
      expect(result?.config.port).toBe(8080);
      expect(result?.config.hostname).toBe('0.0.0.0');
      expect(result?.config.cwd).toBe('/ws');
    });
  });

  describe('bad path', () => {
    it('returns null when --port missing', () => {
      expect(parseServeArgs(['--port'])).toBeNull();
    });

    it('returns null when --port invalid', () => {
      expect(parseServeArgs(['--port', 'not-a-number'])).toBeNull();
    });

    it('returns null when --port out of range', () => {
      expect(parseServeArgs(['--port', '0'])).toBeNull();
    });

    it('rejects unsupported --detach flag', () => {
      expect(parseServeArgs(['--detach'])).toBeNull();
    });

    it('returns null for invalid host value', () => {
      expect(parseServeArgs(['--host', 'unknown-host'])).toBeNull();
    });

    it('returns null when --host is missing a value', () => {
      expect(parseServeArgs(['--host'])).toBeNull();
    });
  });
});

describe('run', () => {
  let cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    vi.mocked(resolveHost).mockResolvedValue({ host: 'opencode', source: 'default' });
    vi.mocked(spawn).mockClear();
    netState.serverRunning = false;
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
  });

  it('uses opencode run args by default', async () => {
    const executable = await createExecutable('opencode');
    cleanups.push(executable.cleanup);

    const result = await run({ prompt: 'do something', env: { PATH: executable.binDir } });

    expect(result.success).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining('opencode'),
      ['run', 'do something'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('spawns Claude Code with headless stream-json args', async () => {
    const executable = await createExecutable('claude');
    cleanups.push(executable.cleanup);
    vi.mocked(resolveHost).mockResolvedValue({ host: 'claude-code', source: 'cli' });

    await expect(
      run({ prompt: 'do something', host: 'claude-code', env: { PATH: executable.binDir } }),
    ).resolves.toMatchObject({ success: true });

    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining('claude'),
      ['-p', 'do something', '--output-format', 'stream-json'],
      expect.any(Object),
    );
  });

  it('spawns Codex in non-interactive prompt mode without claiming governance activation', async () => {
    const executable = await createExecutable('codex');
    cleanups.push(executable.cleanup);
    vi.mocked(resolveHost).mockResolvedValue({ host: 'codex', source: 'cli' });

    const result = await run({
      prompt: 'do something',
      host: 'codex',
      env: { PATH: executable.binDir },
    });

    expect(result).toEqual({ success: true, output: 'host output' });
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining('codex'),
      ['--non-interactive', '--prompt', 'do something'],
      expect.any(Object),
    );
  });

  it('fails explicitly when the selected host binary is missing', async () => {
    const result = await run({ prompt: 'do something', env: { PATH: '' } });

    expect(result).toEqual({ success: false, error: 'Host binary not found on PATH: opencode' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails explicitly when config resolution fails', async () => {
    vi.mocked(resolveHost).mockRejectedValue(new Error('Repo config failed schema validation'));

    await expect(run({ prompt: 'do something' })).resolves.toEqual({
      success: false,
      error: 'Repo config failed schema validation',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('serve', () => {
  let cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    vi.mocked(resolveHost).mockResolvedValue({ host: 'opencode', source: 'default' });
    vi.mocked(spawn).mockClear();
    netState.serverRunning = false;
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
  });

  it('starts opencode serve in detached mode', async () => {
    const executable = await createExecutable('opencode');
    cleanups.push(executable.cleanup);

    const result = await serve({ port: 4096, env: { PATH: executable.binDir } });

    expect(result).toEqual({ success: true, port: 4096, pid: 12345 });
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining('opencode'),
      ['serve', '--port', '4096', '--hostname', '127.0.0.1'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('blocks Claude Code serve fail-closed', async () => {
    vi.mocked(resolveHost).mockResolvedValue({ host: 'claude-code', source: 'cli' });

    const result = await serve({ host: 'claude-code' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('HOST_SERVE_UNSUPPORTED');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('blocks Codex serve fail-closed', async () => {
    vi.mocked(resolveHost).mockResolvedValue({ host: 'codex', source: 'cli' });

    const result = await serve({ host: 'codex' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('HOST_SERVE_UNSUPPORTED');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails explicitly when the serve host binary is missing', async () => {
    const result = await serve({ env: { PATH: '' } });

    expect(result).toEqual({
      success: false,
      port: 4096,
      error: 'Host binary not found on PATH: opencode',
    });
    expect(spawn).not.toHaveBeenCalled();
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

  it('mentions all run host commands', () => {
    expect(getRunUsage()).toContain('opencode run');
    expect(getRunUsage()).toContain('claude -p');
    expect(getRunUsage()).toContain('codex --non-interactive');
  });
});

describe('getServeUsage', () => {
  it('contains Usage', () => {
    expect(getServeUsage()).toContain('Usage:');
  });

  it('mentions detached mode and OpenCode-only serve support', () => {
    expect(getServeUsage()).toContain('detached mode only');
    expect(getServeUsage()).toContain('serve supported: opencode');
  });
});
