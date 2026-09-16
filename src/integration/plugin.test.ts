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
import { makeProgressedState, makeState } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import type { PolicyMode } from '../config/policy.js';
import * as barrel from './index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBootableHostClient, createTestWorkspace, withTestEnv } from './test-helpers.js';
import { readState, writeState } from '../adapters/persistence.js';
import { writeRepoConfig } from '../adapters/persistence-config.js';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import {
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import { makePlanRevision } from '../state/evidence-test-constants.js';
import { fileURLToPath } from 'node:url';
import { clearUserDecisionIntents, consumeUserDecisionIntent } from './user-decision-intent.js';
import { _resetAgentResolutionCache } from './review/agent-resolution.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './review/dispatch-authority.js';

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
    client: createBootableHostClient(),
    $: {} as unknown,
    directory: '/tmp/mock-dir',
    worktree: '/tmp/mock-worktree',
    serverUrl: new URL('http://localhost:3000'),
    ...overrides,
  } as unknown as Parameters<typeof FlowGuardAuditPlugin>[0];
}

async function seedStrictPlanSession(worktree: string, sessionID: string) {
  const now = new Date().toISOString();
  const fp = await computeFingerprint(worktree);
  const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
  const obligationId = '11111111-1111-4111-8111-111111111111';
  const reviewMaterial = freezeReviewMaterial('## Plan\n1. Fix auth', 'test-subject-digest');
  const planCurrent = makePlanRevision({ body: '## Plan\n1. Fix auth', createdAt: now });

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
        current: planCurrent,
        history: [],
        reviewCompletion: 'pending',
        reviewFindings: [],
      },
      selfReview: {
        iteration: 0,
        reviewCycle: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: planCurrent.digest,
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
      policySnapshot: {
        ...makeState('PLAN').policySnapshot,
      },
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [
          {
            obligationId,
            obligationType: 'plan',
            reviewCycle: 1,
            requiredChallengeCount: 0,
            requiredChallengeKind: 'design_challenge',
            challengePolicyVersion: 'challenge-policy.v1',
            repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
            subjectDigest: 'test-subject-digest',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            maxReviewerAttempts: 1,
            reviewProfile: 'core',
            profileSource: 'policy_default',
            createdAt: now,
            pluginHandshakeAt: null,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
            reviewSubjectScope: {
              kind: 'artifact',
              artifact: {
                kind: 'plan',
                digest: 'test-subject-digest',
                sectionPaths: [[{ headingDepth: 2, siblingIndex: 1, headingText: 'Plan' }]],
              },
            },
            reviewMaterial,
          },
        ],
        invocations: [],
        attempts: [
          {
            attemptId: '11111111-2222-4111-8111-111111111111',
            obligationId,
            obligationType: 'plan' as const,
            subjectDigest: 'test-subject-digest',
            ordinal: 0,
            status: 'created' as const,
            origin: { kind: 'initial' } as const,
            repositoryDiscovery: { kind: 'not_applicable' } as const,
            observations: [],
            createdAt: now,
          },
        ],
        dispatches: [],
      },
    }),
  );

  return { sessDir, obligationId };
}

async function seedStrictImplementationSession(worktree: string, sessionID: string) {
  const now = new Date().toISOString();
  const fp = await computeFingerprint(worktree);
  const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
  const obligationId = '22222222-1111-4111-8111-111111111111';
  const attemptId = '22222222-2222-4111-8111-111111111111';
  const reviewMaterial = freezeReviewMaterial('## Implementation\n1. Fix auth', 'impl-digest-1');
  const planCurrent = makePlanRevision({ body: '## Plan\n1. Fix auth', createdAt: now });

  const base = makeProgressedState('IMPL_REVIEW');
  const state = {
    ...base,
    plan: {
      current: planCurrent,
      history: [],
      reviewCompletion: 'reviewer_accepted' as const,
      reviewFindings: [],
    },
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [
        {
          obligationId,
          obligationType: 'implement',
          reviewCycle: 1,
          requiredChallengeCount: 0,
          requiredChallengeKind: 'implementation_challenge',
          challengePolicyVersion: 'challenge-policy.v1',
          subjectDigest: 'impl-digest-1',
          iteration: 0,
          planVersion: 1,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          maxReviewerAttempts: 1,
          reviewProfile: 'core',
          profileSource: 'policy_default',
          createdAt: now,
          pluginHandshakeAt: null,
          status: 'pending',
          invocationId: null,
          blockedCode: null,
          fulfilledAt: null,
          consumedAt: null,
          reviewSubjectScope: {
            kind: 'implementation',
            implementationDigest: 'impl-digest-1',
          },
          reviewMaterial,
        },
      ],
      invocations: [],
      attempts: [
        {
          attemptId,
          obligationId,
          obligationType: 'implement' as const,
          subjectDigest: 'impl-digest-1',
          ordinal: 0,
          status: 'created' as const,
          origin: { kind: 'initial' } as const,
          repositoryDiscovery: { kind: 'not_applicable' } as const,
          observations: [],
          createdAt: now,
        },
      ],
      dispatches: [],
    },
  } as SessionState;

  await fs.mkdir(sessDir, { recursive: true });
  await writeState(sessDir, state);

  return { sessDir, obligationId, attemptId, state };
}

