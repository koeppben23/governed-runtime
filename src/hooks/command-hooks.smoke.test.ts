import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { initWorkspace } from '../adapters/workspace/index.js';
import { writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { makeState, FROZEN_IMPLEMENTATION_BASE } from '../fixtures.js';

const HOOK_TIMEOUT_MS = 3000;
const SESSION_ID = 'hook-smoke-session';

type HookResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
};

async function runHook(name: string, input: string): Promise<HookResult> {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'hooks', `${name}.js`)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  return await new Promise<HookResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} did not exit within ${HOOK_TIMEOUT_MS}ms`));
    }, HOOK_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: performance.now() - startedAt });
    });
    child.stdin.end(input);
  });
}

describe('command hook binaries', () => {
  let base: string;
  let root: string;
  let worktree: string;
  let originalConfigDir: string | undefined;
  let originalRequireTestConfigDir: string | undefined;

  beforeEach(async () => {
    // `base` keeps the OS-tmpdir spelling required by the workspace test-dir
    // guard; `root` is the physical path git resolves to on macOS.
    base = await mkdtemp(join(tmpdir(), 'flowguard-hook-smoke-'));
    root = await realpath(base);
    worktree = join(root, 'worktree');
    await mkdir(worktree);
    // H8: hook payload cwd is validated against a git-resolved worktree root.
    execFileSync('git', ['init', '--quiet', worktree]);
    originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    originalRequireTestConfigDir = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = join(base, 'config');
    process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    if (originalRequireTestConfigDir === undefined)
      delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    else process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = originalRequireTestConfigDir;
    await rm(root, { recursive: true, force: true });
  });

  describe('HAPPY', () => {
    it('runs session-start and initializes the isolated workspace registry', async () => {
      const result = await runHook(
        'session-start',
        JSON.stringify({ session_id: SESSION_ID, cwd: worktree }),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      await expect(readdir(join(base, 'config', 'workspaces'))).resolves.not.toHaveLength(0);
    });

    it('runs post-tool-use and persists the tool-call audit event', async () => {
      const initialized = await initWorkspace(worktree, SESSION_ID);
      await writeState(
        initialized.sessionDir,
        makeState('PLAN', {
          binding: {
            hostSessionId: SESSION_ID,
            worktree,
            fingerprint: initialized.fingerprint,
            resolvedAt: '2026-01-01T00:00:00.000Z',
          },
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        }),
      );

      const result = await runHook(
        'post-tool-use',
        JSON.stringify({
          session_id: SESSION_ID,
          cwd: worktree,
          tool_name: 'flowguard_review',
          tool_input: { toolObligationId: '11111111-1111-4111-8111-111111111111' },
          agent_id: 'reviewer-1',
          agent_type: 'flowguard-reviewer',
        }),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      const trail = await readAuditTrail(initialized.sessionDir);
      expect(trail).toContainEqual(
        expect.objectContaining({
          event: 'tool_call',
          detail: expect.objectContaining({ tool: 'flowguard_review' }),
        }),
      );
    });
  });

  describe('BAD', () => {
    it.each(['session-start', 'post-tool-use', 'stop'])(
      'keeps informational hook %s non-blocking for malformed stdin',
      async (name) => {
        const result = await runHook(name, '{invalid json');

        expect(result.code).toBe(0);
        expect(result.stdout).toBe('');
      },
    );

    it('denies with WORKTREE_MISMATCH when the payload cwd is a foreign clone of the same repository', async () => {
      const sharedRemote = 'https://example.com/acme/shared-repo.git';
      execFileSync('git', ['remote', 'add', 'origin', sharedRemote], {
        cwd: worktree,
        windowsHide: true,
      });
      const foreign = join(root, 'foreign');
      await mkdir(foreign);
      execFileSync('git', ['init', '--quiet', foreign], { windowsHide: true });
      execFileSync('git', ['remote', 'add', 'origin', sharedRemote], {
        cwd: foreign,
        windowsHide: true,
      });
      // Both clones share the remote fingerprint, so the session store and the
      // persisted binding are reachable from the foreign cwd; only the worktree
      // binding prevents the spoof.
      const initialized = await initWorkspace(worktree, SESSION_ID);
      await writeState(
        initialized.sessionDir,
        makeState('PLAN', {
          binding: {
            hostSessionId: SESSION_ID,
            worktree,
            fingerprint: initialized.fingerprint,
            resolvedAt: '2026-01-01T00:00:00.000Z',
          },
        }),
      );

      const result = await runHook(
        'pre-tool-use',
        JSON.stringify({
          session_id: SESSION_ID,
          cwd: foreign,
          tool_name: 'bash',
          tool_input: { command: 'echo hostile' },
        }),
      );

      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain('WORKTREE_MISMATCH');
    });
  });

  describe('CORNER', () => {
    it('returns a fail-closed denial from the pre-tool-use binary for malformed stdin', async () => {
      const result = await runHook('pre-tool-use', '{invalid json');

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
  });

  describe('PERF', () => {
    it('starts and exits the stop binary within the established smoke timeout', async () => {
      const result = await runHook('stop', '{invalid json');

      expect(result.code).toBe(0);
      expect(result.elapsedMs).toBeLessThan(HOOK_TIMEOUT_MS);
    });
  });
});
