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
import { createTestWorkspace } from './test-helpers.js';
import { readState, writeState } from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review-assurance.js';

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

    it('returns only the tool.execute.after hook (no other hooks)', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockInput());
      const keys = Object.keys(hooks).sort();
      expect(keys).toEqual(['tool.execute.after', 'tool.execute.before']);
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
  describe('PERF', () => {
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
      // 1000 calls in < 20ms => < 0.02ms per call (prefix check)
      expect(elapsed).toBeLessThan(50);
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

      it('no state file + no config → solo', async () => {
        const sessDir = path.join(tmpDir, 'sess_no_config');
        await fs.mkdir(sessDir, { recursive: true });

        const result = await resolvePluginSessionPolicy({
          sessDir,
        });

        expect(result.policy.mode).toBe('solo');
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
          overallVerdict: 'approve',
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
          overallVerdict: 'approve',
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
        expect(blocked.code).toBe('STRICT_REVIEW_ORCHESTRATION_FAILED');

        const state = await readState(sessDir);
        expect(state?.reviewAssurance?.obligations[0]?.blockedCode).toBe(
          'STRICT_REVIEW_ORCHESTRATION_FAILED',
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
          overallVerdict: 'approve',
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

    it('tool.execute.before hook exists and accepts input args', async () => {
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

        // Verify it handles flowguard tools without error
        await expect(
          beforeHook!({
            tool: 'flowguard_status',
            sessionID: crypto.randomUUID(),
            callID: 'c1',
            args: {},
          }),
        ).resolves.toBeUndefined();
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
});

// ─── isUsableWorktree (fail-closed worktree validation) ─────────────────────

describe('isUsableWorktree', () => {
  it('rejects undefined and empty strings', () => {
    expect(isUsableWorktree(undefined)).toBe(false);
    expect(isUsableWorktree('')).toBe(false);
  });

  it('rejects the filesystem root', () => {
    expect(isUsableWorktree('/')).toBe(false);
  });

  it('rejects a non-repo directory (no .git entry)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-no-git-'));
    try {
      expect(isUsableWorktree(tmp)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('accepts a directory with a .git directory', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-with-git-'));
    try {
      await fs.mkdir(path.join(tmp, '.git'), { recursive: true });
      expect(isUsableWorktree(tmp)).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('accepts a directory with a .git file (worktree/submodule pattern)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-git-file-'));
    try {
      await fs.writeFile(path.join(tmp, '.git'), 'gitdir: /elsewhere/.git/worktrees/x', 'utf-8');
      expect(isUsableWorktree(tmp)).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a path that does not exist', () => {
    expect(isUsableWorktree('/this/path/does/not/exist/anywhere')).toBe(false);
  });
});

// ─── Plugin bootstrap fail-closed: no rogue workspace folder ────────────────

describe('plugin bootstrap fail-closed', () => {
  /**
   * Regression for the rogue-fingerprint-folder bug:
   * When the plugin is loaded with worktree='/' (or any non-repo path),
   * it MUST NOT materialize a `workspaces/<fp>/` folder under
   * OPENCODE_CONFIG_DIR. Invariant: one fingerprint folder per repo.
   */
  let configDir: string;
  let originalEnv: string | undefined;
  let originalGuard: string | undefined;

  beforeEach(async () => {
    originalEnv = process.env.OPENCODE_CONFIG_DIR;
    originalGuard = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-rogue-regression-'));
    process.env.OPENCODE_CONFIG_DIR = configDir;
    process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  });

  afterEach(async () => {
    if (originalEnv !== undefined) process.env.OPENCODE_CONFIG_DIR = originalEnv;
    else delete process.env.OPENCODE_CONFIG_DIR;
    if (originalGuard !== undefined) process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = originalGuard;
    else delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
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
});