function strictPlanReviewRequiredOutput(
  obligationId: string,
  overrides: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    phase: 'PLAN',
    selfReviewIteration: 0,
    reviewMode: 'subagent',
    reviewObligation: {
      obligationId,
      obligationType: 'plan',
      iteration: 0,
      planVersion: 1,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      requiredChallengeCount: 0,
      requiredChallengeKind: 'design_challenge',
    },
    reviewDispatch: { required: true },
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

  describe('OpenCode host adapter boot contract', () => {
    it('logs contract-attested host capabilities at boot', async () => {
      const ws = await createTestWorkspace();
      try {
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both' },
        });
        const logSpy = vi.fn().mockResolvedValue(undefined);
        await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: createBootableHostClient({ app: { log: logSpy } }),
          }),
        );

        expect(logSpy).toHaveBeenCalledWith({
          body: {
            service: 'adapter',
            level: 'warn',
            message: 'host capabilities are contract-attested only',
            extra: {
              code: 'HOST_CAPABILITY_UNVERIFIED',
              runtimeVerified: [],
              contractAttested: [
                'preToolBlock',
                'argMutation',
                'outputReplacement',
                'contextInjection',
                'reviewTransports.native_task_structured_followup',
                'compactionInjection',
              ],
            },
          },
        });
      } finally {
        await ws.cleanup();
      }
    });

    it('fails closed when the SDK client cannot guarantee the adapter contract', async () => {
      await expect(
        FlowGuardAuditPlugin(
          createMockInput({
            client: {
              // Native structured serialization still requires the host agent
              // registry; without it the adapter cannot guarantee the reviewer
              // child identity and must fail closed.
              session: { prompt: async () => ({}) },
              app: { log: async () => {} },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'HOST_ADAPTER_INIT_FAILED' });
    });

    it('does not probe the host agent registry at boot (reviewer verification is lazy)', async () => {
      const agents = vi.fn(async () => ({ error: 'unavailable' }));

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ client: createBootableHostClient({ app: { agents } }) }),
      );

      expect(hooks).toBeDefined();
      expect(agents).not.toHaveBeenCalled();
    });

    it('failed boot disposes initialized logging resources (no SIGUSR1 listener leak)', async () => {
      const ws = await createTestWorkspace();
      try {
        await writeRepoConfig(ws.tmpDir, {
          ...DEFAULT_CONFIG,
          logging: { ...DEFAULT_CONFIG.logging, mode: 'both', enableDynamicLevel: true },
        });
        const baseline = process.listenerCount('SIGUSR1');

        // Prove the reloader attaches for this configuration on a successful boot.
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({
            worktree: ws.tmpDir,
            directory: ws.tmpDir,
            client: createBootableHostClient(),
          }),
        );
        expect(process.listenerCount('SIGUSR1')).toBe(baseline + 1);
        await hooks.dispose!();
        expect(process.listenerCount('SIGUSR1')).toBe(baseline);

        // A failed boot must release the same resources.
        await expect(
          FlowGuardAuditPlugin(
            createMockInput({
              worktree: ws.tmpDir,
              directory: ws.tmpDir,
              // Missing host agent registry forces the fail-closed boot path
              // after the logger (and its SIGUSR1 reloader) has been initialized.
              client: createBootableHostClient({
                app: { agents: undefined },
              }),
            }),
          ),
        ).rejects.toMatchObject({ code: 'HOST_ADAPTER_INIT_FAILED' });

        expect(process.listenerCount('SIGUSR1')).toBe(baseline);
      } finally {
        await ws.cleanup();
      }
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
            client: createBootableHostClient({ app: { log: logSpy } }),
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
            client: createBootableHostClient({ app: { log: logSpy } }),
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
            client: createBootableHostClient({ app: { log: logSpy } }),
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
            client: createBootableHostClient({ app: { log: logSpy } }),
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
            client: createBootableHostClient({ app: { log: logSpy } }),
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

  describe('native visible review transport', () => {
    const ATTEMPT_ID = '11111111-2222-4111-8111-111111111111';
    const CHILD_SESSION_ID = 'child-session-native-1';
    const CALL_ID = 'call-native-1';

    function nativeFindings(
      obligationId: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        iteration: 0,
        planVersion: 1,
        reviewMode: 'subagent',
        overallVerdict: 'accept',
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        challenges: [],
        attestation: { toolObligationId: obligationId },
        ...overrides,
      };
    }

    async function bootNativeReviewSession(buildStructured?: (obligationId: string) => unknown) {
      const ws = await createTestWorkspace();
      const sessionID = crypto.randomUUID();
      const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
      const structured = buildStructured?.(obligationId) ?? null;
      const structuredPrompt = vi.fn(async () => ({ data: { info: { structured } } }));
      const agents = vi.fn(async () => ({ data: [{ id: 'flowguard-reviewer' }] }));
      const hooks = await FlowGuardAuditPlugin(
        createMockInput({
          worktree: ws.tmpDir,
          directory: ws.tmpDir,
          client: {
            app: { log: async () => {}, agents },
            session: { prompt: structuredPrompt },
          },
        }),
      );
      const output = {
        title: 'plan',
        output: strictPlanReviewRequiredOutput(obligationId, { reviewAttemptId: ATTEMPT_ID }),
        metadata: {},
      };
      await hooks['tool.execute.after']!(
        { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
        output,
      );
      return { ws, sessionID, sessDir, obligationId, hooks, structuredPrompt, output };
    }

    async function dispatchReviewerTask(
      hooks: Awaited<ReturnType<typeof FlowGuardAuditPlugin>>,
      sessionID: string,
      callID = CALL_ID,
    ) {
      const output: { args: Record<string, unknown> } = {
        args: { subagent_type: 'flowguard-reviewer', prompt: 'agent-authored prompt' },
      };
      await hooks['tool.execute.before']!({ tool: 'task', sessionID, callID }, output);
      return output;
    }

    async function completeReviewerTask(
      hooks: Awaited<ReturnType<typeof FlowGuardAuditPlugin>>,
      sessionID: string,
      callID = CALL_ID,
    ) {
      const output: { title: string; output: string; metadata: Record<string, unknown> } = {
        title: 'task',
        output: 'Free-form reviewer transcript text is not findings authority.',
        metadata: { sessionId: CHILD_SESSION_ID },
      };
      await hooks['tool.execute.after']!(
        { tool: 'task', sessionID, callID, args: { subagent_type: 'flowguard-reviewer' } },
        output,
      );
      return output;
    }

    beforeEach(() => {
      _resetAgentResolutionCache();
    });

    it('leaves the review-required output pending and authorizes the native Task before release', async () => {
      const { ws, sessionID, sessDir, obligationId, hooks, output } =
        await bootNativeReviewSession();
      try {
        // The reviewable tool response stays untouched: only the parent agent
        // can invoke the visible native Task surface.
        const pending = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(pending.reviewDispatch).toEqual({ required: true });
        let state = await readState(sessDir);
        expect(state?.reviewAssurance?.obligations[0]?.status).toBe('pending');
        expect(state?.reviewAssurance?.dispatches).toEqual([]);

        const taskOutput = await dispatchReviewerTask(hooks, sessionID);

        // The canonical frozen prompt replaces whatever the agent authored.
        expect(taskOutput.args.prompt).toContain('## Plan');
        expect(taskOutput.args.description).toBe('FlowGuard independent review');
        expect(taskOutput.args.background).toBe(false);

        state = await readState(sessDir);
        const dispatch = state?.reviewAssurance?.dispatches[0];
        expect(dispatch?.dispatchStatus).toBe('authorized');
        expect(dispatch?.hostCallId).toBe(CALL_ID);
        expect(dispatch?.obligationId).toBe(obligationId);
        expect(dispatch?.attemptId).toBe(ATTEMPT_ID);
      } finally {
        await ws.cleanup();
      }
    });

    it('refuses to release the same reviewer attempt twice', async () => {
      const { ws, sessionID, hooks } = await bootNativeReviewSession();
      try {
        await dispatchReviewerTask(hooks, sessionID);
        await expect(dispatchReviewerTask(hooks, sessionID, 'call-native-2')).rejects.toThrow(
          'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
        );
      } finally {
        await ws.cleanup();
      }
    });

    it('blocks a completed Task without authoritative child metadata and abandons the dispatch', async () => {
      const { ws, sessionID, sessDir, hooks } = await bootNativeReviewSession();
      try {
        await dispatchReviewerTask(hooks, sessionID);
        const output: { title: string; output: string; metadata: Record<string, unknown> } = {
          title: 'task',
          output: 'child identity was not surfaced',
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          {
            tool: 'task',
            sessionID,
            callID: CALL_ID,
            args: { subagent_type: 'flowguard-reviewer' },
          },
          output,
        );

        const blocked = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(blocked.error).toBe(true);
        expect(blocked.code).toBe('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE');

        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.dispatches[0]?.dispatchStatus).toBe('outcome_unknown');
        expect(state?.reviewAssurance?.invocations).toEqual([]);
      } finally {
        await ws.cleanup();
      }
    });

    it('fails closed when no pending review authorizes the native Task', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        await seedStrictPlanSession(ws.tmpDir, sessionID);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        await expect(dispatchReviewerTask(hooks, sessionID)).rejects.toThrow(
          'SUBAGENT_REVIEW_NOT_INVOKED',
        );
      } finally {
        await ws.cleanup();
      }
    });

    it('authorizes the native reviewer Task for an implementation review dispatch', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { sessDir, obligationId, attemptId, state } = await seedStrictImplementationSession(
          ws.tmpDir,
          sessionID,
        );
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );

        // Build the dispatch response exactly as the canonical producer does.
        const authority = resolveReviewDispatchAuthority(state.reviewAssurance, obligationId);
        expect(authority.kind).toBe('ok');
        if (authority.kind !== 'ok') return;
        const output = {
          title: 'implement',
          output: JSON.stringify({
            phase: 'IMPL_REVIEW',
            reviewMode: 'subagent',
            ...reviewObligationResponseFields(authority.authority),
            reviewDispatch: { required: true },
          }),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_implement', sessionID, callID: 'c1', args: {} },
          output,
        );
        const accepted = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(accepted.error).toBeUndefined();
        expect(accepted.reviewAttemptId).toBe(attemptId);

        const taskOutput = await dispatchReviewerTask(hooks, sessionID);
        expect(typeof taskOutput.args.prompt).toBe('string');
        expect(String(taskOutput.args.prompt).length).toBeGreaterThan(0);
        expect(taskOutput.args.description).toBe('FlowGuard independent review');

        const persisted = await readState(sessDir);
        const dispatch = persisted?.reviewAssurance?.dispatches[0];
        expect(dispatch?.dispatchStatus).toBe('authorized');
        expect(dispatch?.hostCallId).toBe(CALL_ID);
        expect(dispatch?.obligationId).toBe(obligationId);
        expect(dispatch?.attemptId).toBe(attemptId);
      } finally {
        await ws.cleanup();
      }
    });

    it('accepts retry_transport recovery from the implementation verdict tool', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { obligationId, attemptId, state } = await seedStrictImplementationSession(
          ws.tmpDir,
          sessionID,
        );
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const authority = resolveReviewDispatchAuthority(state.reviewAssurance, obligationId);
        expect(authority.kind).toBe('ok');
        if (authority.kind !== 'ok') return;
        const output = {
          title: 'implementation review recovery',
          output: JSON.stringify({
            phase: 'IMPL_REVIEW',
            reviewMode: 'subagent',
            ...reviewObligationResponseFields(authority.authority),
            reviewDispatch: { required: true },
          }),
          metadata: {},
        };

        await hooks['tool.execute.after']!(
          {
            tool: 'flowguard_review_implementation',
            sessionID,
            callID: 'retry-transport-call',
            args: { reviewRecovery: 'retry_transport' },
          },
          output,
        );

        const accepted = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(accepted.error).toBeUndefined();
        expect(accepted.reviewAttemptId).toBe(attemptId);
        await expect(dispatchReviewerTask(hooks, sessionID)).resolves.toBeDefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('authorizes the native reviewer Task for a content-analysis peer review authority', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
        const state = await readState(sessDir);
        expect(state).not.toBeNull();
        if (!state?.reviewAssurance) return;
        const reviewState = {
          ...state,
          reviewAssurance: {
            ...state.reviewAssurance,
            obligations: state.reviewAssurance.obligations.map((obligation) => {
              const { repositoryEvidenceFreeze: _repositoryEvidenceFreeze, ...peerObligation } =
                obligation;
              const subjectDigest = 'b'.repeat(64);
              return {
                ...peerObligation,
                obligationType: 'review' as const,
                reviewCycle: null,
                requiredChallengeKind: 'content_challenge' as const,
                subjectDigest,
                reviewMaterial: { ...obligation.reviewMaterial, subjectDigest },
                reviewSubject: {
                  kind: 'content' as const,
                  source: { kind: 'inline' as const, mediaType: 'text' as const },
                  materialDigest: obligation.reviewMaterial.materialDigest,
                  subjectDigest,
                  lineCount: 1,
                },
                reviewSubjectScope: {
                  kind: 'content' as const,
                  subjectDigest,
                  lineCount: 1,
                },
              };
            }),
            attempts: state.reviewAssurance.attempts.map((attempt) => ({
              ...attempt,
              obligationType: 'review' as const,
              subjectDigest: 'b'.repeat(64),
            })),
          },
        };
        await writeState(sessDir, reviewState);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const authority = resolveReviewDispatchAuthority(reviewState.reviewAssurance, obligationId);
        expect(authority.kind).toBe('ok');
        if (authority.kind !== 'ok') return;
        const output = {
          title: 'peer review',
          output: JSON.stringify({
            error: true,
            code: 'CONTENT_ANALYSIS_REQUIRED',
            ...reviewObligationResponseFields(authority.authority),
            requiredReviewAttestation: { toolObligationId: obligationId },
          }),
          metadata: {},
        };

        await hooks['tool.execute.after']!(
          { tool: 'flowguard_review', sessionID, callID: 'peer-review-call', args: {} },
          output,
        );

        const accepted = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(accepted.code).toBe('CONTENT_ANALYSIS_REQUIRED');
        expect(accepted.reviewAttemptId).toBe(authority.authority.attempt.attemptId);
        await expect(dispatchReviewerTask(hooks, sessionID)).resolves.toBeDefined();
      } finally {
        await ws.cleanup();
      }
    });

    it('blocks a review-required response without the exact attempt authority', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const output = {
          title: 'plan',
          output: strictPlanReviewRequiredOutput(obligationId, {
            reviewAttemptId: undefined,
          }),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
          output,
        );

        const blocked = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(blocked.error).toBe(true);
        expect(blocked.code).toBe('REVIEW_ATTEMPT_UNAVAILABLE');

        // No pending review binding was registered for the nonconforming response.
        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.obligations[0]?.status).toBe('pending');
        await expect(dispatchReviewerTask(hooks, sessionID)).rejects.toThrow(
          'SUBAGENT_REVIEW_NOT_INVOKED',
        );
      } finally {
        await ws.cleanup();
      }
    });

    it('blocks a review-required response whose attempt does not match the persisted continuation', async () => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const { obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const output = {
          title: 'plan',
          output: strictPlanReviewRequiredOutput(obligationId, {
            reviewAttemptId: '11111111-2222-4111-8111-000000000000',
          }),
          metadata: {},
        };
        await hooks['tool.execute.after']!(
          { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
          output,
        );

        const blocked = JSON.parse(String(output.output)) as Record<string, unknown>;
        expect(blocked.error).toBe(true);
        expect(blocked.code).toBe('REVIEW_ATTEMPT_UNAVAILABLE');
        expect(JSON.stringify(blocked)).toContain('does not match the persisted pending attempt');
      } finally {
        await ws.cleanup();
      }
    });

    it('blocks malformed structured reviewer output without recording evidence', async () => {
      const { ws, sessionID, sessDir, obligationId, hooks } = await bootNativeReviewSession(
        (obligationId) => {
          const malformed = nativeFindings(obligationId);
          delete malformed.attestation;
          return malformed;
        },
      );
      try {
        await dispatchReviewerTask(hooks, sessionID);
        const taskOutput = await completeReviewerTask(hooks, sessionID);

        const blocked = JSON.parse(String(taskOutput.output)) as Record<string, unknown>;
        expect(blocked.error).toBe(true);
        // The host-validated structured payload violates the canonical reviewer
        // DTO before any obligation evidence is evaluated.
        expect(blocked.code).toBe('HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION');

        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.obligations[0]?.status).toBe('pending');
        expect(state?.reviewAssurance?.invocations).toEqual([]);
        expect(state?.reviewAssurance?.dispatches[0]?.dispatchStatus).toBe('outcome_unknown');
        void obligationId;
      } finally {
        await ws.cleanup();
      }
    });

    it('blocks a self-mode reviewer declaration and marks the dispatch outcome unknown', async () => {
      const { ws, sessionID, sessDir, obligationId, hooks } = await bootNativeReviewSession(
        (obligationId) => nativeFindings(obligationId, { reviewMode: 'self' }),
      );
      try {
        await dispatchReviewerTask(hooks, sessionID);
        const taskOutput = await completeReviewerTask(hooks, sessionID);

        const blocked = JSON.parse(String(taskOutput.output)) as Record<string, unknown>;
        expect(blocked.error).toBe(true);
        expect(blocked.code).toBe('SUBAGENT_MANDATE_MISMATCH');

        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.dispatches[0]?.dispatchStatus).toBe('outcome_unknown');
        expect(state?.reviewAssurance?.invocations).toEqual([]);
      } finally {
        await ws.cleanup();
      }
    });

    it('does not record evidence or fulfill when attestation iteration is wrong', async () => {
      const { ws, sessionID, sessDir, obligationId, hooks } = await bootNativeReviewSession(
        (obligationId) => nativeFindings(obligationId, { iteration: 1 }),
      );
      try {
        await dispatchReviewerTask(hooks, sessionID);
        const taskOutput = await completeReviewerTask(hooks, sessionID);

        const blocked = JSON.parse(String(taskOutput.output)) as Record<string, unknown>;
        expect(blocked.code).toBe('SUBAGENT_MANDATE_MISMATCH');

        const state = await readState(sessDir);
        const obligation = state?.reviewAssurance?.obligations[0];
        expect(obligation?.status).toBe('pending');
        expect(obligation?.invocationId).toBeNull();
        expect(obligation?.fulfilledAt).toBeNull();
        expect(state?.reviewAssurance?.invocations).toEqual([]);
      } finally {
        await ws.cleanup();
      }
    });

    it('records bound same-child evidence and fulfills the obligation', async () => {
      const { ws, sessionID, sessDir, obligationId, hooks, structuredPrompt } =
        await bootNativeReviewSession((obligationId) => nativeFindings(obligationId));
      try {
        await dispatchReviewerTask(hooks, sessionID);
        const taskOutput = await completeReviewerTask(hooks, sessionID);

        // Serialization happens in the exact visible child session.
        expect(structuredPrompt).toHaveBeenCalledWith(
          expect.objectContaining({
            path: { id: CHILD_SESSION_ID },
            body: expect.objectContaining({
              format: expect.objectContaining({ type: 'json_schema' }),
            }),
          }),
        );

        const completed = JSON.parse(String(taskOutput.output)) as Record<string, unknown>;
        expect(completed.reviewDispatch).toEqual({
          required: true,
          completed: true,
          verdict: 'accept',
        });
        expect(taskOutput.metadata.flowguardReviewExecution).toBeDefined();

        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.obligations[0]?.status).toBe('fulfilled');
        const invocation = state?.reviewAssurance?.invocations[0];
        expect(invocation?.invocationMode).toBe('native_task_structured_followup');
        expect(invocation?.childSessionId).toBe(CHILD_SESSION_ID);
        void obligationId;
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
          output: JSON.stringify({ phase: 'PLAN' }),
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

    it('BAD — before hook fail-closes an invalid empty tool identity', async () => {
      const ws = await createTestWorkspace();
      try {
        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        await expect(
          beforeHook({ tool: '', sessionID: '', callID: '' }, { args: {} }),
        ).rejects.toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
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
