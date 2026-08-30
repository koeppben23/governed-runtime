/**
 * @module integration/plugin-beforehooks.test
 * @description Direct tests for the before-hook enforcement gate:
 *              command scope, reviewer task authorization, host tool
 *              fail-closed resolution, verdict null-arg stripping, and the
 *              reconcile-before-side-effects ordering.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { commandBefore, toolBefore } from './plugin-beforehooks.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import type { AuditDeps } from './plugin-audit.js';
import type { PluginWorkspace } from './plugin-workspace.js';
import { createSessionState } from './review/enforcement/enforcement.js';
import type { PendingReview } from './review/enforcement/types.js';
import { pendingObligation } from './plugin-host-task-diagnostics-helpers.js';
import { hashCanonicalReviewContent, normalizeReviewContent } from '../shared/review-subject.js';
import { makeState, FROZEN_IMPLEMENTATION_BASE, IMPL_EVIDENCE } from '../fixtures.js';
import { writeState, readState } from '../adapters/persistence.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { createTestWorkspace } from './test-helpers.js';
import type { SessionState } from '../state/schema.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import { createReviewObligation } from './review/assurance.js';

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
    setCurrentSessionId: vi.fn(),
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

describe('commandBefore', () => {
  it('warns and skips when the command has no sessionID', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, {}, {});
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'decision',
      'command.execute.before missing sessionID',
    );
    expect(runtime.setCurrentSessionId).not.toHaveBeenCalled();
  });

  it('warns and skips for a null command input', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, null, null);
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'decision',
      'command.execute.before missing sessionID',
    );
    expect(runtime.setCurrentSessionId).not.toHaveBeenCalled();
  });

  it('records a user decision intent for /approve and sets the session', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, { sessionID: SESSION_ID, command: '/approve', arguments: '' }, {});
    expect(runtime.setCurrentSessionId).toHaveBeenCalledWith(SESSION_ID);
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
    expect(runtime.setCurrentSessionId).toHaveBeenCalledWith(SESSION_ID);
  });

  it('returns without recording for a non-decision command', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, { sessionID: SESSION_ID, command: '/plan', arguments: '' }, {});
    expect(runtime.setCurrentSessionId).not.toHaveBeenCalled();
  });

  it('returns without recording when command and arguments are missing', async () => {
    const runtime = makeRuntime();
    await commandBefore(runtime, { sessionID: SESSION_ID }, {});
    expect(runtime.setCurrentSessionId).not.toHaveBeenCalled();
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

  it('allows a generic task in IMPL_REVIEW during /check', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl-review');
      await seedSession(sessDir, makeState('IMPL_REVIEW'));
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await expect(
        toolBefore(
          runtime,
          { tool: 'task', sessionID: SESSION_ID },
          { args: { subagent_type: '' } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await ws.cleanup();
    }
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

describe('toolBefore — reviewer task authorization', () => {
  it('blocks a reviewer task without a host callID', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(
        runtime,
        { tool: 'task', sessionID: SESSION_ID, callID: '' },
        { args: { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'x' } },
      ),
    ).rejects.toThrow('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE');
  });

  it('blocks unauthorized subagent types', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(
        runtime,
        { tool: 'task', sessionID: SESSION_ID, callID: 'c1' },
        { args: { subagent_type: 'rogue-agent', prompt: 'x' } },
      ),
    ).rejects.toThrow('SUBAGENT_TYPE_UNAUTHORIZED');
  });

  it('passes generic tasks with an empty subagent type', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(
        runtime,
        { tool: 'task', sessionID: SESSION_ID, callID: 'c1' },
        { args: { subagent_type: '', prompt: 'x' } },
      ),
    ).resolves.toBeUndefined();
  });

  it('passes generic tasks with a missing subagent type', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(runtime, { tool: 'task', sessionID: SESSION_ID, callID: 'c1' }, { args: {} }),
    ).resolves.toBeUndefined();
  });

  it('blocks a reviewer task without a pending review obligation', async () => {
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
        toolBefore(
          runtime,
          { tool: 'task', sessionID: SESSION_ID, callID: 'c1' },
          { args: { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'x' } },
        ),
      ).rejects.toThrow('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE');
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks implementation reviewer dispatch until every prior failure has current-digest resolution evidence', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl-resolution-required');
      const obligation = createReviewObligation({
        obligationType: 'implement',
        iteration: 1,
        planVersion: 1,
        subjectDigest: IMPL_EVIDENCE.digest,
        reviewSubjectScope: { kind: 'implementation', implementationDigest: IMPL_EVIDENCE.digest },
        changedFiles: IMPL_EVIDENCE.changedFiles,
        reviewMaterial: {
          content: '# Implementation\n\nCurrent implementation',
          materialDigest: hashCanonicalReviewContent('# Implementation\n\nCurrent implementation'),
          subjectDigest: IMPL_EVIDENCE.digest,
        },
        policySnapshot: null,
        now: '2026-01-01T00:00:00.000Z',
      });
      const state = makeState('IMPL_REVIEW', {
        implementation: IMPL_EVIDENCE,
        implReviewFindings: [
          {
            iteration: 1,
            planVersion: 1,
            reviewMode: 'subagent',
            overallVerdict: 'changes_requested',
            blockingIssues: [],
            majorRisks: [],
            missingVerification: [],
            scopeCreep: [],
            unknowns: [],
            reviewedBy: { sessionId: 'reviewer' },
            reviewedAt: '2026-01-01T00:00:00.000Z',
            challenges: [
              {
                challengeId: '00000000-0000-4000-8000-00000000000a',
                obligationId: obligation.obligationId,
                kind: 'implementation_challenge',
                outcome: 'fail',
                scenario: 'Exercise the failed behavior',
                claim: 'The implementation handles the behavior correctly',
                locations: ['src/auth.ts'],
                evidenceRefs: [
                  { kind: 'implementation', implementationDigest: IMPL_EVIDENCE.digest },
                ],
              },
            ],
          },
        ],
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6',
          obligations: [obligation],
          attempts: [],
          dispatches: [],
          invocations: [],
        },
      });
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
      });

      await expect(
        toolBefore(
          runtime,
          { tool: 'task', sessionID: SESSION_ID, callID: 'c1' },
          { args: { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'x' } },
        ),
      ).rejects.toThrow('SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED');
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks a reviewer task when unreadable session state fails closed', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-corrupt');
      await fs.mkdir(sessDir, { recursive: true });
      await fs.writeFile(path.join(sessDir, 'session-state.json'), '{ corrupt json', 'utf8');
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      await expect(
        toolBefore(
          runtime,
          { tool: 'task', sessionID: SESSION_ID, callID: 'c1' },
          { args: { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'x' } },
        ),
      ).rejects.toThrow('STATE_UNAVAILABLE_FOR_REVIEWER_TASK');
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks a reviewer task under a strict-enforcement policy session', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-strict');
      const base = makeState('PLAN');
      const state = makeState('PLAN', {
        policySnapshot: {
          ...base.policySnapshot,
          selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: true },
        },
      });
      await seedSession(sessDir, state);
      const runtime = makeRuntime({
        ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) },
        auditDeps: makeAuditDeps(sessDir, state),
      });
      await expect(
        toolBefore(
          runtime,
          { tool: 'task', sessionID: SESSION_ID, callID: 'c1' },
          { args: { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'x' } },
        ),
      ).rejects.toThrow('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE');
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks a reviewer task with a non-string subagent_type via the empty-type pass', async () => {
    const runtime = makeRuntime();
    await expect(
      toolBefore(
        runtime,
        { tool: 'task', sessionID: SESSION_ID, callID: 'c1' },
        { args: { subagent_type: 42, prompt: 'x' } },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('toolBefore — reviewer dispatch recovery (before-without-after)', () => {
  const PROMPT = `Review the host-issued artifact with the full plan context.

## Plan
1. Fix authentication
2. Add regression tests
3. Update documentation

iteration=0
planVersion=1

Provide structured findings per the canonical reviewer contract.`.repeat(2);
  const PROMPT_DIGEST = crypto.createHash('sha256').update(PROMPT, 'utf8').digest('hex');
  const PLAN_BODY = normalizeReviewContent('# Plan\n1. Fix auth');
  const MATERIAL_DIGEST = hashCanonicalReviewContent(PLAN_BODY);

  function pendingReviewFor(obligationId: string, attemptId: string): PendingReview {
    return {
      tool: 'flowguard_plan',
      requestedAt: '2026-01-01T00:00:00.000Z',
      obligationId,
      attemptId,
      subagentCalled: false,
      subagentRecord: null,
      contentMeta: null,
      canonicalPromptAnchor: null,
      expectedPromptDigest: PROMPT_DIGEST,
      canonicalPrompt: PROMPT,
      capturedFindings: null,
      retryCount: 0,
      hostAttestationConstants: null,
      enforcementFailure: null,
      lastSchemaErrors: null,
      repairPromptRequired: false,
      expectedRepairPromptDigest: null,
    };
  }

  function planReviewFixture() {
    const obligation = {
      ...pendingObligation(),
      reviewMaterial: {
        content: PLAN_BODY,
        materialDigest: MATERIAL_DIGEST,
        subjectDigest: 'diagnostics-test-subject',
      },
      repositoryAuthority: undefined,
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' } as const,
    };
    const initialAttempt = {
      attemptId: crypto.randomUUID(),
      obligationId: obligation.obligationId,
      obligationType: 'plan' as const,
      subjectDigest: obligation.subjectDigest,
      reviewMaterial: obligation.reviewMaterial,
      ordinal: 0,
      status: 'created' as const,
      origin: { kind: 'initial' } as const,
      repositoryDiscovery: { kind: 'not_applicable' } as const,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    return { obligation, initialAttempt };
  }

  it('HAPPY — a phantom in-flight dispatch is re-armed as a NEW append-only attempt', async () => {
    const ws = await createTestWorkspace();
    try {
      const fingerprint = (await computeFingerprint(ws.tmpDir)).fingerprint;
      const sessionId = crypto.randomUUID();
      const sessDir = resolveSessionDir(fingerprint, sessionId);
      const { obligation, initialAttempt } = planReviewFixture();
      const state = makeState('PLAN', {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [obligation],
          invocations: [],
          attempts: [initialAttempt],
          dispatches: [
            {
              dispatchId: crypto.randomUUID(),
              attemptId: initialAttempt.attemptId,
              obligationId: obligation.obligationId,
              hostCallId: 'call-a',
              canonicalPromptDigest: PROMPT_DIGEST,
              dispatchAuthorizedAt: '2026-01-01T00:00:00.000Z',
              dispatchStatus: 'authorized' as const,
            },
          ],
        },
      });
      await seedSession(sessDir, state);

      const eState = createSessionState();
      eState.pendingReviews.set(
        'flowguard_plan',
        pendingReviewFor(obligation.obligationId, initialAttempt.attemptId),
      );
      eState.executedTaskPrompts.set('call-a', {
        callId: 'call-a',
        obligationId: obligation.obligationId,
        attemptId: initialAttempt.attemptId,
        canonicalPrompt: PROMPT,
        canonicalPromptDigest: PROMPT_DIGEST,
        modelPromptDigest: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const runtime = makeRuntime({
        ws: {
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          getEnforcementState: vi.fn(() => eState),
        },
        auditDeps: { ...makeAuditDeps(sessDir, state), cachedFingerprint: fingerprint },
      });
      const args: Record<string, unknown> = {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: PROMPT,
      };
      await expect(
        toolBefore(runtime, { tool: 'task', sessionID: sessionId, callID: 'call-b' }, { args }),
      ).resolves.toBeUndefined();

      const persisted = await readState(sessDir);
      const attempts = persisted!.reviewAssurance!.attempts;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ attemptId: initialAttempt.attemptId, status: 'stale' });
      expect(attempts[1]).toMatchObject({
        status: 'created',
        ordinal: 2,
        origin: {
          kind: 'task_rearm',
          predecessorAttemptId: initialAttempt.attemptId,
          triggerReason: 'interrupted',
        },
      });
      const rearmedId = attempts[1]!.attemptId;
      expect(rearmedId).not.toBe(initialAttempt.attemptId);
      expect(attempts[1]!.childSessionId).toBeUndefined();
      expect(args.description).toBe('FlowGuard reviewer task');
      expect(args.prompt).toBe(PROMPT);
      // The durable dispatch ledger: the stale predecessor's dispatch is marked
      // unknown-outcome and the re-arm mints a fresh `authorized` entry.
      const dispatches = persisted!.reviewAssurance!.dispatches;
      expect(dispatches).toHaveLength(2);
      const oldDispatch = dispatches!.find((d) => d.hostCallId === 'call-a');
      const newDispatch = dispatches!.find((d) => d.hostCallId === 'call-b');
      expect(oldDispatch).toMatchObject({
        attemptId: initialAttempt.attemptId,
        dispatchStatus: 'outcome_unknown',
      });
      expect(newDispatch).toMatchObject({
        attemptId: rearmedId,
        dispatchStatus: 'authorized',
      });
      expect(newDispatch!.dispatchId).not.toBe(oldDispatch!.dispatchId);
      expect(eState.executedTaskPrompts.has('call-a')).toBe(false);
      expect(eState.executedTaskPrompts.get('call-b')).toMatchObject({ attemptId: rearmedId });
      expect(eState.pendingReviews.get('flowguard_plan')!.attemptId).toBe(rearmedId);
    } finally {
      await ws.cleanup();
    }
  });

  it('BAD — a phantom record naming a missing attempt fails closed without mutation', async () => {
    const ws = await createTestWorkspace();
    try {
      const fingerprint = (await computeFingerprint(ws.tmpDir)).fingerprint;
      const sessionId = crypto.randomUUID();
      const sessDir = resolveSessionDir(fingerprint, sessionId);
      const { obligation, initialAttempt } = planReviewFixture();
      const state = makeState('PLAN', {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [obligation],
          invocations: [],
          attempts: [initialAttempt],
          dispatches: [],
        },
      });
      await seedSession(sessDir, state);

      const ghostAttemptId = crypto.randomUUID();
      const eState = createSessionState();
      eState.pendingReviews.set(
        'flowguard_plan',
        pendingReviewFor(obligation.obligationId, ghostAttemptId),
      );
      eState.executedTaskPrompts.set('call-a', {
        callId: 'call-a',
        obligationId: obligation.obligationId,
        attemptId: ghostAttemptId,
        canonicalPrompt: PROMPT,
        canonicalPromptDigest: PROMPT_DIGEST,
        modelPromptDigest: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const runtime = makeRuntime({
        ws: {
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          getEnforcementState: vi.fn(() => eState),
        },
        auditDeps: { ...makeAuditDeps(sessDir, state), cachedFingerprint: fingerprint },
      });
      await expect(
        toolBefore(
          runtime,
          { tool: 'task', sessionID: sessionId, callID: 'call-b' },
          {
            args: { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: PROMPT },
          },
        ),
      ).rejects.toThrow('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE');
      const persisted = await readState(sessDir);
      expect(persisted!.reviewAssurance!.attempts).toHaveLength(1);
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
            subjectDigest: 'obs-subject-digest',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            maxReviewerOutputRepairAttempts: 1,
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
            repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
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
            reviewMaterial: {
              content: '## Plan\n',
              materialDigest: 'material-digest',
              subjectDigest: 'obs-subject-digest',
            },
            ordinal: 0,
            status: 'created',
            origin: { kind: 'initial' } as const,
            repositoryDiscovery: { kind: 'not_applicable' } as const,
            observationCapability: CAPABILITY,
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
