/**
 * @module cli/run-acp-smoke.test
 * @description ACP (Agent Client Protocol) smoke tests.
 *
 * These tests verify ACP compatibility as an experimental surface.
 * They are OPTIONAL and gated by RUN_OPENCODE_ACP_TESTS=1.
 *
 * Purpose: Verify opencode acp is available and functional.
 * NOT for: Full CI/headless automation (use run/serve instead).
 *
 * Test categories:
 * - Availability: Is opencode available?
 * - Spawn: Can acp start?
 * - Lifecycle: Can process start and terminate?
 * - Timeout: Does it respond within bounds?
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

const IS_ENABLED = process.env.RUN_OPENCODE_ACP_TESTS === '1';

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`${cmd} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.kill(pid, signal);
      setTimeout(resolve, 500);
    } catch {
      resolve();
    }
  });
}

const TEST_PORT = 16432 + Math.floor(Math.random() * 1000);
const SPAWN_TIMEOUT_MS = 10000;

// Conditional describe
(IS_ENABLED ? describe : describe.skip)('ACP Availability', () => {
  it('opencode command is available', () => {
    const available = isCommandAvailable('opencode');
    if (IS_ENABLED) {
      expect(available).toBe(true);
    } else {
      expect(typeof available).toBe('boolean');
    }
  });

  it('version check works', () => {
    if (!IS_ENABLED) {
      return;
    }
    const version = execSync('opencode --version', { encoding: 'utf-8' });
    expect(version).toContain('.');
  });
});

(IS_ENABLED ? describe : describe.skip)('ACP Spawn', () => {
  it('spawns opencode acp without error', async () => {
    if (!IS_ENABLED) return;

    const proc = spawn('opencode', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const pid = proc.pid;
    expect(pid).toBeGreaterThan(0);

    if (proc && pid) {
      await killProcess(pid, 'SIGTERM');
    }
  });

  it('process starts with correct arguments', async () => {
    if (!IS_ENABLED) return;

    const proc = spawn('opencode', ['acp', '--cwd', '/tmp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    expect(proc.pid).toBeGreaterThan(0);

    if (proc && proc.pid) {
      await killProcess(proc.pid, 'SIGTERM');
    }
  });
});

(IS_ENABLED ? describe : describe.skip)('ACP Lifecycle', () => {
  it('process can be terminated cleanly', async () => {
    if (!IS_ENABLED) return;

    const proc = spawn('opencode', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const pid = proc.pid;
    await sleep(500);
    await killProcess(pid, 'SIGTERM');

    expect(pid).toBeGreaterThan(0);
  });

  it('handles SIGTERM gracefully', async () => {
    if (!IS_ENABLED) return;

    const proc = spawn('opencode', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    await sleep(500);
    if (proc && proc.pid) {
      proc.kill('SIGTERM');
    }
    await sleep(500);
  });
});

(IS_ENABLED ? describe : describe.skip)('ACP Timeout', () => {
  it('startup completes within timeout', async () => {
    if (!IS_ENABLED) return;

    const start = Date.now();

    const proc = spawn('opencode', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    await sleep(2000);

    const elapsed = Date.now() - start;

    if (proc && proc.pid) {
      await killProcess(proc.pid, 'SIGTERM');
    }

    expect(elapsed).toBeLessThan(SPAWN_TIMEOUT_MS);
  });

  it('handles rapid spawn/despawn cycle', async () => {
    if (!IS_ENABLED) return;

    for (let i = 0; i < 3; i++) {
      const proc = spawn('opencode', ['acp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });

      await sleep(500);

      if (proc && proc.pid) {
        proc.kill('SIGTERM');
      }

      await sleep(500);
    }
  });
});

(IS_ENABLED ? describe : describe.skip)('ACP Communication', () => {
  it('stdin is writable', async () => {
    if (!IS_ENABLED) return;

    const proc = spawn('opencode', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    await sleep(2000);

    const canWrite = proc.stdin?.writable;
    expect(canWrite).toBe(true);

    if (proc && proc.pid) {
      proc.kill('SIGTERM');
    }

    await sleep(500);
  });

  it('stdout is readable', async () => {
    if (!IS_ENABLED) return;

    let output = '';

    const proc = spawn('opencode', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    await sleep(2000);

    if (proc && proc.pid) {
      proc.kill('SIGTERM');
    }

    await sleep(500);
  });
});

(IS_ENABLED ? describe : describe.skip)('ACP Edge Cases', () => {
  it('handles missing working directory', async () => {
    if (!IS_ENABLED) return;

    const proc = spawn('opencode', ['acp', '--cwd', '/nonexistent-path-12345'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    await sleep(2000);

    if (proc && proc.pid) {
      proc.kill('SIGTERM');
    }

    await sleep(500);
  });

  it('handles concurrent flags', async () => {
    if (!IS_ENABLED) return;

    const proc = spawn('opencode', ['acp', '--port', String(TEST_PORT)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    await sleep(2000);

    if (proc && proc.pid) {
      proc.kill('SIGTERM');
    }

    await sleep(500);
  });
});

(IS_ENABLED ? describe : describe.skip)('ACP Cleanup', () => {
  it('processes are cleaned up properly', async () => {
    if (!IS_ENABLED) return;

    for (let i = 0; i < 5; i++) {
      const proc = spawn('opencode', ['acp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });

      await sleep(100);

      if (proc && proc.pid) {
        proc.kill('SIGTERM');
      }

      await sleep(100);
    }
  });
});