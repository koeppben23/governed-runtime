/**
 * @module integration/plugin-afterhooks-more.test
 * @description Direct tests for the after-hook dispatch: reviewable-tool
 *              diagnostics, task provenance blocking, audit-block output
 *              mutation, plugin events, and compaction.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  toolAfter,
  handlePluginEvent,
  handleCompaction,
  updateCheckReworkContinuation,
} from './plugin-afterhooks.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import type { AuditDeps } from './plugin-audit.js';
import type { PluginWorkspace } from './plugin-workspace.js';
import { createSessionState } from './review/enforcement/enforcement.js';
import { makeState, FROZEN_IMPLEMENTATION_BASE } from '../fixtures.js';
import { writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { createTestWorkspace } from './test-helpers.js';
import { formatBlocked, formatAutoAdvanceOverflow } from './tools/helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';
import { NATIVE_ATTESTATION_REJECTION_FIELD } from '../shared/flowguard-identifiers.js';

const SESSION_ID = crypto.randomUUID();

function makeRuntime(
  overrides: Omit<Partial<FlowGuardPluginRuntime>, 'ws'> & { ws?: Partial<PluginWorkspace> } = {},
): FlowGuardPluginRuntime {
  const base = {
    ws: {
      getSessionDir: vi.fn().mockReturnValue(null),
      getEnforcementState: vi.fn(() => createSessionState()),
      invalidateChainState: vi.fn(),
      runSerializedForSession: vi.fn(async (_sid: string, fn: () => Promise<void>) => fn()),
      updateReviewAssurance: vi.fn(),
      ...(overrides.ws ?? {}),
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    adapterLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    riskDeps: { getSessionDir: vi.fn(), getWorktreeRoot: vi.fn() },
    discoveryHealthDeps: { getSessionDir: vi.fn(), getWorkspaceDir: vi.fn() },
    orchestratorDeps: {} as FlowGuardPluginRuntime['orchestratorDeps'],
    auditDeps: makeAuditDeps(),
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

function makeAuditDeps(overrides: Partial<AuditDeps> = {}): AuditDeps {
  return {
    resolveFingerprint: vi.fn(async () => 'fp-abc'),
    getSessionDir: vi.fn(() => null),
    resolveSessionPolicy: vi.fn(async () => {
      throw new Error('no audit policy');
    }),
    initChain: vi.fn(async () => 'prev-hash'),
    invalidateChainState: vi.fn(),
    appendAndTrack: vi.fn(async () => {}),
    nextDecisionSequence: vi.fn(async () => 1),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    logError: vi.fn(),
    cachedFingerprint: 'fp-abc',
    mode: 'solo',
    ...overrides,
  };
}

function hookOutput(output: string): {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
} {
  return { title: 't', output, metadata: {} };
}

describe('toolAfter — reviewable diagnostics', () => {
  it('warns on a native enforcement-unavailable denial', async () => {
    const runtime = makeRuntime();
    await toolAfter(
      runtime,
      { tool: 'flowguard_plan', sessionID: SESSION_ID },
      hookOutput(
        formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
          obligationType: 'plan',
          iteration: '0',
          planVersion: '1',
          deniedReviewPath: 'native',
        }),
      ),
    );
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'review',
      'native review acceptance denied: plugin enforcement unavailable',
      expect.any(Object),
    );
  });

  it('warns on a host-task findings rejection', async () => {
    const runtime = makeRuntime();
    const output = JSON.stringify({
      error: true,
      code: 'SUBAGENT_EVIDENCE_REUSED',
      hostTaskFindingsRejection: {
        path: 'host_task',
        reason: 'SUBAGENT_EVIDENCE_REUSED',
        status: 'consumed',
        obligationId: '11111111-1111-4111-8111-111111111111',
      },
    });
    await toolAfter(
      runtime,
      { tool: 'flowguard_implement', sessionID: SESSION_ID },
      hookOutput(output),
    );
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'review',
      'host-task findings rejected by shared guard',
      expect.objectContaining({ obligationId: '11111111-1111-4111-8111-111111111111' }),
    );
  });

  it('warns on an identity rejection for flowguard_plan', async () => {
    const runtime = makeRuntime();
    const output = JSON.stringify({
      error: true,
      code: 'FOUR_EYES_ACTOR_MATCH',
      reviewIdentityRejection: { reason: 'reviewer_is_author' },
    });
    await toolAfter(runtime, { tool: 'flowguard_plan', sessionID: SESSION_ID }, hookOutput(output));
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'review',
      'self-review rejected',
      expect.objectContaining({ reason: 'reviewer_is_author' }),
    );
  });

  it('warns on a native attestation rejection for flowguard_review', async () => {
    const runtime = makeRuntime();
    const output = JSON.stringify({
      phase: 'REVIEW_COMPLETE',
      [NATIVE_ATTESTATION_REJECTION_FIELD]: { reason: 'capture_session_mismatch' },
    });
    await toolAfter(
      runtime,
      { tool: 'flowguard_review', sessionID: SESSION_ID },
      hookOutput(output),
    );
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'review',
      'native attestation not upgraded',
      expect.objectContaining({ reason: 'capture_session_mismatch' }),
    );
  });

  it('errors on an auto-advance overflow result', async () => {
    const runtime = makeRuntime();
    const overflow = {
      kind: 'overflow' as const,
      phase: 'PLAN_REVIEW' as const,
      limit: 10,
      transitions: [],
    };
    await toolAfter(
      runtime,
      { tool: 'flowguard_plan', sessionID: SESSION_ID },
      hookOutput(formatAutoAdvanceOverflow(overflow)),
    );
    expect(runtime.log.error).toHaveBeenCalledWith(
      'autoAdvance',
      'auto-advance overflow: topology may be non-terminating',
      expect.objectContaining({ phase: 'PLAN_REVIEW', limit: 10 }),
    );
  });

  it('warns on an identity rejection for flowguard_continue', async () => {
    const runtime = makeRuntime();
    const output = JSON.stringify({
      error: true,
      code: 'FOUR_EYES_ACTOR_MATCH',
      reviewIdentityRejection: { reason: 'reviewer_identity_uncomparable', obligationId: 'ob-1' },
    });
    await toolAfter(
      runtime,
      { tool: 'flowguard_continue', sessionID: SESSION_ID },
      hookOutput(output),
    );
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'review',
      'self-review rejected',
      expect.objectContaining({ obligationId: 'ob-1' }),
    );
  });

  it('errors on a contended hydrate lock signal', async () => {
    const runtime = makeRuntime();
    const output = JSON.stringify({
      error: true,
      code: 'SESSION_LOCK_CONTENDED',
      message: 'lock timeout',
    });
    await toolAfter(
      runtime,
      { tool: 'flowguard_hydrate', sessionID: SESSION_ID },
      hookOutput(output),
    );
    expect(runtime.log.error).toHaveBeenCalledWith(
      'hydrate',
      'session write lock contended: hydrate blocked',
      expect.any(Object),
    );
  });

  it('warns on a waited hydrate lock signal', async () => {
    const runtime = makeRuntime();
    const output = JSON.stringify({ ok: true, ticket: { text: 'x' }, lockContended: true });
    await toolAfter(
      runtime,
      { tool: 'flowguard_hydrate', sessionID: SESSION_ID },
      hookOutput(output),
    );
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'hydrate',
      'session write lock contended: waited for concurrent holder',
      expect.any(Object),
    );
  });

  it('skips diagnostics for non-flowguard tools', async () => {
    const runtime = makeRuntime();
    await toolAfter(runtime, { tool: 'read', sessionID: SESSION_ID }, hookOutput('{}'));
    expect(runtime.log.warn).not.toHaveBeenCalled();
  });
});

describe('toolAfter — reviewer task provenance', () => {
  it('rewrites the output when no host-owned execution record exists', async () => {
    const runtime = makeRuntime();
    const output = { title: 'task', output: '{}', metadata: {} };
    await toolAfter(
      runtime,
      {
        tool: 'task',
        sessionID: SESSION_ID,
        callID: 'c1',
        args: { subagent_type: REVIEWER_SUBAGENT_TYPE },
      },
      output,
    );
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(parsed.code).toBe('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE');
    expect(runtime.log.warn).toHaveBeenCalledWith(
      'host-task',
      'reviewer capture rejected without execution provenance',
      expect.any(Object),
    );
  });

  it('ignores generic tasks without reviewer args', async () => {
    const runtime = makeRuntime();
    const output = { title: 'task', output: '{}', metadata: {} };
    await toolAfter(
      runtime,
      { tool: 'task', sessionID: SESSION_ID, callID: 'c1', args: {} },
      output,
    );
    expect(output.output).toBe('{}');
  });
});

describe('toolAfter — audit block output mutation', () => {
  it('mutates the output on an audit block for flowguard tools', async () => {
    const runtime = makeRuntime({
      auditDeps: makeAuditDeps({
        getSessionDir: vi.fn(() => '/tmp/fake-sess'),
        resolveSessionPolicy: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    });
    const output = { title: 'flowguard_plan', output: '{"phase":"PLAN"}', metadata: {} };
    await toolAfter(
      runtime,
      { tool: 'flowguard_plan', sessionID: SESSION_ID, callID: 'c1', args: {} },
      output,
    );
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('AUDIT_PERSISTENCE_FAILED');
  });

  it('does not touch non-flowguard tool outputs', async () => {
    const runtime = makeRuntime({
      auditDeps: makeAuditDeps({
        resolveSessionPolicy: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    });
    const output = { title: 'bash', output: 'ok', metadata: {} };
    await toolAfter(
      runtime,
      { tool: 'bash', sessionID: SESSION_ID, callID: 'c1', args: {} },
      output,
    );
    expect(output.output).toBe('ok');
  });
});

describe('handlePluginEvent', () => {
  it('ignores unknown event types', async () => {
    const runtime = makeRuntime();
    await handlePluginEvent(runtime, { type: 'unrelated.event' });
    expect(runtime.ws.invalidateChainState).not.toHaveBeenCalled();
  });

  it('cleans the chain state on session.delete', async () => {
    const runtime = makeRuntime();
    await handlePluginEvent(runtime, {
      type: 'session.delete',
      properties: { sessionID: SESSION_ID },
    });
    expect(runtime.ws.invalidateChainState).toHaveBeenCalledWith(SESSION_ID);
  });

  it('emits a session error audit when the session mapping exists', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-error-event');
      await fs.mkdir(sessDir, { recursive: true });
      await writeState(
        sessDir,
        makeState('IMPLEMENTATION', {
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        }),
      );
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      await handlePluginEvent(runtime, {
        type: 'session.error',
        properties: { sessionID: SESSION_ID, errorMessage: 'host stalled' },
      });
      const entries = await fs.readdir(sessDir);
      expect(entries).toContain('audit.jsonl');
      const { events } = await readAuditTrail(sessDir);
      expect(events[0]).toMatchObject({
        phase: 'IMPLEMENTATION',
        detail: { code: 'SESSION_ERROR' },
      });
    } finally {
      await ws.cleanup();
    }
  });

  it('skips the session error audit when no mapping exists', async () => {
    const runtime = makeRuntime();
    await handlePluginEvent(runtime, {
      type: 'session.error',
      properties: { sessionID: SESSION_ID, errorMessage: 'host stalled' },
    });
    expect(runtime.log.warn).not.toHaveBeenCalled();
  });
});

describe('handleCompaction', () => {
  it('returns early for an empty sessionID', async () => {
    const runtime = makeRuntime();
    const output = { context: [] };
    await handleCompaction(runtime, {}, output);
    expect(output.context).toHaveLength(0);
  });

  it('appends the compaction context for a known session', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-compact');
      await fs.mkdir(sessDir, { recursive: true });
      await writeState(sessDir, makeState('PLAN'));
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      const output = { context: [] as string[] };
      await handleCompaction(runtime, { sessionID: SESSION_ID }, output);
      expect(output.context.length).toBeGreaterThan(0);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('afterhook — /check rework-continuation latch', () => {
  function activeReworkState() {
    return makeState('IMPLEMENTATION', {
      implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
      implementationRework: { rejectedDigest: 'digest-d1', exhausted: false },
    });
  }

  it('flips the latch when a /check session commits an active rework marker', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await writeState(sessDir, activeReworkState());
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await updateCheckReworkContinuation(runtime, 'flowguard_review_implementation', SESSION_ID);
      expect(runtime.checkReworkContinuations.has(SESSION_ID)).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it('does not flip the latch without a /check scope', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await writeState(sessDir, activeReworkState());
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      await updateCheckReworkContinuation(runtime, 'flowguard_review_implementation', SESSION_ID);
      expect(runtime.checkReworkContinuations.has(SESSION_ID)).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it('keeps the latch through the loop phases and drops it at a terminal phase', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessDir = path.join(ws.tmpDir, 'sess-impl');
      await writeState(sessDir, activeReworkState());
      const runtime = makeRuntime({ ws: { getSessionDir: vi.fn().mockReturnValue(sessDir) } });
      runtime.activeCommandScopes.set(SESSION_ID, 'check');
      await updateCheckReworkContinuation(runtime, 'flowguard_review_implementation', SESSION_ID);
      expect(runtime.checkReworkContinuations.has(SESSION_ID)).toBe(true);
      // Re-record: marker cleared, phase IMPL_VALIDATION — latch must survive.
      await writeState(
        sessDir,
        makeState('IMPL_VALIDATION', {
          implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
          implementationRework: null,
        }),
      );
      await updateCheckReworkContinuation(runtime, 'flowguard_implement', SESSION_ID);
      expect(runtime.checkReworkContinuations.has(SESSION_ID)).toBe(true);
      // Acceptance: loop reaches a terminal phase → latch dropped.
      await writeState(sessDir, makeState('EVIDENCE_REVIEW'));
      await updateCheckReworkContinuation(runtime, 'flowguard_review_implementation', SESSION_ID);
      expect(runtime.checkReworkContinuations.has(SESSION_ID)).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });
});
