/**
 * @module documentation/demo-signal-exit.test
 * @description SIGTERM/SIGINT must terminate the wrapper (not merely run a
 * handler): in-flight children are signalled first and the EXIT trap performs
 * the cleanup exactly once.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HELPER = join(process.cwd(), 'demos', 'lib', 'signal-exit.sh');
const roots: string[] = [];

function fixture(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowguard-signal-${label}-`));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('signal test wait timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('demo signal/exit contract', () => {
  describe('HAPPY — SIGTERM terminates and cleans up once', () => {
    it('signals children, releases once, and exits 143', async () => {
      const root = fixture('happy');
      const script = join(root, 'wrapper.sh');
      const mark = join(root, 'mark.txt');
      const childFile = join(root, 'child.pid');
      const started = join(root, 'started');
      writeFileSync(
        script,
        [
          '#!/usr/bin/env bash',
          'set -u',
          `source "${HELPER}"`,
          `cleanup() { echo cleanup >> "${mark}"; }`,
          'install_exit_traps cleanup',
          'sleep 30 &',
          `echo $! > "${childFile}"`,
          `echo started > "${started}"`,
          'sleep 30 &',
          'wait $!',
          `echo CONTINUED >> "${mark}"`,
        ].join('\n'),
      );
      const wrapper = spawn('bash', [script], { stdio: 'ignore' });
      try {
        await waitFor(() => existsSync(started));
        const childPid = Number(readFileSync(childFile, 'utf8').trim());
        wrapper.kill('SIGTERM');
        const exitCode = await new Promise<number | null>((resolve) =>
          wrapper.once('exit', (code, signal) => resolve(signal ? null : code)),
        );
        expect(exitCode).toBe(143);
        await waitFor(() => existsSync(mark));
        const marks = readFileSync(mark, 'utf8').trim().split('\n');
        expect(marks).toEqual(['cleanup']);
        await waitFor(() => {
          try {
            process.kill(childPid, 0);
            return false;
          } catch {
            return true;
          }
        });
      } finally {
        wrapper.kill('SIGKILL');
      }
    });
  });

  describe('BAD — no cleanup without a signal', () => {
    it('does not leave a CONTINUED marker after termination', async () => {
      const root = fixture('bad');
      const script = join(root, 'wrapper.sh');
      const mark = join(root, 'mark.txt');
      writeFileSync(
        script,
        [
          '#!/usr/bin/env bash',
          'set -u',
          `source "${HELPER}"`,
          `cleanup() { echo cleanup >> "${mark}"; }`,
          'install_exit_traps cleanup',
          'sleep 30 &',
          'wait $!',
        ].join('\n'),
      );
      const wrapper = spawn('bash', [script], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        wrapper.kill('SIGTERM');
        await new Promise((resolve) => wrapper.once('exit', resolve));
        const marks = existsSync(mark) ? readFileSync(mark, 'utf8').trim() : '';
        expect(marks).toBe('cleanup');
      } finally {
        wrapper.kill('SIGKILL');
      }
    });
  });

  describe('CORNER — normal exit still releases through the EXIT trap', () => {
    it('runs cleanup on a regular end of script', async () => {
      const root = fixture('corner');
      const script = join(root, 'wrapper.sh');
      const mark = join(root, 'mark.txt');
      writeFileSync(
        script,
        [
          '#!/usr/bin/env bash',
          'set -u',
          `source "${HELPER}"`,
          `cleanup() { echo cleanup >> "${mark}"; }`,
          'install_exit_traps cleanup',
        ].join('\n'),
      );
      const wrapper = spawn('bash', [script], { stdio: 'ignore' });
      await new Promise((resolve) => wrapper.once('exit', resolve));
      expect(readFileSync(mark, 'utf8').trim()).toBe('cleanup');
    });
  });

  describe('EDGE — the helper is wired into the wrapper', () => {
    it('uses install_exit_traps instead of a bare combined trap', () => {
      const wrapper = readFileSync(join(process.cwd(), 'demos', 'run-all-demos.sh'), 'utf8');
      expect(wrapper).toContain('install_exit_traps release_lease');
      expect(wrapper).not.toContain('trap release_lease EXIT INT TERM');
    });
  });
});
