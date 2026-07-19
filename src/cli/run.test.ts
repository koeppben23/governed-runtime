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
import type { HeadlessConfig } from './run-types.js';

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
  function ok(result: ReturnType<typeof parseRunArgs>) {
    expect(result.kind).toBe('ok');
    return (result as { kind: 'ok'; value: HeadlessConfig }).value;
  }

  describe('happy path', () => {
    it('parses positional prompt', () => {
      const config = ok(parseRunArgs(['Run /hydrate']));
      expect(config.prompt).toBe('Run /hydrate');
    });

    it('parses --prompt flag', () => {
      const config = ok(parseRunArgs(['--prompt', 'Run /validate']));
      expect(config.prompt).toBe('Run /validate');
    });

    it('parses -- for prompt', () => {
      const config = ok(parseRunArgs(['--', 'Run /hydrate']));
      expect(config.prompt).toBe('Run /hydrate');
    });

    it('joins all tokens after -- into prompt', () => {
      const config = ok(parseRunArgs(['--', 'Run', '/hydrate', 'policyMode=team-ci']));
      expect(config.prompt).toBe('Run /hydrate policyMode=team-ci');
    });

    it('parses --cwd', () => {
      const config = ok(parseRunArgs(['--cwd', '/some/path', 'Run /validate']));
      expect(config.cwd).toBe('/some/path');
    });

    it('parses --host', () => {
      const config = ok(parseRunArgs(['--host', 'claude-code', '--', 'Run /validate']));
      expect(config.host).toBe('claude-code');
      expect(config.prompt).toBe('Run /validate');
    });
  });

  describe('bad path', () => {
    it('returns error when prompt missing', () => {
      const result = parseRunArgs([]);
      expect(result.kind).toBe('error');
    });

    it('returns error when --prompt missing value', () => {
      const result = parseRunArgs(['--prompt']);
      expect(result.kind).toBe('error');
    });

    it('returns error for unknown flag', () => {
      const result = parseRunArgs(['--unknown', 'value']);
      expect(result.kind).toBe('error');
    });

    it('returns error for invalid host value', () => {
      const result = parseRunArgs(['--host', 'unknown-host', '--', 'Run /hydrate']);
      expect(result.kind).toBe('error');
    });

    it('returns error when --host is missing a value', () => {
      const result = parseRunArgs(['--host']);
      expect(result.kind).toBe('error');
    });

    it('returns help for --help', () => {
      const result = parseRunArgs(['--help']);
      expect(result.kind).toBe('help');
    });

    it('returns help for -h', () => {
      const result = parseRunArgs(['-h']);
      expect(result.kind).toBe('help');
    });

    it('rejects extra positional arguments', () => {
      const result = parseRunArgs(['prompt1', 'prompt2']);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.error).toContain('extra');
    });
  });

  describe('corner cases', () => {
    it('handles prompt with special chars', () => {
      const config = ok(parseRunArgs(['Run /plan "quotes" <brackets>']));
      expect(config.prompt).toBe('Run /plan "quotes" <brackets>');
    });
  });
});

describe('parseServeArgs', () => {
  function ok(result: ReturnType<typeof parseServeArgs>) {
    expect(result.kind).toBe('ok');
    return (
      result as {
        kind: 'ok';
        value: { port?: number; hostname?: string; host?: string; cwd?: string };
      }
    ).value;
  }

  describe('happy path', () => {
    it('parses defaults', () => {
      const config = ok(parseServeArgs([]));
      expect(config.port).toBeUndefined();
    });

    it('parses --port', () => {
      const config = ok(parseServeArgs(['--port', '3000']));
      expect(config.port).toBe(3000);
    });

    it('parses --hostname', () => {
      const config = ok(parseServeArgs(['--hostname', '0.0.0.0']));
      expect(config.hostname).toBe('0.0.0.0');
    });

    it('parses all flags', () => {
      const config = ok(
        parseServeArgs([
          '--host',
          'opencode',
          '--port',
          '8080',
          '--hostname',
          '0.0.0.0',
          '--cwd',
          '/ws',
        ]),
      );
      expect(config.host).toBe('opencode');
      expect(config.port).toBe(8080);
      expect(config.hostname).toBe('0.0.0.0');
      expect(config.cwd).toBe('/ws');
    });
  });

  describe('bad path', () => {
    it('returns error when --port missing', () => {
      const result = parseServeArgs(['--port']);
      expect(result.kind).toBe('error');
    });

    it('returns error when --port invalid', () => {
      const result = parseServeArgs(['--port', 'not-a-number']);
      expect(result.kind).toBe('error');
    });

    it('returns error when --port out of range', () => {
      const result = parseServeArgs(['--port', '0']);
      expect(result.kind).toBe('error');
    });

    it('rejects unsupported --detach flag', () => {
      const result = parseServeArgs(['--detach']);
      expect(result.kind).toBe('error');
    });

    it('returns error for invalid host value', () => {
      const result = parseServeArgs(['--host', 'unknown-host']);
      expect(result.kind).toBe('error');
    });

    it('returns error when --host is missing a value', () => {
      const result = parseServeArgs(['--host']);
      expect(result.kind).toBe('error');
    });

    it('returns help for --help', () => {
      const result = parseServeArgs(['--help']);
      expect(result.kind).toBe('help');
    });

    it('returns help for -h', () => {
      const result = parseServeArgs(['-h']);
      expect(result.kind).toBe('help');
    });

    it('rejects unexpected positional argument', () => {
      const result = parseServeArgs(['unexpected']);
      expect(result.kind).toBe('error');
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
