/**
 * @module integration/plugin-bootstrap.test
 * @description Fail-closed bootstrap tests for FlowGuardAuditPlugin.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { FlowGuardAuditPlugin, isUsableWorktree } from './plugin.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import { makeState } from '../__fixtures__.js';
import type { PolicyMode } from '../config/policy.js';
import * as barrel from './index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTestWorkspace, withTestEnv } from './test-helpers.js';
import { readState, writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

async function initGitRepo(worktree: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: worktree });
}

function createMockInput(overrides: Record<string, unknown> = {}) {
  return {
    project: {} as unknown,
    client: {
      app: {
        log: async () => {},
      },
    } as unknown,
    $: {} as unknown,
    directory: '/tmp/mock-dir',
    worktree: '/tmp/mock-worktree',
    serverUrl: new URL('http://localhost:3000'),
    ...overrides,
  } as Parameters<typeof FlowGuardAuditPlugin>[0];
}

async function seedStrictPlanSession(worktree: string, sessionID: string) {
  const now = new Date().toISOString();
  const fp = await computeFingerprint(worktree);
  const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
  const obligationId = '11111111-1111-4111-8111-111111111111';

  await fs.mkdir(sessDir, { recursive: true });
  await writeState(
    sessDir,
    makeState('PLAN', {
      ticket: {
        text: 'Fix auth issue',
        digest: 'ticket-digest',
        source: 'user',
        createdAt: now,
      },
      plan: {
        current: {
          body: '## Plan\n1. Fix auth',
          digest: 'plan-digest',
          sections: ['Plan'],
          createdAt: now,
        },
        history: [],
        reviewFindings: [],
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'plan-digest',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
      policySnapshot: {
        ...makeState('PLAN').policySnapshot,
        selfReview: {
          subagentEnabled: true,
          fallbackToSelf: false,
          strictEnforcement: true,
        },
      },
      reviewAssurance: {
        obligations: [
          {
            obligationId,
            obligationType: 'plan',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            createdAt: now,
            pluginHandshakeAt: null,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
          },
        ],
        invocations: [],
      },
    }),
  );

  return { sessDir, obligationId };
}

function strictPlanReviewRequiredOutput(
  obligationId: string,
  overrides: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    phase: 'PLAN',
    selfReviewIteration: 0,
    reviewMode: 'subagent',
    reviewObligationId: obligationId,
    reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
    reviewMandateDigest: REVIEW_MANDATE_DIGEST,
    next: 'INDEPENDENT_REVIEW_REQUIRED: iteration=0, planVersion=1',
    ...overrides,
  });
}

// ─── Plugin bootstrap fail-closed: no rogue workspace folder ────────────────

describe('plugin bootstrap fail-closed', () => {
  /**
   * Regression for the rogue-fingerprint-folder bug:
   * When the plugin is loaded with worktree='/' (or any non-repo path),
   * it MUST NOT materialize a `workspaces/<fp>/` folder under
   * OPENCODE_CONFIG_DIR. Invariant: one fingerprint folder per repo.
   */
  let configDir: string;
  let cleanupEnv: () => void;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-rogue-regression-'));
    cleanupEnv = withTestEnv({
      OPENCODE_CONFIG_DIR: configDir,
      FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
    });
  });

  afterEach(async () => {
    cleanupEnv();
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => {});
  });

  it('does not create a workspaces/<fp>/ folder when worktree is "/"', async () => {
    await FlowGuardAuditPlugin(createMockInput({ worktree: '/', directory: '/' }));
    const workspacesDir = path.join(configDir, 'workspaces');
    const exists = await fs
      .stat(workspacesDir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (exists) {
      const entries = await fs.readdir(workspacesDir);
      expect(entries).toEqual([]);
    }
  });

  it('does not create a workspaces/<fp>/ folder when worktree has no .git', async () => {
    const noRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-no-repo-'));
    try {
      await FlowGuardAuditPlugin(createMockInput({ worktree: noRepo, directory: noRepo }));
      const workspacesDir = path.join(configDir, 'workspaces');
      const exists = await fs
        .stat(workspacesDir)
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (exists) {
        const entries = await fs.readdir(workspacesDir);
        expect(entries).toEqual([]);
      }
    } finally {
      await fs.rm(noRepo, { recursive: true, force: true });
    }
  });

  it('does not create a workspaces/<fp>/ folder when worktree and directory are empty', async () => {
    await FlowGuardAuditPlugin(createMockInput({ worktree: '', directory: '' }));
    const workspacesDir = path.join(configDir, 'workspaces');
    const exists = await fs
      .stat(workspacesDir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (exists) {
      const entries = await fs.readdir(workspacesDir);
      expect(entries).toEqual([]);
    }
  });

  it('creates the workspace folder when worktree is a real repo (happy path)', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-real-repo-'));
    try {
      await fs.mkdir(path.join(repo, '.git'), { recursive: true });
      await FlowGuardAuditPlugin(createMockInput({ worktree: repo, directory: repo }));
      // Logger sink writes asynchronously on the first log entry. Allow the
      // microtask + I/O queue to flush before asserting.
      await new Promise((r) => setTimeout(r, 50));
      const workspacesDir = path.join(configDir, 'workspaces');
      const entries = await fs.readdir(workspacesDir).catch(() => []);
      // At least one fingerprint folder must exist.
      expect(entries.length).toBeGreaterThanOrEqual(1);
      // Each entry name must be a 24-hex fingerprint.
      for (const e of entries) {
        expect(e).toMatch(/^[0-9a-f]{24}$/);
      }
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // BUG-08: Subagent type authorization (defense-in-depth)
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('BUG-08: subagent type authorization', () => {
    it('HAPPY — flowguard-reviewer subagent type passes through (existing L3)', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        // flowguard-reviewer with empty prompt — should pass (no pending review)
        const input = { tool: 'task', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { subagent_type: 'flowguard-reviewer', prompt: 'test prompt' } };
        await expect(beforeHook(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — non-reviewer subagent type "explore" is blocked', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'task', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { subagent_type: 'explore', prompt: 'search code' } };
        await expect(beforeHook(input, output)).rejects.toThrow('SUBAGENT_TYPE_UNAUTHORIZED');
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — non-reviewer subagent type "general" is blocked', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'task', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { subagent_type: 'general', prompt: 'do something' } };
        await expect(beforeHook(input, output)).rejects.toThrow('SUBAGENT_TYPE_UNAUTHORIZED');
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — arbitrary subagent type "malicious-agent" is blocked', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'task', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { subagent_type: 'malicious-agent', prompt: 'bypass' } };
        await expect(beforeHook(input, output)).rejects.toThrow('SUBAGENT_TYPE_UNAUTHORIZED');
      } finally {
        await ws.cleanup();
      }
    });

    it('CORNER — empty subagent_type passes through (generic task, not a subagent spawn)', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'task', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { subagent_type: '', prompt: 'something' } };
        await expect(beforeHook(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('CORNER — missing subagent_type field passes through (undefined → empty)', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'task', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { prompt: 'no subagent_type field' } };
        await expect(beforeHook(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('EDGE — error message includes the blocked subagent type name', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'task', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { subagent_type: 'rogue-agent', prompt: 'test' } };
        try {
          await beforeHook(input, output);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          const error = err as Error;
          expect(error.name).toBe('FlowGuardEnforcementError');
          expect(error.message).toContain('rogue-agent');
          expect(error.message).toContain('SUBAGENT_TYPE_UNAUTHORIZED');
        }
      } finally {
        await ws.cleanup();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // BUG-03: Phase-aware host tool gate (integration)
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('BUG-03: phase-aware host tool gate (integration)', () => {
    it('HAPPY — bash in PLAN phase is blocked', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        // Seed a session in PLAN phase
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(sessDir, makeState('PLAN'));

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'bash', sessionID, callID: 'c1' };
        const output = { args: { command: 'npm install' } };
        await expect(beforeHook(input, output)).rejects.toThrow('HOST_TOOL_PHASE_DENIED');
      } finally {
        await ws.cleanup();
      }
    });

    it('HAPPY — write in TICKET phase is blocked', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(sessDir, makeState('TICKET'));

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'write', sessionID, callID: 'c1' };
        const output = { args: { filePath: '/tmp/file.ts', content: 'code' } };
        await expect(beforeHook(input, output)).rejects.toThrow('HOST_TOOL_PHASE_DENIED');
      } finally {
        await ws.cleanup();
      }
    });

    it('HAPPY — bash in IMPLEMENTATION phase is allowed', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(sessDir, makeState('IMPLEMENTATION'));

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'bash', sessionID, callID: 'c1' };
        const output = { args: { command: 'npm install' } };
        // Should not throw — IMPLEMENTATION phase allows mutating tools
        await expect(beforeHook(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('CORNER — read in PLAN phase is allowed (read-only tool)', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(sessDir, makeState('PLAN'));

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'read', sessionID, callID: 'c1' };
        const output = { args: { filePath: '/tmp/some-file.ts' } };
        // read is not a mutating tool → never blocked
        await expect(beforeHook(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — bash blocked when sessDir computed but directory missing (fail-closed)', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        // Fingerprint is resolved (git repo) → sessDir is computed.
        // But directory does not exist on disk (no /hydrate yet).
        // This MUST fail-closed with SESSION_DIR_NOT_FOUND.
        const input = { tool: 'bash', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { command: 'echo hello' } };
        await expect(beforeHook(input, output)).rejects.toThrow('SESSION_DIR_NOT_FOUND');
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — bash blocked when session dir existed but was deleted before hook (race)', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        // Create session directory on disk, so it exists when plugin loads
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(sessDir, makeState('IMPLEMENTATION'));

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        // Simulate race: delete the session directory after plugin init
        await fs.rm(sessDir, { recursive: true, force: true });

        const input = { tool: 'bash', sessionID, callID: 'c1' };
        const output = { args: { command: 'echo hello' } };
        await expect(beforeHook(input, output)).rejects.toThrow('SESSION_DIR_NOT_FOUND');
      } finally {
        await ws.cleanup();
      }
    });

    it('HAPPY — bash allowed in non-git worktree (pre-session, sessDir=null)', async () => {
      // Non-git worktree → isUsableWorktree returns false → fingerprint
      // never resolved → getSessionDir returns null → tool allowed.
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-no-git-gate-'));
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: tmp, directory: tmp }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'bash', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { command: 'echo hello' } };
        await expect(beforeHook(input, output)).resolves.toBeUndefined();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it('BAD — bash blocked when session dir exists but state file is missing (fail-closed)', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        // Create the session directory but DON'T write state into it
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        // No writeState — session dir exists but session-state.json is absent

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'bash', sessionID, callID: 'c1' };
        const output = { args: { command: 'rm -rf /' } };
        await expect(beforeHook(input, output)).rejects.toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
      } finally {
        await ws.cleanup();
      }
    });

    it('EDGE — bash blocked when session state exists but is invalid/corrupt (fail-closed)', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        // Create session directory with deliberately invalid JSON
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await fs.writeFile(
          path.join(sessDir, 'session-state.json'),
          '{ this is not valid json !!! }',
          'utf-8',
        );

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'bash', sessionID, callID: 'c1' };
        const output = { args: { command: 'rm -rf /' } };
        await expect(beforeHook(input, output)).rejects.toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
      } finally {
        await ws.cleanup();
      }
    });

    it('SMOKE — PLUGIN_ENFORCEMENT_UNAVAILABLE has correct code and structured message', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        // Create session directory but no state file
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'write', sessionID, callID: 'c1' };
        const output = { args: { filePath: '/tmp/file.ts', content: 'x' } };
        try {
          await beforeHook(input, output);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).name).toBe('FlowGuardEnforcementError');
          // Message format: "[FlowGuard] <JSON>"
          const msg = (err as Error).message;
          expect(msg).toContain('[FlowGuard]');
          const json = JSON.parse(msg.slice(msg.indexOf('{')));
          expect(json.code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
          expect(json.message).toContain('Cannot verify host tool phase gate');
          expect(json.message).toContain('session directory exists');
          expect(json.diagnostics.diagnosticCode).toBe('RUNTIME_ENFORCEMENT_CONTEXT_UNAVAILABLE');
          expect(json.diagnostics.missingEvidence).toContain('readable_session_state');
          expect(json.diagnosticCard).toBeUndefined();
        }
      } finally {
        await ws.cleanup();
      }
    });

    it('EDGE — edit in ARCHITECTURE phase is blocked', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(sessDir, makeState('ARCHITECTURE'));

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'edit', sessionID, callID: 'c1' };
        const output = { args: { filePath: '/tmp/file.ts', oldString: 'a', newString: 'b' } };
        await expect(beforeHook(input, output)).rejects.toThrow('HOST_TOOL_PHASE_DENIED');
      } finally {
        await ws.cleanup();
      }
    });

    it('SMOKE — enforcement error has correct name and structured message', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(sessDir, makeState('PLAN'));

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        const input = { tool: 'bash', sessionID, callID: 'c1' };
        const output = { args: { command: 'rm -rf /' } };
        try {
          await beforeHook(input, output);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          const error = err as Error;
          expect(error.name).toBe('FlowGuardEnforcementError');
          expect(error.message).toContain('HOST_TOOL_PHASE_DENIED');
          expect(error.message).toContain('bash');
        }
      } finally {
        await ws.cleanup();
      }
    });

    it('CORNER — resolveEnforcement throws → sessionState=null, blocks with controlled error', async () => {
      // When resolveEnforcement fails (e.g. corrupt state), it returns
      // { strictEnforcement: true, sessionState: null }. enforceBeforeVerdict
      // MUST handle null sessionState with a controlled block, not an
      // unhandled crash from null.property access.
      //
      // In strict mode with null session state and no pending review,
      // enforceBeforeVerdict returns REVIEW_ASSURANCE_STATE_UNAVAILABLE.
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        // Write corrupt state — resolveEnforcement will catch the readState error
        await fs.writeFile(
          path.join(sessDir, 'session-state.json'),
          '{ corrupt json causes readState to throw }',
          'utf-8',
        );

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        // Use a verdict tool with a reviewVerdict so enforceBeforeVerdict
        // reaches the sessionState null path (instead of short-circuiting).
        const input = { tool: 'flowguard_plan', sessionID, callID: 'c1' };
        const output = { args: { reviewVerdict: 'approve' } };

        // strictEnforcement=true + sessionState=null → controlled block
        await expect(beforeHook(input, output)).rejects.toThrow(
          'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
        );
      } finally {
        await ws.cleanup();
      }
    });

    it('HAPPY — read tool with missing sessDir is allowed (non-mutating, never gated)', async () => {
      // read is not in MUTATING_HOST_TOOLS — isMutatingHostTool('read') is false.
      // The phase gate is never consulted. This remains allowed regardless of
      // session directory state.
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        // Fingerprint resolved (git repo), but no session dir on disk.
        // read is non-mutating → isMutatingHostTool returns false → gate skipped.
        const input = { tool: 'read', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { filePath: '/tmp/some-file.ts' } };
        await expect(beforeHook(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — TRIVIAL classification on src/state write is blocked and persisted', async () => {
      const ws = await createTestWorkspace();
      try {
        await initGitRepo(ws.tmpDir);
        const sessionID = crypto.randomUUID();
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(
          sessDir,
          makeState('IMPLEMENTATION', {
            claimedTaskClass: 'TRIVIAL',
            policySnapshot: {
              ...makeState('IMPLEMENTATION').policySnapshot,
              mode: 'regulated',
              requestedMode: 'regulated',
              enforceRiskClassification: true,
            },
          }),
        );

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;
        const input = { tool: 'write', sessionID, callID: 'c1' };
        const output = {
          args: { filePath: path.join(ws.tmpDir, 'src/state/schema.ts'), content: 'x' },
        };

        await expect(beforeHook(input, output)).rejects.toThrow('RISK_CLASSIFICATION_MISMATCH');
        const state = await readState(sessDir);
        expect(state?.riskGate?.status).toBe('blocked');
        expect(state?.riskGate?.lastDecisionId).toMatch(/^RISK-/);
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — missing classification in regulated enforcement is not warning-only', async () => {
      const ws = await createTestWorkspace();
      try {
        await initGitRepo(ws.tmpDir);
        const sessionID = crypto.randomUUID();
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(
          sessDir,
          makeState('IMPLEMENTATION', {
            policySnapshot: {
              ...makeState('IMPLEMENTATION').policySnapshot,
              mode: 'regulated',
              requestedMode: 'regulated',
              enforceRiskClassification: true,
            },
          }),
        );

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;
        const input = { tool: 'write', sessionID, callID: 'c1' };
        const output = { args: { filePath: path.join(ws.tmpDir, 'README.md'), content: 'x' } };

        await expect(beforeHook(input, output)).rejects.toThrow('RISK_CLASSIFICATION_REQUIRED');
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — changed-files evidence failure blocks under enforced policy', async () => {
      const ws = await createTestWorkspace();
      try {
        await initGitRepo(ws.tmpDir);
        const sessionID = crypto.randomUUID();
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(
          sessDir,
          makeState('IMPLEMENTATION', {
            claimedTaskClass: 'HIGH-RISK',
            policySnapshot: {
              ...makeState('IMPLEMENTATION').policySnapshot,
              mode: 'regulated',
              requestedMode: 'regulated',
              enforceRiskClassification: true,
            },
          }),
        );

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        await fs.rm(path.join(ws.tmpDir, '.git'), { recursive: true, force: true });

        const beforeHook = hooks['tool.execute.before']!;
        await expect(
          beforeHook(
            { tool: 'write', sessionID, callID: 'c1' },
            { args: { filePath: path.join(ws.tmpDir, 'README.md'), content: 'x' } },
          ),
        ).rejects.toThrow('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');

        const state = await readState(sessDir);
        expect(state?.riskGate?.status).toBe('blocked');
        expect(state?.riskGate?.code).toBe('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
        const audit = await readAuditTrail(sessDir);
        expect(audit.events.some((event) => event.event === 'risk:classification_checked')).toBe(
          true,
        );
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — bash after-hook mismatch hard-blocks output and next mutating tool', async () => {
      const ws = await createTestWorkspace();
      try {
        await initGitRepo(ws.tmpDir);
        const sessionID = crypto.randomUUID();
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(
          sessDir,
          makeState('IMPLEMENTATION', {
            claimedTaskClass: 'TRIVIAL',
            policySnapshot: {
              ...makeState('IMPLEMENTATION').policySnapshot,
              mode: 'regulated',
              requestedMode: 'regulated',
              enforceRiskClassification: true,
            },
          }),
        );

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const afterHook = hooks['tool.execute.after']!;
        await fs.mkdir(path.join(ws.tmpDir, 'src/state'), { recursive: true });
        await fs.writeFile(path.join(ws.tmpDir, 'src/state/risk-new.ts'), 'export const x = 1;');

        const output = { output: 'bash ok' };
        await afterHook({ tool: 'bash', sessionID, callID: 'c1' }, output);
        expect(output.output).toContain('RISK_CLASSIFICATION_MISMATCH');

        const state = await readState(sessDir);
        expect(state?.riskGate?.status).toBe('blocked');

        const beforeHook = hooks['tool.execute.before']!;
        await expect(
          beforeHook(
            { tool: 'write', sessionID, callID: 'c2' },
            { args: { filePath: path.join(ws.tmpDir, 'README.md'), content: 'x' } },
          ),
        ).rejects.toThrow('RISK_GATE_BLOCKED');
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — bash after-hook evidence failure produces strict blocked output', async () => {
      const ws = await createTestWorkspace();
      try {
        await initGitRepo(ws.tmpDir);
        const sessionID = crypto.randomUUID();
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(
          sessDir,
          makeState('IMPLEMENTATION', {
            claimedTaskClass: 'HIGH-RISK',
            policySnapshot: {
              ...makeState('IMPLEMENTATION').policySnapshot,
              mode: 'regulated',
              requestedMode: 'regulated',
              enforceRiskClassification: true,
            },
          }),
        );

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        await fs.rm(path.join(ws.tmpDir, '.git'), { recursive: true, force: true });

        const afterHook = hooks['tool.execute.after']!;
        const output = { output: 'bash ok' };
        await afterHook({ tool: 'bash', sessionID, callID: 'c1' }, output);

        expect(output.output).toContain('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
        expect(output.output).toContain('BLOCKED');
        const state = await readState(sessDir);
        expect(state?.riskGate?.status).toBe('blocked');
        expect(state?.riskGate?.code).toBe('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — persisted strict TSA failure blocks next mutating tool', async () => {
      const ws = await createTestWorkspace();
      try {
        await initGitRepo(ws.tmpDir);
        const sessionID = crypto.randomUUID();
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        await writeState(
          sessDir,
          makeState('IMPLEMENTATION', {
            error: {
              code: 'TSA_TIMESTAMP_ASSURANCE_FAILED',
              message: 'Strict timestamp assurance failed for lifecycle: TSA request failed',
              recoveryHint: 'Fix TSA connectivity or trust anchors.',
              occurredAt: new Date().toISOString(),
            },
          }),
        );

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        await expect(
          beforeHook(
            { tool: 'write', sessionID, callID: 'c1' },
            { args: { filePath: path.join(ws.tmpDir, 'README.md'), content: 'x' } },
          ),
        ).rejects.toThrow('TSA_TIMESTAMP_ASSURANCE_FAILED');
      } finally {
        await ws.cleanup();
      }
    });
  });
});
