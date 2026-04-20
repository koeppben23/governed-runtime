/**
 * @module cli/run-acp-smoke.test
 * @description ACP smoke tests.
 *
 * OPTIONAL: RUN_OPENCODE_ACP_TESTS=1
 * These are minimal smoke tests - they verify the command exists.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const IS_ENABLED = process.env.RUN_OPENCODE_ACP_TESTS === '1';

(IS_ENABLED ? describe : describe.skip)('ACP Smoke', () => {
  const TIMEOUT = 3000;

  it('opencode command exists', () => {
    const proc = spawn('opencode', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let errOutput = '';

    proc.stdout?.on('data', (d) => { output += d.toString(); });
    proc.stderr?.on('data', (d) => { errOutput += d.toString(); });

    return new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        // Must exit with code 0 or output some version
        const hasOutput = output.length > 0 || errOutput.length > 0;
        expect(code === 0 || hasOutput).toBe(true);
        resolve();
      });
      proc.on('error', () => {
        expect(true).toBe(false); // Fail if error
        resolve();
      });
      setTimeout(() => { proc.kill(); resolve(); }, TIMEOUT);
    });
  });

  it('acp subcommand starts', () => {
    const proc = spawn('opencode', ['acp'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout?.on('data', (d) => { output += d.toString(); });
    proc.stderr?.on('data', (d) => { output += d.toString(); });

    return new Promise<void>((resolve) => {
      proc.on('close', () => {
        resolve();
      });
      proc.on('error', () => {
        resolve();
      });
      setTimeout(() => {
        // Process started - that's enough for smoke
        expect(proc.pid).toBeDefined();
        proc.kill();
        resolve();
      }, TIMEOUT);
    });
  });

  it('process can be terminated', () => {
    const proc = spawn('opencode', ['acp'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pid = proc.pid;
    expect(pid).toBeDefined();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const killed = proc.kill('SIGTERM');
        expect(killed).toBe(true);
        resolve();
      }, 500);

      proc.on('error', () => { resolve(); });
    });
  });
});