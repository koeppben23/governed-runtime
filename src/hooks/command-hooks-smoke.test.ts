import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { initWorkspace } from '../adapters/workspace/index.js';
import { writeState } from '../adapters/persistence.js';
import { readReviewerCaptures } from '../adapters/persistence-reviewer-capture.js';
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
  let root: string;
  let worktree: string;
  let originalConfigDir: string | undefined;
  let originalRequireTestConfigDir: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'flowguard-hook-smoke-'));
    worktree = join(root, 'worktree');
    await mkdir(worktree);
    originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    originalRequireTestConfigDir = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = join(root, 'config');
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
      await expect(readdir(join(root, 'config', 'workspaces'))).resolves.not.toHaveLength(0);
    });

    it('runs post-tool-use and persists a reviewer capture', async () => {
      const initialized = await initWorkspace(worktree, SESSION_ID);
      await writeState(
        initialized.sessionDir,
        makeState('IMPLEMENTATION', { implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE }),
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
      await expect(readReviewerCaptures(initialized.sessionDir)).resolves.toEqual({
        captures: [
          expect.objectContaining({
            source: 'post_tool_use_hook',
            agentId: 'reviewer-1',
            obligationId: '11111111-1111-4111-8111-111111111111',
          }),
        ],
        skipped: 0,
      });
    });
  });

  describe('BAD', () => {
    it.each(['session-start', 'post-tool-use', 'stop', 'subagent-stop'])(
      'keeps informational hook %s non-blocking for malformed stdin',
      async (name) => {
        const result = await runHook(name, '{invalid json');

        expect(result.code).toBe(0);
        expect(result.stdout).toBe('');
      },
    );
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

  describe('EDGE', () => {
    it('runs subagent-stop and persists a capture only through the real session transport', async () => {
      const initialized = await initWorkspace(worktree, SESSION_ID);
      await writeState(
        initialized.sessionDir,
        makeState('IMPLEMENTATION', { implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE }),
      );

      const result = await runHook(
        'subagent-stop',
        JSON.stringify({
          session_id: SESSION_ID,
          cwd: worktree,
          agent_id: 'reviewer-1',
          agent_type: 'flowguard-reviewer',
        }),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      await expect(readReviewerCaptures(initialized.sessionDir)).resolves.toEqual({
        captures: [
          expect.objectContaining({ source: 'subagent_stop_hook', agentId: 'reviewer-1' }),
        ],
        skipped: 0,
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
