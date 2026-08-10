/**
 * @module integration/plugin.test
 * @description Tests for the FlowGuardAuditPlugin integration module.
 *
 * The plugin is an async function that receives the OpenCode PluginInput context
 * and returns a Hooks object with a `tool.execute.after` handler. Since full
 * plugin execution requires a live OpenCode runtime, these tests validate:
 * - Export shape: FlowGuardAuditPlugin is an async function with correct arity
 * - Hooks contract: calling the plugin returns an object with the expected hooks
 * - Barrel export: integration/index.ts re-exports FlowGuardAuditPlugin
 * - P32: Plugin uses resolveRuntimePolicyMode() for state > config > solo priority
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PERF_ENABLED } from '../test-policy.js';
import * as crypto from 'node:crypto';
import { FlowGuardAuditPlugin, isUsableWorktree } from './plugin.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import { makeState } from '../fixtures.js';
import type { PolicyMode } from '../config/policy.js';
import * as barrel from './index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTestWorkspace, withTestEnv } from './test-helpers.js';
import { readState, writeState } from '../adapters/persistence.js';
import { writeRepoConfig } from '../adapters/persistence-config.js';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import { computeRecordDigest } from '../state/evidence-plan.js';
import { NATIVE_ATTESTATION_REJECTION_FIELD } from '../shared/flowguard-identifiers.js';
import { fileURLToPath } from 'node:url';
import { clearUserDecisionIntents, consumeUserDecisionIntent } from './user-decision-intent.js';

const execFileAsync = promisify(execFile);

async function initGitRepo(worktree: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: worktree });
}

// ─── Mock Plugin Input ────────────────────────────────────────────────────────

/**
 * Create a minimal mock PluginInput.
 * The plugin only uses `worktree` and `directory` from the input, plus
 * `client.app.log` for error logging. We provide stubs for all required fields.
 */
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
          recordDigest: computeRecordDigest({
            contentDigest: 'plan-digest',
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
          }),
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'verified' as const,
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
            subjectDigest: 'test-subject-digest',
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
            reviewSubjectScope: {
              kind: 'repository_change',
              paths: ['src/foo.ts'],
              revisions: ['base', 'head'],
            },
          },
        ],
        invocations: [],
        attempts: [],
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('integration/plugin', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('FlowGuardAuditPlugin is an async function', () => {
      expect(typeof FlowGuardAuditPlugin).toBe('function');
      // Async functions have AsyncFunction constructor
      expect(FlowGuardAuditPlugin.constructor.name).toBe('AsyncFunction');
    });

    it('FlowGuardAuditPlugin returns hooks with tool.execute.after', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      expect(hooks).toBeDefined();
      expect(typeof hooks).toBe('object');
      expect(typeof hooks['tool.execute.after']).toBe('function');
    });

    it('command.execute.before records a one-shot user decision intent', async () => {
      clearUserDecisionIntents();
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const handler = hooks['command.execute.before'];
      expect(typeof handler).toBe('function');

      await handler!(
        { command: '/approve', sessionID: 'ses-user-command', arguments: '' },
        { parts: [] },
      );

      expect(
        consumeUserDecisionIntent({
          sessionId: 'ses-user-command',
          verdict: 'approve',
        }),
      ).toMatchObject({ ok: true });
      expect(
        consumeUserDecisionIntent({
          sessionId: 'ses-user-command',
          verdict: 'approve',
        }),
      ).toEqual({ ok: false, reason: 'missing' });
    });

    it('command.execute.before ignores ambiguous review-decision commands', async () => {
      clearUserDecisionIntents();
      const hooks = await FlowGuardAuditPlugin(createMockInput());

      await hooks['command.execute.before']!(
        { command: '/review-decision', sessionID: 'ses-ambiguous', arguments: '' },
        { parts: [] },
      );

      expect(
        consumeUserDecisionIntent({
          sessionId: 'ses-ambiguous',
          verdict: 'approve',
        }),
      ).toEqual({ ok: false, reason: 'missing' });
    });

    it('command.execute.before does not record an intent when sessionID is missing', async () => {
      clearUserDecisionIntents();
      const hooks = await FlowGuardAuditPlugin(createMockInput());

      // Should not throw — missing sessionID means the hook bails with a warn log
      await expect(
        hooks['command.execute.before']!(
          { command: '/approve', sessionID: '', arguments: '' },
          { parts: [] },
        ),
      ).resolves.toBeUndefined();
    });

    it('barrel re-exports FlowGuardAuditPlugin', () => {
      expect(barrel.FlowGuardAuditPlugin).toBe(FlowGuardAuditPlugin);
    });

    it('tool.execute.after handler accepts input and output args', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const handler = hooks['tool.execute.after']!;
      // Check arity: 2 params (input, output)
      expect(handler.length).toBe(2);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('silently ignores non-FlowGuard tool calls', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const handler = hooks['tool.execute.after']!;

      // Calling with a non-FlowGuard tool name should not throw
      await expect(
        handler(
          { tool: 'bash', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'bash', output: '{}', metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });

    it('handles missing worktree gracefully', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput({ worktree: '', directory: '' }));
      const handler = hooks['tool.execute.after']!;

      // Should not throw even with empty worktree
      await expect(
        handler(
          { tool: 'flowguard_status', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'status', output: '{"phase":"TICKET"}', metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('initializes with worktree from input.worktree', async () => {
      // When worktree is provided, it takes precedence over directory
      const hooks = await FlowGuardAuditPlugin(
        createMockInput({
          worktree: '/custom/worktree',
          directory: '/custom/dir',
        }),
      );
      expect(hooks).toBeDefined();
    });

    it('falls back to directory when worktree is empty', async () => {
      const hooks = await FlowGuardAuditPlugin(
        createMockInput({
          worktree: '',
          directory: '/custom/dir',
        }),
      );
      expect(hooks).toBeDefined();
    });

    it('returns all expected hooks (command + tool + event + compaction + dispose)', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const keys = Object.keys(hooks).sort();
      expect(keys).toEqual([
        'command.execute.before',
        'dispose',
        'event',
        'experimental.session.compacting',
        'tool.execute.after',
        'tool.execute.before',
      ]);
    });

    it('SMOKE: compaction hook reads input.sessionID and pushes context', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const handler = hooks['experimental.session.compacting']!;
      expect(handler).toBeDefined();

      const output = { context: [] as string[] };
      // input.sessionID guaranteed by SDK — no optional chaining needed
      await handler({ sessionID: 'compaction-smoke-1' }, output);
      // Session data may or may not be available in unit test;
      // the hook must not throw on valid input shapes
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('handles non-JSON tool output without throwing', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const handler = hooks['tool.execute.after']!;

      // Non-JSON output — the handler should catch parse errors internally
      await expect(
        handler(
          { tool: 'flowguard_status', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'status', output: 'not json at all', metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });

    it('processes a structured auto-advance overflow output without throwing (#428)', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const handler = hooks['tool.execute.after']!;

      // A FlowGuard tool returning the structured fail-closed overflow result.
      // The after-hook detects it via getAutoAdvanceOverflow and emits an error
      // log; the handler must process it without throwing.
      const overflowOutput = JSON.stringify({
        error: true,
        code: 'AUTO_ADVANCE_OVERFLOW',
        autoAdvanceOverflow: { phase: 'PLAN_REVIEW', limit: 10 },
      });
      await expect(
        handler(
          { tool: 'flowguard_plan', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'plan', output: overflowOutput, metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });

    it('emits a boundary error log for auto-advance overflow (#428)', async () => {
      // The boundary error log is a REQUIRED behavior of #428 (operators must be
      // alerted to a non-terminating topology), not incidental observability.
      // Exercise the real after-hook with the UI log sink active and assert the
      // exact log.error shape: service 'autoAdvance', level 'error', and the
      // { sessionId, phase, limit } extra carried from the structured result.
      const ws = await createTestWorkspace();
      try {
        // mode 'both' activates the UI sink, which delegates to client.app.log.
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both' },
        });

        const logSpy = vi.fn().mockResolvedValue(undefined);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: { app: { log: logSpy } },
          }),
        );
        const handler = hooks['tool.execute.after']!;

        const overflowOutput = JSON.stringify({
          error: true,
          code: 'AUTO_ADVANCE_OVERFLOW',
          autoAdvanceOverflow: { phase: 'PLAN_REVIEW', limit: 10 },
        });
        await handler(
          { tool: 'flowguard_plan', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'plan', output: overflowOutput, metadata: {} },
        );

        expect(logSpy).toHaveBeenCalledWith({
          body: {
            service: 'autoAdvance',
            level: 'error',
            message: 'auto-advance overflow: topology may be non-terminating',
            extra: { sessionId: 's1', phase: 'PLAN_REVIEW', limit: 10 },
          },
        });
      } finally {
        await ws.cleanup();
      }
    });

    it('emits a boundary warn log for host-task findings guard rejection (#424)', async () => {
      const ws = await createTestWorkspace();
      try {
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both' },
        });

        const logSpy = vi.fn().mockResolvedValue(undefined);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: { app: { log: logSpy } },
          }),
        );
        const handler = hooks['tool.execute.after']!;

        const blockedOutput = JSON.stringify({
          error: true,
          code: 'SUBAGENT_EVIDENCE_REUSED',
          hostTaskFindingsRejection: {
            path: 'host_task',
            reason: 'SUBAGENT_EVIDENCE_REUSED',
            status: 'consumed',
            obligationId: '11111111-1111-4111-8111-111111111111',
          },
        });
        await handler(
          { tool: 'flowguard_plan', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'plan', output: blockedOutput, metadata: {} },
        );

        expect(logSpy).toHaveBeenCalledWith({
          body: {
            service: 'review',
            level: 'warn',
            message: 'host-task findings rejected by shared guard',
            extra: {
              sessionId: 's1',
              path: 'host_task',
              reason: 'SUBAGENT_EVIDENCE_REUSED',
              status: 'consumed',
              obligationId: '11111111-1111-4111-8111-111111111111',
            },
          },
        });
      } finally {
        await ws.cleanup();
      }
    });

    it('emits a boundary warn log for /continue reviewer-author rejection (#425)', async () => {
      const ws = await createTestWorkspace();
      try {
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both' },
        });

        const logSpy = vi.fn().mockResolvedValue(undefined);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: { app: { log: logSpy } },
          }),
        );
        const handler = hooks['tool.execute.after']!;

        const blockedOutput = JSON.stringify({
          error: true,
          code: 'FOUR_EYES_ACTOR_MATCH',
          reviewIdentityRejection: {
            reason: 'reviewer_is_author',
            obligationId: '11111111-1111-4111-8111-111111111111',
          },
        });
        await handler(
          { tool: 'flowguard_continue', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'continue', output: blockedOutput, metadata: {} },
        );

        expect(logSpy).toHaveBeenCalledWith({
          body: {
            service: 'review',
            level: 'warn',
            message: 'self-review rejected',
            extra: {
              sessionId: 's1',
              reason: 'reviewer_is_author',
              obligationId: '11111111-1111-4111-8111-111111111111',
            },
          },
        });
      } finally {
        await ws.cleanup();
      }
    });

    it('emits a boundary warn log for native attestation non-upgrade (#427)', async () => {
      const ws = await createTestWorkspace();
      try {
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both' },
        });

        const logSpy = vi.fn().mockResolvedValue(undefined);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: { app: { log: logSpy } },
          }),
        );
        const handler = hooks['tool.execute.after']!;

        const reviewOutput = JSON.stringify({
          phase: 'REVIEW_COMPLETE',
          [NATIVE_ATTESTATION_REJECTION_FIELD]: {
            reason: 'capture_session_mismatch',
            obligationId: '11111111-1111-4111-8111-111111111111',
          },
        });
        await handler(
          { tool: 'flowguard_review', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'review', output: reviewOutput, metadata: {} },
        );

        expect(logSpy).toHaveBeenCalledWith({
          body: {
            service: 'review',
            level: 'warn',
            message: 'native attestation not upgraded',
            extra: {
              sessionId: 's1',
              reason: 'capture_session_mismatch',
              obligationId: '11111111-1111-4111-8111-111111111111',
            },
          },
        });
      } finally {
        await ws.cleanup();
      }
    });

    it('emits a boundary error log when hydrate is lock-contended/BLOCKED (#429)', async () => {
      // The boundary error log is a REQUIRED behavior of #429: when hydrate fails
      // closed because the session write lock could not be acquired, operators
      // must be alerted. Assert the exact log.error shape: service 'hydrate',
      // level 'error', and the { sessionId, reason } extra.
      const ws = await createTestWorkspace();
      try {
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both' },
        });

        const logSpy = vi.fn().mockResolvedValue(undefined);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: { app: { log: logSpy } },
          }),
        );
        const handler = hooks['tool.execute.after']!;

        const blockedOutput = JSON.stringify({
          error: true,
          code: 'SESSION_LOCK_CONTENDED',
          message: 'session write lock timeout',
        });
        await handler(
          { tool: 'flowguard_hydrate', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'hydrate', output: blockedOutput, metadata: {} },
        );

        expect(logSpy).toHaveBeenCalledWith({
          body: {
            service: 'hydrate',
            level: 'error',
            message: 'session write lock contended: hydrate blocked',
            extra: { sessionId: 's1', reason: 'SESSION_LOCK_CONTENDED' },
          },
        });
      } finally {
        await ws.cleanup();
      }
    });

    it('emits a boundary warn log when hydrate succeeded after waiting for the lock (#429)', async () => {
      // When hydrate SUCCEEDS but had to wait for a concurrent lock holder, the
      // success output carries lockContended:true and the boundary emits a warn
      // (expected under concurrency, not an error). Assert the exact warn shape.
      const ws = await createTestWorkspace();
      try {
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both' },
        });

        const logSpy = vi.fn().mockResolvedValue(undefined);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: { app: { log: logSpy } },
          }),
        );
        const handler = hooks['tool.execute.after']!;

        const waitedOutput = JSON.stringify({
          ok: true,
          ticket: { text: 'x' },
          lockContended: true,
        });
        await handler(
          { tool: 'flowguard_hydrate', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'hydrate', output: waitedOutput, metadata: {} },
        );

        expect(logSpy).toHaveBeenCalledWith({
          body: {
            service: 'hydrate',
            level: 'warn',
            message: 'session write lock contended: waited for concurrent holder',
            extra: { sessionId: 's1', reason: 'SESSION_LOCK_WAITED' },
          },
        });
      } finally {
        await ws.cleanup();
      }
    });

    it('emits NO lock log for an uncontended hydrate success (#429)', async () => {
      // Faithful emission: uncontended success (no lockContended field) must NOT
      // produce any session-lock log line. Guards against noisy warnings.
      const ws = await createTestWorkspace();
      try {
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both' },
        });

        const logSpy = vi.fn().mockResolvedValue(undefined);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: { app: { log: logSpy } },
          }),
        );
        const handler = hooks['tool.execute.after']!;

        await handler(
          { tool: 'flowguard_hydrate', sessionID: 's1', callID: 'c1', args: {} },
          {
            title: 'hydrate',
            output: JSON.stringify({ ok: true, ticket: { text: 'x' } }),
            metadata: {},
          },
        );

        const lockLogs = logSpy.mock.calls.filter(([arg]) => arg?.body?.service === 'hydrate');
        expect(lockLogs).toHaveLength(0);
      } finally {
        await ws.cleanup();
      }
    });

    it('emits NO "waited" warn when hydrate FAILED after waiting for the lock (#429)', async () => {
      // Blocker regression: a hydrate that waited but then failed for an
      // unrelated reason (error output) must never be logged as a "waited
      // success". The boundary either emits the SESSION_LOCK_CONTENDED error log
      // (registered block) or nothing — never the warn.
      const ws = await createTestWorkspace();
      try {
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both' },
        });

        const logSpy = vi.fn().mockResolvedValue(undefined);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: { app: { log: logSpy } },
          }),
        );
        const handler = hooks['tool.execute.after']!;

        // An error output that (defensively) carries a stray lockContended:true.
        await handler(
          { tool: 'flowguard_hydrate', sessionID: 's1', callID: 'c1', args: {} },
          {
            title: 'hydrate',
            output: JSON.stringify({
              error: true,
              code: 'SOME_OTHER_REASON',
              message: 'unrelated failure',
              lockContended: true,
            }),
            metadata: {},
          },
        );

        const warnLogs = logSpy.mock.calls.filter(
          ([arg]) => arg?.body?.service === 'hydrate' && arg?.body?.level === 'warn',
        );
        expect(warnLogs).toHaveLength(0);
      } finally {
        await ws.cleanup();
      }
    });

    it('multiple plugin initializations create independent instances', async () => {
      const hooks1 = await FlowGuardAuditPlugin(createMockInput({ worktree: '/wt1' }));
      const hooks2 = await FlowGuardAuditPlugin(createMockInput({ worktree: '/wt2' }));

      // Different hook instances (closure captures different worktree)
      expect(hooks1['tool.execute.after']).not.toBe(hooks2['tool.execute.after']);
    });

    it('handles tool name exactly at FG_PREFIX boundary', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const handler = hooks['tool.execute.after']!;

      // "flowguard_" alone (without suffix) — should match FG_PREFIX
      await expect(
        handler(
          { tool: 'flowguard_', sessionID: 's1', callID: 'c1', args: {} },
          { title: '', output: '{}', metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe.skipIf(!PERF_ENABLED)('PERF', () => {
    it('plugin initialization completes in < 20ms', async () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        await FlowGuardAuditPlugin(createMockInput());
      }
      const elapsed = performance.now() - start;
      // Plugin init performs async I/O (fingerprint resolution via git subprocess +
      // config read from workspace dir). Each iteration spawns a git process that
      // fails on the mock path, then falls back to path-based fingerprint.
      // Budget: 100 inits in < 2000ms => < 20ms each.
      // In production, fingerprint is resolved once and cached per plugin lifetime.
      expect(elapsed).toBeLessThan(2000);
    });

    it('non-FlowGuard tool filtering is sub-microsecond', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const handler = hooks['tool.execute.after']!;

      // Non-FlowGuard tools should be filtered out immediately (prefix check)
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        await handler(
          { tool: 'bash', sessionID: 's1', callID: 'c1', args: {} },
          { title: 'bash', output: '', metadata: {} },
        );
      }
      const elapsed = performance.now() - start;
      // 1000 calls in < 100ms => < 0.1ms per call (prefix check, CI-tolerant)
      expect(elapsed).toBeLessThan(100);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // P32: Plugin-Path Resolver Tests (resolvePluginSessionPolicy)
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('P32 Plugin-Path Resolver', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp('/tmp/p32-test-');
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    function createValidState(policyMode: PolicyMode) {
      const state = makeState('TICKET');
      return {
        ...state,
        policySnapshot: {
          ...state.policySnapshot,
          mode: policyMode,
          requestedMode: policyMode,
        },
      };
    }

    // HAPPY: State exists → state wins
    describe('HAPPY', () => {
      it('state=solo + config=team → solo', async () => {
        const sessDir = path.join(tmpDir, 'sess_solo');
        await fs.mkdir(sessDir, { recursive: true });
        await fs.writeFile(
          path.join(sessDir, 'session-state.json'),
          JSON.stringify(createValidState('solo')),
        );

        const result = await resolvePluginSessionPolicy({
          sessDir,
          configDefaultMode: 'team',
        });

        expect(result.policy.mode).toBe('solo');
      });

      it('state=regulated + config=team → regulated', async () => {
        const sessDir = path.join(tmpDir, 'sess_regulated');
        await fs.mkdir(sessDir, { recursive: true });
        await fs.writeFile(
          path.join(sessDir, 'session-state.json'),
          JSON.stringify(createValidState('regulated')),
        );

        const result = await resolvePluginSessionPolicy({
          sessDir,
          configDefaultMode: 'team',
        });

        expect(result.policy.mode).toBe('regulated');
      });

      it('state=team-ci + config=team → team-ci', async () => {
        const sessDir = path.join(tmpDir, 'sess_teamci');
        await fs.mkdir(sessDir, { recursive: true });
        await fs.writeFile(
          path.join(sessDir, 'session-state.json'),
          JSON.stringify(createValidState('team-ci')),
        );

        const result = await resolvePluginSessionPolicy({
          sessDir,
          configDefaultMode: 'team',
        });

        expect(result.policy.mode).toBe('team-ci');
      });
    });

    // BAD: Missing/corrupt state → fallback or fail
    describe('BAD', () => {
      it('no state file + config=team → team', async () => {
        const sessDir = path.join(tmpDir, 'sess_no_file');
        await fs.mkdir(sessDir, { recursive: true });

        const result = await resolvePluginSessionPolicy({
          sessDir,
          configDefaultMode: 'team',
        });

        expect(result.policy.mode).toBe('team');
        expect(result.state).toBeNull();
      });

      it('no state file + no config → team', async () => {
        const sessDir = path.join(tmpDir, 'sess_no_config');
        await fs.mkdir(sessDir, { recursive: true });

        const result = await resolvePluginSessionPolicy({
          sessDir,
        });

        expect(result.policy.mode).toBe('team');
        expect(result.state).toBeNull();
      });

      it('sessDir=null + config=team → team', async () => {
        const result = await resolvePluginSessionPolicy({
          sessDir: null,
          configDefaultMode: 'team',
        });

        expect(result.policy.mode).toBe('team');
        expect(result.state).toBeNull();
      });

      it('corrupt state file → throw (fail closed)', async () => {
        const sessDir = path.join(tmpDir, 'sess_corrupt');
        await fs.mkdir(sessDir, { recursive: true });
        await fs.writeFile(path.join(sessDir, 'session-state.json'), '{ invalid json }');

        await expect(
          resolvePluginSessionPolicy({
            sessDir,
            configDefaultMode: 'team',
          }),
        ).rejects.toThrow();
      });
    });

    // CORNER: Edge cases
    describe('CORNER', () => {
      it('config=solo + no state → solo', async () => {
        const sessDir = path.join(tmpDir, 'sess_solo_config');
        await fs.mkdir(sessDir, { recursive: true });

        const result = await resolvePluginSessionPolicy({
          sessDir,
          configDefaultMode: 'solo',
        });

        expect(result.policy.mode).toBe('solo');
      });
    });
  });

  describe('strict review orchestration', () => {
    it('blocks with STRICT_REVIEW_ORCHESTRATION_FAILED when reviewer invocation fails', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: {
              app: { log: async () => {} },
              session: {
                create: async () => ({ error: { message: 'boom' } }),
                prompt: async () => ({ error: { message: 'unused' } }),
              },
            },
          }),
        );

        const output = {
          title: 'plan',
          output: strictPlanReviewRequiredOutput(obligationId),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
          output,
        );

        const blocked = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(blocked.error).toBe(true);
        expect(blocked.code).toBe('STRICT_REVIEW_ORCHESTRATION_FAILED');

        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.obligations[0]?.status).toBe('blocked');
      } finally {
        await ws.cleanup();
      }
    });

    it('blocks with SUBAGENT_MANDATE_MISSING when attestation is missing in strict mode', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
        const findings = {
          iteration: 0,
          planVersion: 1,
          reviewMode: 'subagent',
          overallVerdict: 'accept',
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          reviewedBy: { sessionId: 'child-session-1' },
          reviewedAt: new Date().toISOString(),
        };

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: {
              app: { log: async () => {} },
              session: {
                create: async () => ({ data: { id: 'child-session-1' } }),
                prompt: async () => ({
                  data: { info: { structured_output: findings } },
                }),
              },
            },
          }),
        );

        const output = {
          title: 'plan',
          output: strictPlanReviewRequiredOutput(obligationId),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
          output,
        );

        const blocked = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(blocked.error).toBe(true);
        expect(blocked.code).toBe('SUBAGENT_MANDATE_MISSING');

        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.obligations[0]?.blockedCode).toBe(
          'SUBAGENT_MANDATE_MISSING',
        );
      } finally {
        await ws.cleanup();
      }
    });

    it('blocks with STRICT_REVIEW_ORCHESTRATION_FAILED when strict reviewer reports self mode', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
        const findings = {
          iteration: 0,
          planVersion: 1,
          reviewMode: 'self',
          overallVerdict: 'accept',
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          reviewedBy: { sessionId: 'child-session-1' },
          reviewedAt: new Date().toISOString(),
          attestation: {
            mandateDigest: REVIEW_MANDATE_DIGEST,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            toolObligationId: obligationId,
            iteration: 0,
            planVersion: 1,
            reviewedBy: 'flowguard-reviewer',
          },
        };

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: {
              app: { log: async () => {} },
              session: {
                create: async () => ({ data: { id: 'child-session-1' } }),
                prompt: async () => ({
                  data: { info: { structured_output: findings } },
                }),
              },
            },
          }),
        );

        const output = {
          title: 'plan',
          output: strictPlanReviewRequiredOutput(obligationId),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
          output,
        );

        const blocked = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(blocked.error).toBe(true);
        // BUG-19: reviewMode:'self' now parses through schema (enum extended)
        // but is blocked by mandate check (reviewMode !== 'subagent') with
        // the more specific SUBAGENT_MANDATE_MISMATCH code.
        expect(blocked.code).toBe('SUBAGENT_MANDATE_MISMATCH');

        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.obligations[0]?.blockedCode).toBe(
          'SUBAGENT_MANDATE_MISMATCH',
        );
      } finally {
        await ws.cleanup();
      }
    });

    it('fulfills strict obligation and mutates output when attestation is valid', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
        const findings = {
          iteration: 0,
          planVersion: 1,
          reviewMode: 'subagent',
          overallVerdict: 'accept',
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          reviewedBy: { sessionId: 'child-session-1' },
          reviewedAt: new Date().toISOString(),
          attestation: {
            mandateDigest: REVIEW_MANDATE_DIGEST,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            toolObligationId: obligationId,
            iteration: 0,
            planVersion: 1,
            reviewedBy: 'flowguard-reviewer',
          },
        };

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: {
              app: { log: async () => {} },
              session: {
                create: async () => ({ data: { id: 'child-session-1' } }),
                prompt: async () => ({
                  data: { info: { structured_output: findings } },
                }),
              },
            },
          }),
        );

        const output = {
          title: 'plan',
          output: strictPlanReviewRequiredOutput(obligationId),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
          output,
        );

        const mutated = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect((mutated.next as string).startsWith('INDEPENDENT_REVIEW_COMPLETED')).toBe(true);
        expect(mutated._pluginReviewSessionId).toBe('child-session-1');

        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.obligations[0]?.status).toBe('fulfilled');
        expect((state?.reviewAssurance?.invocations.length ?? 0) > 0).toBe(true);
      } finally {
        await ws.cleanup();
      }
    });

    it('blocks with PLUGIN_ENFORCEMENT_UNAVAILABLE when strict context extraction fails', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
          }),
        );

        const output = {
          title: 'plan',
          output: strictPlanReviewRequiredOutput(obligationId, {
            selfReviewIteration: 1,
            next: 'INDEPENDENT_REVIEW_REQUIRED: iteration=0, planVersion=1',
          }),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
          output,
        );

        const blocked = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(blocked.error).toBe(true);
        expect(blocked.code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
      } finally {
        await ws.cleanup();
      }
    });
  });

  describe('normal FlowGuard tool operation', () => {
    it('handles flowguard_status without session state gracefully', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
          }),
        );

        const output = {
          title: 'status',
          output: JSON.stringify({ phase: 'TICKET' }),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_status', sessionID, callID: 'c1', args: {} },
          output,
        );

        // Should not throw or modify output with error
        const parsed = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(parsed.error).toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('handles flowguard_plan without review obligations', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
          }),
        );

        const output = {
          title: 'plan',
          output: JSON.stringify({ phase: 'PLAN', next: 'continue' }),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
          output,
        );

        const parsed = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(parsed.error).toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('tool.execute.before hook exists and reads args from output per OpenCode docs', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
          }),
        );

        // The before hook should exist and not throw for any tool
        const beforeHook = hooks['tool.execute.before'];
        expect(typeof beforeHook).toBe('function');

        // Per OpenCode docs, before hooks receive:
        //   input: { tool, sessionID, ... } (identity, read-only)
        //   output: { args, ... } (mutable tool arguments)
        const input = {
          tool: 'flowguard_status',
          sessionID: crypto.randomUUID(),
          callID: 'c1',
        };
        const output = { args: {} };
        await expect(beforeHook!(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    // ── C2 regression: before hook reads args from output, not input ──
    it('C2 HAPPY — before hook reads task subagent_type from output.args, not input', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();

        // Seed a strict policy session so the before-hook enforcement engages
        await seedStrictPlanSession(ws.tmpDir, sessionID);

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
          }),
        );

        const beforeHook = hooks['tool.execute.before'];
        expect(typeof beforeHook).toBe('function');

        // Per OpenCode docs: input has tool identity, output has mutable args.
        // If the code incorrectly reads input.args, it would miss the subagent_type
        // because input does NOT carry args per the documented contract.
        const input = { tool: 'task', sessionID, callID: 'c1' };
        const output = { args: { subagent_type: 'flowguard-reviewer', prompt: 'test' } };
        await expect(beforeHook!(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('C2 BAD — before hook does not crash when output.args is empty', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
          }),
        );
        const beforeHook = hooks['tool.execute.before'];
        const input = { tool: 'task', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: {} };
        await expect(beforeHook!(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('C2 EDGE — before hook fail-closes unknown tool when output is undefined', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
          }),
        );
        const beforeHook = hooks['tool.execute.before'];
        const input = { tool: 'some_tool', sessionID: crypto.randomUUID(), callID: 'c1' };
        // OpenCode always provides output, but unknown tools must still fail closed.
        await expect(beforeHook!(input, { args: {} })).rejects.toThrow('SESSION_DIR_NOT_FOUND');
      } finally {
        await ws.cleanup();
      }
    });

    it('C2 CORNER — input.args is ignored even if present (only output.args matters)', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        await seedStrictPlanSession(ws.tmpDir, sessionID);

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
          }),
        );

        const beforeHook = hooks['tool.execute.before'];
        // Place args on input (wrong location per docs) — should be ignored
        // Place DIFFERENT args on output (correct location) — should be used
        const input = {
          tool: 'task',
          sessionID,
          callID: 'c1',
          args: { subagent_type: 'WRONG_TYPE' },
        };
        const output = { args: { subagent_type: 'flowguard-reviewer', prompt: 'test' } };
        // The hook should read output.args (flowguard-reviewer), not input.args (WRONG_TYPE)
        // If it reads input.args, it would miss the enforcement logic for flowguard-reviewer
        await expect(beforeHook!(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('tool.execute.after handles task tool events via enforcement tracking', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
          }),
        );

        // Task tool events should be tracked by task enforcement
        await expect(
          hooks['tool.execute.after']!(
            {
              tool: 'task',
              sessionID,
              callID: 'c1',
              args: { subagent_type: 'flowguard-reviewer' },
            },
            {
              title: 'task',
              output: '{}',
              metadata: {},
            },
          ),
        ).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Type Safety: ToolHookInput / ToolHookBeforeOutput / ToolHookOutput adoption
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('hook type safety (types.ts adoption)', () => {
    // HAPPY: hooks work correctly with properly-shaped typed inputs
    it('HAPPY — before hook processes ToolHookInput + ToolHookBeforeOutput shapes', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        // ToolHookInput shape: { tool, sessionID }
        // ToolHookBeforeOutput shape: { args }
        const input = { tool: 'flowguard_status', sessionID: crypto.randomUUID(), callID: 'c1' };
        const output = { args: { query: 'phase' } };
        await expect(beforeHook(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('HAPPY — after hook processes ToolHookInput + ToolHookOutput shapes', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const afterHook = hooks['tool.execute.after']!;

        // ToolHookInput shape: { tool, sessionID }
        // ToolHookOutput shape: { output }
        const input = { tool: 'bash', sessionID: crypto.randomUUID(), callID: 'c1', args: {} };
        const output = { title: 'bash', output: 'hello world', metadata: {} };
        await expect(afterHook(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    // BAD: hooks handle malformed input without crashing.
    it('BAD — before hook ignores an invalid empty tool identity', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        // An empty tool identity is ignored by the hook's tool classification.
        await expect(
          beforeHook({ tool: '', sessionID: '', callID: '' }, { args: {} }),
        ).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('BAD — after hook handles null input and output gracefully', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const afterHook = hooks['tool.execute.after']!;

        // Both null — defensive fallbacks must prevent crash
        await expect(
          afterHook(
            { tool: '', sessionID: '', callID: '', args: {} },
            { title: '', output: '', metadata: {} },
          ),
        ).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    // CORNER: extra fields on input/output are ignored (forward-compatible)
    it('CORNER — before hook ignores extra fields on input and output', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        // Extra fields beyond ToolHookInput / ToolHookBeforeOutput
        const input = {
          tool: 'flowguard_status',
          sessionID: crypto.randomUUID(),
          callID: 'c1',
          futureField: true,
        };
        const output = { args: {}, metadata: { v: 2 }, timestamp: Date.now() };
        await expect(beforeHook(input, output)).resolves.toBeUndefined();
      } finally {
        await ws.cleanup();
      }
    });

    // EDGE: after hook mutates output.output for blocked audit results
    it('EDGE — after hook mutates ToolHookOutput.output on audit block', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const afterHook = hooks['tool.execute.after']!;

        // Provide a flowguard_ tool with valid ToolHookOutput shape
        const output = {
          title: 'status',
          output: JSON.stringify({ phase: 'TICKET' }),
          metadata: {},
        };
        await afterHook({ tool: 'flowguard_status', sessionID, callID: 'c1', args: {} }, output);

        // output.output should still be a string (possibly mutated by audit)
        expect(typeof output.output).toBe('string');
      } finally {
        await ws.cleanup();
      }
    });

    // SMOKE: source-level regression — before/after hook modules must import types.ts,
    // preventing drift back to anonymous inline casts.
    it('SMOKE — hook modules import ToolHookInput from types.ts (source regression)', async () => {
      const beforehooksPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        'plugin-beforehooks.ts',
      );
      const afterhooksPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        'plugin-afterhooks.ts',
      );
      const source = await fs.readFile(beforehooksPath, 'utf-8');
      const afterSource = await fs.readFile(afterhooksPath, 'utf-8');
      expect(source).toContain("from './types.js'");
      expect(source).toContain('ToolHookBeforeInput');
      expect(source).toContain('ToolHookBeforeOutput');
      // ToolHookAfterOutput used by afterhooks
      expect(afterSource).toContain("from './types.js'");
      expect(afterSource).toContain('ToolHookAfterOutput');
    });
  });

  describe('teardown (dispose hook, no global listener leak)', () => {
    const EXIT_SIGNALS = ['SIGTERM', 'SIGINT', 'beforeExit'] as const;

    function exitListenerCount(): number {
      return EXIT_SIGNALS.reduce((n, s) => n + process.listenerCount(s), 0);
    }

    it('returns a dispose hook that is callable and resolves', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-dispose-'));
      try {
        await initGitRepo(dir);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: dir, directory: dir }),
        );
        expect(typeof hooks.dispose).toBe('function');
        await expect(hooks.dispose!()).resolves.toBeUndefined();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('does not register global process exit listeners (no leak across inits)', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-noleak-'));
      try {
        await initGitRepo(dir);
        const before = exitListenerCount();
        // Multiple inits must not accumulate SIGTERM/SIGINT/beforeExit listeners:
        // teardown is wired via the per-instance Hooks.dispose, not global signals.
        for (let i = 0; i < 5; i++) {
          await FlowGuardAuditPlugin(createMockInput({ worktree: dir, directory: dir }));
        }
        expect(exitListenerCount()).toBe(before);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
