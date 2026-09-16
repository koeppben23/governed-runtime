/**
 * @module integration/plugin-beforehooks.test
 * @description Direct tests for the before-hook enforcement gate:
 *              command scope, host tool fail-closed resolution, verdict
 *              null-arg stripping, and the reconcile-before-side-effects
 *              ordering.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { commandBefore, mayResumeSystemWorkOnCommand, toolBefore } from './plugin-beforehooks.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import type { AuditDeps } from './plugin-audit.js';
import type { PluginWorkspace } from './plugin-workspace.js';
import { createSessionState } from './review/enforcement/enforcement.js';
import { makeState, FROZEN_IMPLEMENTATION_BASE } from '../fixtures.js';
import { writeState, readState } from '../adapters/persistence.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { createTestWorkspace, repositoryDiscoveryContext } from './test-helpers.js';
import type { SessionState } from '../state/schema.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';

// The test workspace carries a fake `.git` marker rather than a real
// repository; the git prerequisite gate for mutating host tools treats it as a
// repository. The non-Git block is covered by the dedicated e2e regression in
// mutation-episode-e2e.test.ts and the plugin-git-gate unit suite.
vi.mock('../adapters/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    isGitRepoStrict: vi.fn().mockResolvedValue(true),
  };
});

function makeRuntime(
  overrides: Omit<Partial<FlowGuardPluginRuntime>, 'ws'> & { ws?: Partial<PluginWorkspace> } = {},
): FlowGuardPluginRuntime {
  const base = {
    ws: {
      getSessionDir: vi.fn().mockReturnValue(null),
      getEnforcementState: vi.fn(() => createSessionState()),
      ...(overrides.ws ?? {}),
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    adapterLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    riskDeps: { getSessionDir: vi.fn(), getWorktreeRoot: vi.fn() },
    discoveryHealthDeps: { getSessionDir: vi.fn(), getWorkspaceDir: vi.fn() },
    orchestratorDeps: {} as FlowGuardPluginRuntime['orchestratorDeps'],
    auditDeps: makeAuditDeps(null, null),
    toolTraceIds: new Map<string, string>(),
    activeCommandScopes: new Map<string, 'check'>(),
    checkReworkContinuations: new Set<string>(),
    logError: vi.fn(),
  };
  const { ws: wsOverrides, ...rest } = overrides;
  const merged = { ...base, ...rest };
  merged.ws = { ...base.ws, ...(wsOverrides ?? {}) };
  return merged as unknown as FlowGuardPluginRuntime;
}

function makeAuditDeps(sessDir: string | null, state: SessionState | null): AuditDeps {
  return {
    resolveFingerprint: vi.fn(async () => 'fp-abc'),
    getSessionDir: vi.fn(() => sessDir),
    resolveSessionPolicy: vi.fn(async () => ({
      policy: {
        audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: true },
        actorClassification: {},
        mode: 'solo',
        requireHumanGates: false,
      },
      state,
    })),
    initChain: vi.fn(async () => 'prev-hash'),
    invalidateChainState: vi.fn(),
    appendAndTrack: vi.fn(async (evt: { chainHash?: string }) => {
      evt.chainHash = 'chain-000';
    }),
    nextDecisionSequence: vi.fn(async () => 1),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    logError: vi.fn(),
    cachedFingerprint: 'fp-abc',
    mode: 'solo',
  };
}

const SESSION_ID = crypto.randomUUID();

async function seedSession(dir: string, state: SessionState): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeState(dir, state);
}

describe('mayResumeSystemWorkOnCommand', () => {
  it('never resumes for read-only or emergency commands', () => {
    for (const command of [
      '/status',
      '/status --readiness',
      '/why',
      '/finish',
      '/help',
      '/commands',
      '/archive',
      '/abort',
    ]) {
      expect(mayResumeSystemWorkOnCommand(command), command).toBe(false);
    }
  });

  it('resumes for workflow-mutating commands', () => {
    for (const command of [
      '/continue',
      '/implement',
      '/plan',
      '/approve',
      '/override-approve',
      '/task',
      '/architecture',
      '/review',
    ]) {
      expect(mayResumeSystemWorkOnCommand(command), command).toBe(true);
    }
  });

  it('never resumes without a command', () => {
    expect(mayResumeSystemWorkOnCommand('')).toBe(false);
    expect(mayResumeSystemWorkOnCommand('   ')).toBe(false);
  });
});

describe('commandBefore', () => {
  it('warns and skips when the command has no sessionID', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, {}, {});
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'decision',
      'command.execute.before missing sessionID',
    );
  });

  it('warns and skips for a null command input', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, null, null);
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'decision',
      'command.execute.before missing sessionID',
    );
  });

  it('records a user decision intent for /approve', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, { sessionID: SESSION_ID, command: '/approve', arguments: '' }, {});
    expect(runtime.log.info).toHaveBeenCalledWith(
      'decision',
      'recorded user decision command intent',
      expect.objectContaining({ expectedVerdict: 'approve' }),
    );
  });

  it('records a decision intent from /review-decision arguments', async () => {
    const runtime = makeRuntime();
    await commandBefore(
      runtime,
      { sessionID: SESSION_ID, command: '/review-decision', arguments: 'reject' },
      {},
    );
    expect(runtime.log.info).toHaveBeenCalledWith(
      'decision',
      'recorded user decision command intent',
      expect.objectContaining({ sessionId: SESSION_ID, expectedVerdict: 'reject' }),
    );
  });

  it('returns without recording for a non-decision command', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, { sessionID: SESSION_ID, command: '/plan', arguments: '' }, {});
    expect(runtime.log.info).not.toHaveBeenCalled();
  });

  it('returns without recording when command and arguments are missing', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, { sessionID: SESSION_ID }, {});
    expect(runtime.log.info).not.toHaveBeenCalled();
  });

  it('sets the check scope for /check and clears it for other commands', async () => {
    const runtime = makeRuntime();
    runtime.activeCommandScopes.set(SESSION_ID, 'check');
    await commandBefore(runtime, { sessionID: SESSION_ID, command: 'plan', arguments: '' }, {});
    expect(runtime.activeCommandScopes.has(SESSION_ID)).toBe(false);
    await commandBefore(runtime, { sessionID: SESSION_ID, command: '/check', arguments: '' }, {});
    expect(runtime.activeCommandScopes.get(SESSION_ID)).toBe('check');
  });
});

describe('toolBefore — host tool fail-closed resolution', () => {
  it('blocks an empty tool identity without a session mapping', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(runtime, { tool: '', sessionID: SESSION_ID }, { args: {} }),
    ).rejects.toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('blocks a null tool input without crashing', async () => {
    const runtime = makeRuntime();
    await expect(toolBefore(runtime, null, null)).rejects.toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('allows read-only host tools without reconciliation', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(runtime, { tool: 'read', sessionID: SESSION_ID }, { args: {} }),
    ).resolves.toBeUndefined();
  });

  it('handles a missing output args object for read-only tools', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(runtime, { tool: 'read', sessionID: SESSION_ID, callID: 'c1' }, null),
    ).resolves.toBeUndefined();
  });

  it('handles a missing callID via the trace fallback registry', async () => {
    const runtime = makeRuntime();
    await toolBefore(runtime, { tool: 'read', sessionID: SESSION_ID }, { args: {} });
    expect(runtime.toolTraceIds.has(`${SESSION_ID}:read`)).toBe(true);
  });

  it('blocks a mutating host tool when the session mapping is unavailable', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(runtime, { tool: 'write', sessionID: SESSION_ID }, { args: {} }),
    ).rejects.toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('blocks with SESSION_DIR_NOT_FOUND when the directory is missing', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'does-not-exist');
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      await expect(
        toolBefore(runtime, { tool: 'write', sessionID: SESSION_ID }, { args: {} }),
      ).rejects.toThrow('SESSION_DIR_NOT_FOUND');
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks when the session directory has no state file', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-empty');
      await fs.mkdir(sessDir, { recursive: true });
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      await expect(
        toolBefore(runtime, { tool: 'write', sessionID: SESSION_ID }, { args: {} }),
      ).rejects.toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks when the session state file is unreadable', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-corrupt');
      await fs.mkdir(sessDir, { recursive: true });
      await fs.writeFile(path.join(sessDir, 'session-state.json'), '{ corrupt json', 'utf8');
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      await expect(
        toolBefore(runtime, { tool: 'write', sessionID: SESSION_ID }, { args: {} }),
      ).rejects.toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    } finally {
      await ws.cleanup();
    }
  });

  it('propagates a persisted session error state', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-error');
      await seedSession(
        sessDir,
        makeState('IMPLEMENTATION', {
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
          error: {
            code: 'SESSION_ERROR',
            message: 'broken',
            recoveryHint: 're-hydrate',
            occurredAt: '2026-05-15T12:00:00.000Z',
          },
        }),
      );
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      await expect(
        toolBefore(runtime, { tool: 'write', sessionID: SESSION_ID }, { args: {} }),
      ).rejects.toThrow('SESSION_ERROR');
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks a mutating host tool outside IMPLEMENTATION', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-plan');
      await seedSession(sessDir, makeState('PLAN'));
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      await expect(
        toolBefore(runtime, { tool: 'write', sessionID: SESSION_ID }, { args: {} }),
      ).rejects.toThrow('HOST_TOOL_PHASE_DENIED');
    } finally {
      await ws.cleanup();
    }
  });

  it('default-denies an unknown tool identity in a mutating phase', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await seedSession(
        sessDir,
        makeState('IMPLEMENTATION', { implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE }),
      );
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      await expect(
        toolBefore(runtime, { tool: 'unknown_host_tool', sessionID: SESSION_ID }, { args: {} }),
      ).rejects.toThrow('HOST_TOOL_UNKNOWN_DENIED');
    } finally {
      await ws.cleanup();
    }
  });

  it('reconciles before the side-effecting risk gate and then allows bash', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      const state = makeState('IMPLEMENTATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
      });
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
        riskDeps: { getSessionDir: vi.fn(), getWorktreeRoot: vi.fn(() => ws.tmpDir) },
        discoveryHealthDeps: { getSessionDir: vi.fn(), getWorkspaceDir: vi.fn(() => ws.tmpDir) },
      });
      await expect(
        toolBefore(
          runtime,
          { tool: 'bash', sessionID: SESSION_ID, callID: 'call-bash' },
          { args: { command: 'echo' } },
        ),
      ).resolves.toBeUndefined();
      expect(runtime.auditDeps.getSessionDir).toHaveBeenCalled();
    } finally {
      await ws.cleanup();
    }
  });
});

describe('toolBefore — command scope', () => {
  it('denies workflow tools while the /check scope is active', async () => {
    const runtime = makeRuntime();
    runtime.activeCommandScopes.set(SESSION_ID, 'check');
    await expect(
      toolBefore(runtime, { tool: 'flowguard_plan', sessionID: SESSION_ID }, { args: {} }),
    ).rejects.toThrow('COMMAND_SCOPE_DENIED');
  });

  it('allows flowguard_status while the /check scope is active', async () => {
    const runtime = makeRuntime();
    runtime.activeCommandScopes.set(SESSION_ID, 'check');
    await expect(
      toolBefore(runtime, { tool: 'flowguard_status', sessionID: SESSION_ID }, { args: {} }),
    ).resolves.toBeUndefined();
  });

  it('denies a generic task outside IMPL_REVIEW during /check', async () => {
    const runtime = makeRuntime();
    runtime.activeCommandScopes.set(SESSION_ID, 'check');
    await expect(
      toolBefore(runtime, { tool: 'task', sessionID: SESSION_ID }, { args: { subagent_type: '' } }),
    ).rejects.toThrow('COMMAND_SCOPE_DENIED');
  });

  it('allows flowguard_review_implementation in IMPL_REVIEW during /check', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl-review');
      const state = makeState('IMPL_REVIEW');
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
      });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(
          runtime,
          { tool: 'flowguard_review_implementation', sessionID: SESSION_ID },
          { args: {} },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it('denies flowguard_review_implementation outside IMPL_REVIEW during /check', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-plan');
      await seedSession(sessDir, makeState('PLAN'));
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(
          runtime,
          { tool: 'flowguard_review_implementation', sessionID: SESSION_ID },
          { args: {} },
        ),
      ).rejects.toThrow('COMMAND_SCOPE_DENIED');
    } finally {
      await ws.cleanup();
    }
  });

  it('denies flowguard_implement during /check when no rework marker is active', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await seedSession(
        sessDir,
        makeState('IMPLEMENTATION', {
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        }),
      );
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(runtime, { tool: 'flowguard_implement', sessionID: SESSION_ID }, { args: {} }),
      ).rejects.toThrow('COMMAND_SCOPE_DENIED');
    } finally {
      await ws.cleanup();
    }
  });

  it('denies flowguard_implement during /check when the rework budget is exhausted', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      const exhaustedState = makeState('IMPLEMENTATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        implementationRework: { rejectedDigest: 'digest-x', exhausted: true },
      });
      await seedSession(sessDir, exhaustedState);
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(runtime, { tool: 'flowguard_implement', sessionID: SESSION_ID }, { args: {} }),
      ).rejects.toThrow('COMMAND_SCOPE_DENIED');
    } finally {
      await ws.cleanup();
    }
  });

  it('allows flowguard_implement during /check with an active non-exhausted rework marker', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      const state = makeState('IMPLEMENTATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        implementationRework: { rejectedDigest: 'digest-x', exhausted: false },
      });
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
      });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(runtime, { tool: 'flowguard_implement', sessionID: SESSION_ID }, { args: {} }),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it('denies a mutating host tool during /check in IMPLEMENTATION without active rework', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await seedSession(
        sessDir,
        makeState('IMPLEMENTATION', {
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        }),
      );
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(
          runtime,
          { tool: 'write', sessionID: SESSION_ID, callID: 'call-write' },
          { args: {} },
        ),
      ).rejects.toThrow('COMMAND_SCOPE_DENIED');
    } finally {
      await ws.cleanup();
    }
  });

  it('allows a mutating host tool during /check with active non-exhausted rework', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      const state = makeState('IMPLEMENTATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        implementationRework: { rejectedDigest: 'digest-x', exhausted: false },
      });
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
        riskDeps: { getSessionDir: vi.fn(), getWorktreeRoot: vi.fn(() => ws.tmpDir) },
        discoveryHealthDeps: { getSessionDir: vi.fn(), getWorkspaceDir: vi.fn(() => ws.tmpDir) },
      });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(
          runtime,
          { tool: 'bash', sessionID: SESSION_ID, callID: 'call-bash' },
          { args: { command: 'echo' } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it('allows read/glob/grep during /check with an active non-exhausted rework marker', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      const state = makeState('IMPLEMENTATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        implementationRework: { rejectedDigest: 'digest-x', exhausted: false },
      });
      await seedSession(sessDir, state);
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      for (const tool of ['read', 'glob', 'grep']) {
        await expect(
          toolBefore(runtime, { tool, sessionID: SESSION_ID }, { args: {} }),
        ).resolves.toBeUndefined();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it('denies read/glob/grep during /check without a rework marker', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await seedSession(
        sessDir,
        makeState('IMPLEMENTATION', {
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        }),
      );
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      for (const tool of ['read', 'glob', 'grep']) {
        await expect(
          toolBefore(runtime, { tool, sessionID: SESSION_ID }, { args: {} }),
        ).rejects.toThrow('COMMAND_SCOPE_DENIED');
      }
    } finally {
      await ws.cleanup();
    }
  });

  it('keeps the repair surface unlocked after re-record and a failing fresh check (latch, no marker)', async () => {
    const ws = await createTestWorkspace();
    try {
      // Defensive side of the continuity contract: even if a continuation-state
      // carried NO rework marker in IMPLEMENTATION (the marker is normally
      // retained across re-records now, but the latch must not key on it), a
      // latched continuation keeps the repair surface unlocked after a fresh
      // check FAILED → IMPLEMENTATION.
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      const postRerecordState = makeState('IMPLEMENTATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        implementation: null,
        implementationRework: null,
        implValidation: [
          {
            checkId: 'test',
            passed: false,
            detail: 'Failed (exit 1, 100ms)',
            executedAt: new Date().toISOString(),
            kind: 'test',
            command: 'npm test',
            exitCode: 1,
            executionMs: 100,
            outputDigest: 'b'.repeat(64),
            timedOut: false,
            outcome: 'inconclusive' as const,
          },
        ],
      });
      await seedSession(sessDir, postRerecordState);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, postRerecordState),
        riskDeps: { getSessionDir: vi.fn(), getWorktreeRoot: vi.fn(() => ws.tmpDir) },
        discoveryHealthDeps: { getSessionDir: vi.fn(), getWorkspaceDir: vi.fn(() => ws.tmpDir) },
      });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      // The afterhook latched the continuation when it observed the active
      // rework marker at the changes_requested verdict; it survives re-records.
      runtime.checkReworkContinuations.add(SESSION_ID);
      for (const tool of ['read', 'glob', 'grep']) {
        await expect(
          toolBefore(runtime, { tool, sessionID: SESSION_ID }, { args: {} }),
        ).resolves.toBeUndefined();
      }
      await expect(
        toolBefore(runtime, { tool: 'flowguard_implement', sessionID: SESSION_ID }, { args: {} }),
      ).resolves.toBeUndefined();
      await expect(
        toolBefore(
          runtime,
          { tool: 'bash', sessionID: SESSION_ID, callID: 'call-bash' },
          { args: { command: 'echo' } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it('denies the repair surface after a failing fresh check when no continuation is latched', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await seedSession(
        sessDir,
        makeState('IMPLEMENTATION', {
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        }),
      );
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      for (const tool of ['read', 'bash', 'flowguard_implement']) {
        await expect(
          toolBefore(
            runtime,
            { tool, sessionID: SESSION_ID, callID: `call-${tool}` },
            { args: {} },
          ),
        ).rejects.toThrow('COMMAND_SCOPE_DENIED');
      }
    } finally {
      await ws.cleanup();
    }
  });

  it('denies the repair surface during /check when the rework budget is exhausted despite the latch', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await seedSession(
        sessDir,
        makeState('IMPLEMENTATION', {
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
          implementationRework: { rejectedDigest: 'digest-x', exhausted: true },
        }),
      );
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      runtime.checkReworkContinuations.add(SESSION_ID);
      for (const tool of ['read', 'bash', 'flowguard_implement']) {
        await expect(
          toolBefore(
            runtime,
            { tool, sessionID: SESSION_ID, callID: `call-${tool}` },
            { args: {} },
          ),
        ).rejects.toThrow('COMMAND_SCOPE_DENIED');
      }
    } finally {
      await ws.cleanup();
    }
  });

  it('allows flowguard_resolve_implementation_challenge in IMPL_REVIEW during /check', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl-review');
      const state = makeState('IMPL_REVIEW');
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
      });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(
          runtime,
          { tool: 'flowguard_resolve_implementation_challenge', sessionID: SESSION_ID },
          { args: {} },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it('denies flowguard_resolve_implementation_challenge outside IMPL_REVIEW during /check', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await seedSession(
        sessDir,
        makeState('IMPLEMENTATION', {
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        }),
      );
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(
          runtime,
          { tool: 'flowguard_resolve_implementation_challenge', sessionID: SESSION_ID },
          { args: {} },
        ),
      ).rejects.toThrow('COMMAND_SCOPE_DENIED');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('toolBefore — workflow reconciliation gate', () => {
  it('blocks a workflow tool when no audit session authority exists', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(runtime, { tool: 'flowguard_plan', sessionID: SESSION_ID }, { args: {} }),
    ).rejects.toThrow('AUDIT_SESSION_AUTHORITY_UNAVAILABLE');
  });

  it('allows a workflow tool when the audit session authority resolves', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-plan');
      const state = makeState('PLAN');
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
      });
      await expect(
        toolBefore(runtime, { tool: 'flowguard_plan', sessionID: SESSION_ID }, { args: {} }),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks persistent operational tools when no audit session authority exists', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(runtime, { tool: 'flowguard_archive', sessionID: SESSION_ID }, { args: {} }),
    ).rejects.toThrow('AUDIT_SESSION_AUTHORITY_UNAVAILABLE');
    await expect(
      toolBefore(
        runtime,
        { tool: 'flowguard_record_mutation_evidence', sessionID: SESSION_ID },
        { args: {} },
      ),
    ).rejects.toThrow('AUDIT_SESSION_AUTHORITY_UNAVAILABLE');
  });

  it('allows persistent operational tools with a healthy audit session', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-archive');
      const state = makeState('COMPLETE');
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
      });
      await expect(
        toolBefore(runtime, { tool: 'flowguard_archive', sessionID: SESSION_ID }, { args: {} }),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it('keeps read-only operational tools available without a session', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(runtime, { tool: 'flowguard_status', sessionID: SESSION_ID }, { args: {} }),
    ).resolves.toBeUndefined();
    await expect(
      toolBefore(runtime, { tool: 'flowguard_help', sessionID: SESSION_ID }, { args: {} }),
    ).resolves.toBeUndefined();
  });
});

describe('toolBefore — observation capability parent binding', () => {
  const OBLIGATION_ID = '33333333-1111-4111-8111-111111111111';
  const ATTEMPT_ID = '33333333-2222-4111-8111-111111111111';
  const CAPABILITY = `fgc_${'a'.repeat(64)}`;

  async function seedParentWithCapability(
    ws: Awaited<ReturnType<typeof createTestWorkspace>>,
  ): Promise<{ parentId: string; sessDir: string; fingerprint: string; state: SessionState }> {
    const fingerprint = (await computeFingerprint(ws.tmpDir)).fingerprint;
    const parentId = crypto.randomUUID();
    const sessDir = resolveSessionDir(fingerprint, parentId);
    const now = new Date().toISOString();
    const state = makeState('PLAN', {
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [
          {
            obligationId: OBLIGATION_ID,
            obligationType: 'plan',
            reviewCycle: 1,
            requiredChallengeCount: 0,
            requiredChallengeKind: 'design_challenge' as const,
            challengePolicyVersion: 'challenge-policy.v1' as const,
            subjectDigest: 'obs-subject-digest',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            maxReviewerAttempts: 1,
            reviewProfile: 'core' as const,
            profileSource: 'policy_default' as const,
            createdAt: now,
            pluginHandshakeAt: null,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
            reviewMaterial: {
              content: '## Plan\n',
              materialDigest: 'material-digest',
              subjectDigest: 'obs-subject-digest',
            },
            repositoryEvidenceFreeze: { kind: 'available' as const },
            repositoryAuthority: {
              kind: 'context' as const,
              context: {
                kind: 'commit' as const,
                repositoryIdentity: {
                  kind: 'local' as const,
                  rootCommitDigest: `sha256:${'d'.repeat(64)}`,
                },
                objectSha: 'e'.repeat(40),
              },
            },
            reviewSubjectScope: {
              kind: 'artifact',
              artifact: {
                kind: 'plan',
                digest: 'obs-subject-digest',
                sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }]],
              },
            },
          },
        ],
        invocations: [],
        attempts: [
          {
            attemptId: ATTEMPT_ID,
            obligationId: OBLIGATION_ID,
            obligationType: 'plan',
            subjectDigest: 'obs-subject-digest',
            ordinal: 0,
            status: 'created',
            origin: { kind: 'initial' } as const,
            repositoryDiscovery: repositoryDiscoveryContext(now),
            observationCapability: CAPABILITY,
            observations: [],
            createdAt: now,
          },
        ],
        dispatches: [],
      },
    });
    await writeState(sessDir, state);
    return { parentId, sessDir, fingerprint, state };
  }

  it('BAD — child without state blocks when the owning parent has an unresolved outbox', async () => {
    const ws = await createTestWorkspace();
    try {
      const { sessDir, fingerprint, state } = await seedParentWithCapability(ws);
      const transition = {
        from: 'TICKET',
        to: 'PLAN',
        event: 'PLAN_READY',
        at: '2026-05-15T12:00:00.000Z',
      } as const;
      const persisted = await writeStateWithArtifactsAndAuditOperations(
        sessDir,
        { ...state, transition },
        [transition],
      );
      await fs.writeFile(path.join(sessDir, 'audit.jsonl'), '{ malformed json\n', 'utf8');
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: {
          ...makeAuditDeps(sessDir, persisted),
          cachedFingerprint: fingerprint,
        },
      });
      const childId = crypto.randomUUID();
      await expect(
        toolBefore(
          runtime,
          { tool: 'flowguard_observe_repository', sessionID: childId },
          { args: { capability: CAPABILITY, revision: 'base', path: 'src/foo.ts' } },
        ),
      ).rejects.toThrow('AUDIT_PERSISTENCE_FAILED');
    } finally {
      await ws.cleanup();
    }
  });

  it('HAPPY — child without state passes when the owning parent outbox is clean', async () => {
    const ws = await createTestWorkspace();
    try {
      const { parentId, sessDir, fingerprint, state } = await seedParentWithCapability(ws);
      const runtime = makeRuntime({
        ws: {
          getSessionDir: vi.fn((sid: string) => (sid === parentId ? sessDir : null)),
        },
        auditDeps: {
          ...makeAuditDeps(sessDir, state),
          cachedFingerprint: fingerprint,
        },
      });
      await expect(
        toolBefore(
          runtime,
          { tool: 'flowguard_observe_repository', sessionID: crypto.randomUUID() },
          { args: { capability: CAPABILITY, revision: 'head', path: 'src/foo.ts' } },
        ),
      ).resolves.toBeUndefined();
      expect(runtime.auditDeps.getSessionDir).toHaveBeenCalledWith(parentId);
    } finally {
      await ws.cleanup();
    }
  });

  it('CORNER — a missing capability arg defers to the tool-level validation', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(
        runtime,
        { tool: 'flowguard_observe_repository', sessionID: crypto.randomUUID() },
        { args: {} },
      ),
    ).resolves.toBeUndefined();
  });

  it('CORNER — an unknown capability defers to the tool-level block', async () => {
    const ws = await createTestWorkspace();
    try {
      const fingerprint = (await computeFingerprint(ws.tmpDir)).fingerprint;
      const runtime = makeRuntime({
        auditDeps: { ...makeAuditDeps(null, null), cachedFingerprint: fingerprint },
      });
      await expect(
        toolBefore(
          runtime,
          { tool: 'flowguard_observe_repository', sessionID: crypto.randomUUID() },
          { args: { capability: 'unknown-cap', revision: 'base', path: 'src/foo.ts' } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it('BAD — fails closed when no fingerprint authority exists', async () => {
    const runtime = makeRuntime({
      auditDeps: { ...makeAuditDeps(null, null), cachedFingerprint: null },
    });
    await expect(
      toolBefore(
        runtime,
        { tool: 'flowguard_observe_repository', sessionID: crypto.randomUUID() },
        { args: { capability: 'cap-x', revision: 'base', path: 'src/foo.ts' } },
      ),
    ).rejects.toThrow('AUDIT_SESSION_AUTHORITY_UNAVAILABLE');
  });
});

describe('toolBefore — verdict null-arg stripping', () => {
  it('strips null-valued args before verdict enforcement', async () => {
    const runtime = makeRuntime();
    const args = { verdict: 'approve', rationale: null, planVersion: '1' };
    try {
      await toolBefore(
        runtime,
        { tool: 'flowguard_plan', sessionID: SESSION_ID, callID: 'c1' },
        { args },
      );
    } catch {
      // blocked verdict paths still prove the stripping ran first
    }
    expect(args.rationale).toBeUndefined();
    expect(args.planVersion).toBe('1');
  });

  it('blocks a verdict submission without a pending decision', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-plan');
      await seedSession(sessDir, makeState('PLAN_REVIEW'));
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      let caught: unknown;
      try {
        await toolBefore(
          runtime,
          { tool: 'flowguard_plan', sessionID: SESSION_ID, callID: 'c1' },
          { args: { verdict: 'approve' } },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe('FlowGuardEnforcementError');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('toolBefore — review implementation tool', () => {
  it('reconciles workflow tools before execution and allows a healthy session', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl-review');
      const state = makeState('IMPL_REVIEW');
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
      });
      await expect(
        toolBefore(
          runtime,
          { tool: 'flowguard_review_implementation', sessionID: SESSION_ID },
          { args: {} },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks when reconciliation fails even for an otherwise healthy session', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-ticket');
      const base = makeState('TICKET');
      await seedSession(sessDir, base);
      const transition = {
        from: 'TICKET',
        to: 'PLAN',
        event: 'PLAN_READY',
        at: '2026-05-15T12:00:00.000Z',
      } as const;
      const { writeStateWithArtifactsAndAuditOperations } = await import('./tools/helpers.js');
      const persisted = await writeStateWithArtifactsAndAuditOperations(
        sessDir,
        makeState('PLAN', { transition }),
        [transition],
      );
      await fs.writeFile(path.join(sessDir, 'audit.jsonl'), '{ malformed json\n', 'utf8');
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, persisted),
      });
      await expect(
        toolBefore(runtime, { tool: 'flowguard_ticket', sessionID: SESSION_ID }, { args: {} }),
      ).rejects.toThrow('AUDIT_PERSISTENCE_FAILED');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('toolBefore — trace registry', () => {
  it('stores a trace id per before-call', async () => {
    const runtime = makeRuntime();
    const input = { tool: 'read', sessionID: SESSION_ID };
    await toolBefore(runtime, input, { args: {} });
    expect(runtime.toolTraceIds.has(`${SESSION_ID}:read`)).toBe(true);
  });

  it('a host retry with the same callID is processed deterministically', async () => {
    const runtime = makeRuntime();
    const input = { tool: 'read', sessionID: SESSION_ID, callID: 'retry-1' };
    await toolBefore(runtime, input, { args: {} });
    await toolBefore(runtime, input, { args: {} });
    expect(runtime.toolTraceIds.size).toBe(0);
  });
});

describe('state reads stay consistent', () => {
  it('reads the seeded session state through the runtime mapping', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-check');
      const state = makeState('PLAN');
      await seedSession(sessDir, state);
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      const loaded = await readState(sessDir);
      expect(loaded?.phase).toBe('PLAN');
      expect(runtime.ws.getSessionDir(SESSION_ID)).toBe(sessDir);
    } finally {
      await ws.cleanup();
    }
  });
});
