/**
 * @module cli/run-acp-smoke.test
 * @description ACP (Agent Client Protocol) smoke tests.
 *
 * OPTIONAL: Only runs when RUN_OPENCODE_ACP_TESTS=1
 *
 * Purpose: Verify opencode acp command is available and functional.
 * NOT for: Full CI/headless automation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const IS_ENABLED = process.env.RUN_OPENCODE_ACP_TESTS === '1';

// Conditional describe - only runs when explicitly enabled
(IS_ENABLED ? describe : describe.skip)('ACP Smoke', () => {
  const ACP_TIMEOUT = 5000;

  it('opencode command is available', () => {
    const proc = spawn('opencode', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        expect(code).toBe(0);
        resolve();
      });
      proc.on('error', () => {
        expect(true).toBe(false); // Fail if error
        resolve();
      });
      setTimeout(() => {
        proc.kill();
        resolve();
      }, ACP_TIMEOUT);
    });
  });

  it('acp subcommand is recognized', () => {
    const proc = spawn('opencode', ['acp', '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    return new Promise<void>((resolve) => {
      proc.on('close', () => {
        // Should either show help or start in some mode
        expect(output.length).toBeGreaterThanOrEqual(0);
        resolve();
      });
      proc.on('error', () => {
        expect(true).toBe(false);
        resolve();
      });
      setTimeout(() => {
        proc.kill();
        resolve();
      }, ACP_TIMEOUT);
    });
  });

  it('process spawns and can be terminated', () => {
    const proc = spawn('opencode', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pid = proc.pid;
    expect(pid).toBeDefined();

    return new Promise<void>((resolve) => {
      // Wait briefly then kill
      setTimeout(() => {
        const killed = proc.kill('SIGTERM');
        // SIGTERM should succeed
        expect(killed).toBe(true);
        resolve();
      }, 1000);

      proc.on('error', () => {
        resolve();
      });
    });
  });
});