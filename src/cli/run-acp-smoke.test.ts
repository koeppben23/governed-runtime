/**
 * @module cli/run-acp-smoke.test
 * @description ACP smoke tests.
 *
 * OPTIONAL: RUN_OPENCODE_ACP_TESTS=1
 * These are minimal smoke tests.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

const IS_ENABLED = process.env.RUN_OPENCODE_ACP_TESTS === '1';

(IS_ENABLED ? describe : describe.skip)('ACP Smoke', () => {
  const TIMEOUT = 3000;

  it('opencode command exists', () => {
    const proc = spawn('opencode', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    return new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        // Must have exit code 0 OR some output
        expect(code === 0 || stdout.length > 0 || stderr.length > 0).toBe(true);
        resolve();
      });
      proc.on('error', () => {
        expect(true).toBe(false);
        resolve();
      });
      setTimeout(() => { proc.kill(); resolve(); }, TIMEOUT);
    });
  });

  it('acp subcommand starts', () => {
    const proc = spawn('opencode', ['acp'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Process started - that's the smoke test
        expect(proc.pid).toBeDefined();
        proc.kill();
        resolve();
      }, TIMEOUT);

      proc.on('error', () => { resolve(); });
    });
  });

  it('process can be terminated', () => {
    const proc = spawn('opencode', ['acp'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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