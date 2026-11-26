/**
 * @module documentation/demo-signal-exit.test
 * @description SIGTERM/SIGINT must terminate the ENTIRE process tree (including
 * grandchildren) before the EXIT trap performs cleanup, and must never continue
 * executing after the signal.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v2
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

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('signal test wait timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('demo signal/exit contract', () => {
  describe('HAPPY — SIGTERM terminates the process tree and cleans up once', () => {
    it('kills the grandchild, releases once, and exits 143', async () => {
      const root = fixture('happy');
      const script = join(root, 'wrapper.sh');
      const mark = join(root, 'mark.txt');
      const grandchildFile = join(root, 'grandchild.pid');
      const grandchildScript = join(root, 'resistant.sh');
      const leaderScript = join(root, 'leader.sh');
      const started = join(root, 'started');
      writeFileSync(
        grandchildScript,
        [
          '#!/usr/bin/env bash',
          'trap "" TERM',
          `echo $$ > "${grandchildFile}"`,
          'while :; do sleep 1; done',
        ].join('\n'),
      );
      writeFileSync(leaderScript, `bash "${grandchildScript}" &\nwait $!\n`);
      writeFileSync(
        script,
        [
          '#!/usr/bin/env bash',
          'set -u',
          'set -m',
          `source "${HELPER}"`,
          `cleanup() { if kill -0 -- "-$ACTIVE_CHILD_PGID" 2>/dev/null; then echo GROUP_STILL_ALIVE >> "${mark}"; else echo cleanup >> "${mark}"; fi; }`,
          'install_exit_traps cleanup',
          `bash "${leaderScript}" &`,
          'ACTIVE_CHILD_PGID=$!',
          `echo started > "${started}"`,
          'wait "$ACTIVE_CHILD_PGID"',
          `echo CONTINUED >> "${mark}"`,
        ].join('\n'),
      );
      const wrapper = spawn('bash', [script], { stdio: 'ignore' });
      try {
        await waitFor(() => existsSync(started));
        await waitFor(() => existsSync(grandchildFile));
        const grandchildPid = Number(readFileSync(grandchildFile, 'utf8').trim());
        expect(processAlive(grandchildPid)).toBe(true);
        wrapper.kill('SIGTERM');
        const exitCode = await new Promise<number | null>((resolve) =>
          wrapper.once('exit', (code, signal) => resolve(signal ? null : code)),
        );
        expect(exitCode).toBe(143);
        await waitFor(() => existsSync(mark));
        expect(readFileSync(mark, 'utf8').trim().split('\n')).toEqual(['cleanup']);
        await waitFor(() => !processAlive(grandchildPid));
      } finally {
        if (existsSync(grandchildFile)) {
          const pid = Number(readFileSync(grandchildFile, 'utf8').trim());
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already stopped */
          }
        }
        wrapper.kill('SIGKILL');
      }
    });
  });

  describe('BAD — no code runs after the signal', () => {
    it('retains cleanup ownership and stops subsequent stages when group absence cannot be proved', async () => {
      const root = fixture('unconfirmed');
      const script = join(root, 'wrapper.sh');
      const mark = join(root, 'mark.txt');
      writeFileSync(
        script,
        [
          '#!/usr/bin/env bash',
          'set -u',
          'set -m',
          `source "${HELPER}"`,
          `cleanup() { echo cleanup >> "${mark}"; }`,
          'install_exit_traps cleanup',
          // Inject an unconfirmable group probe; neither TERM nor KILL may justify release.
          'demo_group_alive() { return 0; }',
          'wait_for_demo_group() { return 1; }',
          'run_controlled_command bash -c "exit 0"',
          `echo CONTINUED >> "${mark}"`,
        ].join('\n'),
      );
      const wrapper = spawn('bash', [script], { stdio: 'ignore' });
      const code = await new Promise<number | null>((resolve) => wrapper.once('exit', resolve));
      expect(code).toBe(1);
      expect(existsSync(mark)).toBe(false);
    });

    it('does not reach the post-wait line', async () => {
      const root = fixture('bad');
      const script = join(root, 'wrapper.sh');
      const mark = join(root, 'mark.txt');
      writeFileSync(
        script,
        [
          '#!/usr/bin/env bash',
          'set -u',
          'set -m',
          `source "${HELPER}"`,
          `cleanup() { echo cleanup >> "${mark}"; }`,
          'install_exit_traps cleanup',
          'sleep 30 &',
          'ACTIVE_CHILD_PGID=$!',
          'wait "$ACTIVE_CHILD_PGID"',
          `echo CONTINUED >> "${mark}"`,
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
    it('uses the process-group termination contract', () => {
      const wrapper = readFileSync(join(process.cwd(), 'demos', 'run-all-demos.sh'), 'utf8');
      expect(wrapper).toContain('install_exit_traps release_lease');
      expect(wrapper).toContain('set -m');
      expect(wrapper).toContain('ACTIVE_CHILD_PGID');
      expect(readFileSync(HELPER, 'utf8')).toContain('kill -TERM -- "-${ACTIVE_CHILD_PGID}"');
      expect(wrapper).not.toContain('trap release_lease EXIT INT TERM');
    });
  });
});
