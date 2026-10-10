/**
 * @module hooks/http-server.transport-governance.test
 * @description Real HTTP transport proof that governance denials reach the
 * wire: the actual `node:http` hook server is started on an ephemeral port and
 * exercised through real network requests against real persisted session state
 * (unresolved review obligation and phase gate), not a directly invoked
 * handler.
 *
 * @test-policy BAD
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { createServer as createProbeServer, type AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initWorkspace } from '../adapters/workspace/index.js';
import { writeState } from '../adapters/persistence.js';
import { makeState, PLAN_REVIEW_ASSURANCE, FROZEN_IMPLEMENTATION_BASE } from '../fixtures.js';
import { canonicalBinding } from '../integration/test-helpers.js';

const TEST_HOOK_TOKEN = 'governance-wire-test-token-at-least-32-characters';
const OPEN_OBLIGATION_SESSION = 'wire-open-obligation-session';
const PLAN_PHASE_SESSION = 'wire-plan-phase-session';
const UNKNOWN_TOOL_SESSION = 'wire-unknown-tool-session';

const captured = vi.hoisted(() => ({ server: undefined as Server | undefined }));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (handler?: http.RequestListener) => {
      const server = actual.createServer(handler);
      captured.server = server;
      return server;
    },
  };
});

let base: string;
let root: string;
let worktree: string;
let baseUrl: string;
let originalEnv: Record<string, string | undefined>;

async function freePort(): Promise<number> {
  const probe = createProbeServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function postPreToolUse(body: Record<string, unknown>): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}/hooks/pre-tool-use`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_HOOK_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: JSON.parse(await response.text()) };
}

/** Real state whose plan review obligation is still open (unconsumed). */
async function openObligationState(worktreeRoot: string) {
  const openObligation = {
    ...PLAN_REVIEW_ASSURANCE.obligations[0]!,
    status: 'pending' as const,
    fulfilledAt: null,
    consumedAt: null,
  };
  return makeState('PLAN_REVIEW', {
    binding: await canonicalBinding(worktreeRoot, OPEN_OBLIGATION_SESSION),
    reviewAssurance: { ...PLAN_REVIEW_ASSURANCE, obligations: [openObligation] },
  });
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'flowguard-wire-governance-'));
  root = await realpath(base);
  worktree = join(root, 'worktree');
  execFileSync('git', ['init', '--quiet', worktree], { windowsHide: true });

  originalEnv = {
    OPENCODE_CONFIG_DIR: process.env['OPENCODE_CONFIG_DIR'],
    FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: process.env['FLOWGUARD_REQUIRE_TEST_CONFIG_DIR'],
    FLOWGUARD_HOOK_TOKEN: process.env['FLOWGUARD_HOOK_TOKEN'],
    FLOWGUARD_HOOK_HOST: process.env['FLOWGUARD_HOOK_HOST'],
    FLOWGUARD_HOOK_PORT: process.env['FLOWGUARD_HOOK_PORT'],
  };
  process.env['OPENCODE_CONFIG_DIR'] = join(base, 'config');
  process.env['FLOWGUARD_REQUIRE_TEST_CONFIG_DIR'] = '1';
  process.env['FLOWGUARD_HOOK_TOKEN'] = TEST_HOOK_TOKEN;
  process.env['FLOWGUARD_HOOK_HOST'] = '127.0.0.1';
  process.env['FLOWGUARD_HOOK_PORT'] = String(await freePort());

  const openObligationWorkspace = await initWorkspace(worktree, OPEN_OBLIGATION_SESSION);
  await writeState(openObligationWorkspace.sessionDir, await openObligationState(worktree));

  const planPhaseWorkspace = await initWorkspace(worktree, PLAN_PHASE_SESSION);
  await writeState(
    planPhaseWorkspace.sessionDir,
    makeState('PLAN', {
      binding: await canonicalBinding(worktree, PLAN_PHASE_SESSION),
    }),
  );

  const unknownToolWorkspace = await initWorkspace(worktree, UNKNOWN_TOOL_SESSION);
  await writeState(
    unknownToolWorkspace.sessionDir,
    makeState('IMPLEMENTATION', {
      binding: await canonicalBinding(worktree, UNKNOWN_TOOL_SESSION),
      implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
    }),
  );

  await import('./http-server.js');
  const server = captured.server;
  if (!server) throw new Error('the real HTTP hook server was not created on import');
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the HTTP hook server did not expose a TCP address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  const server = captured.server;
  if (server?.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe('real HTTP PreToolUse governance denials', () => {
  it('denies a mutating host tool with REVIEW_OBLIGATION_UNRESOLVED over the wire', async () => {
    const { status, json } = await postPreToolUse({
      session_id: OPEN_OBLIGATION_SESSION,
      cwd: worktree,
      tool_name: 'bash',
      tool_input: { command: 'echo hostile' },
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      decision: 'deny',
      code: 'REVIEW_OBLIGATION_UNRESOLVED',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('REVIEW_OBLIGATION_UNRESOLVED'),
      },
    });
  });

  it('denies a mutating host tool with HOST_TOOL_PHASE_DENIED over the wire', async () => {
    const { status, json } = await postPreToolUse({
      session_id: PLAN_PHASE_SESSION,
      cwd: worktree,
      tool_name: 'bash',
      tool_input: { command: 'echo hostile' },
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      decision: 'deny',
      code: 'HOST_TOOL_PHASE_DENIED',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('HOST_TOOL_PHASE_DENIED'),
      },
    });
  });

  it('denies an unregistered host tool with HOST_TOOL_UNKNOWN_DENIED over the wire', async () => {
    const { status, json } = await postPreToolUse({
      session_id: UNKNOWN_TOOL_SESSION,
      cwd: worktree,
      tool_name: 'unregistered_host_tool',
      tool_input: { command: 'echo hostile' },
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      decision: 'deny',
      code: 'HOST_TOOL_UNKNOWN_DENIED',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('HOST_TOOL_UNKNOWN_DENIED'),
      },
    });
  });
});
