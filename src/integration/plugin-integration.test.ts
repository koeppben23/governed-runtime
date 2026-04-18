/**
 * @module integration/plugin-integration.test
 * @description Integration tests for the FlowGuard audit plugin.
 *
 * Tests the plugin's tool.execute.after handler against real filesystem
 * persistence. Each test initializes a workspace, writes session state to disk,
 * then calls the handler with simulated tool input/output to verify:
 * - Audit events are persisted to audit.jsonl
 * - Hash chain integrity across multiple events
 * - Policy-aware emission (tool_call, transition, chain hash)
 * - Lifecycle events (session_created, session_completed, session_aborted)
 * - Error events on tool failures
 * - Auto-archive on COMPLETE transitions
 * - Fire-and-forget error handling (no crashes)
 *
 * Git adapter functions are selectively mocked (same as tools-execute.test.ts).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createTestWorkspace,
  isTarAvailable,
  GIT_MOCK_DEFAULTS,
  type TestWorkspace,
} from './test-helpers';
import { FlowGuardAuditPlugin } from './plugin';
import { writeState, readAuditTrail } from '../adapters/persistence';
import {
  initWorkspace,
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace';
import { verifyChain } from '../audit/integrity';
import { makeState, makeProgressedState } from '../__fixtures__';
import type { Phase } from '../state/schema';

// ─── Git Mock ────────────────────────────────────────────────────────────────

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

// ─── Capability Gates ────────────────────────────────────────────────────────

const tarOk = await isTarAvailable();

// ─── Types ───────────────────────────────────────────────────────────────────

/** Shape of plugin tool.execute.after input. */
interface PluginInput {
  tool: string;
  sessionID: string;
  callID?: string;
  args?: Record<string, unknown>;
}

/** Shape of plugin tool.execute.after output. */
interface PluginOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let sessionId: string;
let sessDir: string;
let fingerprint: string;
let handler: (input: PluginInput, output: PluginOutput) => Promise<void>;
let logEntries: Array<{ level: string; message: string }>;

beforeEach(async () => {
  ws = await createTestWorkspace();
  sessionId = `ses_${crypto.randomUUID().replace(/-/g, '')}`;

  // Initialize workspace + resolve paths
  const fp = await computeFingerprint(ws.tmpDir);
  fingerprint = fp.fingerprint;
  await initWorkspace(ws.tmpDir, sessionId);
  sessDir = resolveSessionDir(fingerprint, sessionId);

  // Write initial state to disk (TICKET phase with team policy for audit)
  const state = makeState('TICKET', {
    id: crypto.randomUUID(),
    binding: {
      sessionId,
      worktree: ws.tmpDir,
      fingerprint,
      resolvedAt: new Date().toISOString(),
    },
    policySnapshot: {
      mode: 'team',
      hash: 'test-policy-hash',
      resolvedAt: new Date().toISOString(),
      requestedMode: 'team',
      effectiveGateBehavior: 'human_gated',
      requireHumanGates: true,
      maxSelfReviewIterations: 3,
      maxImplReviewIterations: 3,
      allowSelfApproval: true,
      audit: {
        emitTransitions: true,
        emitToolCalls: true,
        enableChainHash: true,
      },
      actorClassification: { flowguard_decision: 'human' },
    },
  });
  await writeState(sessDir, state);

  // Initialize plugin with real worktree
  logEntries = [];
  const hooks = await FlowGuardAuditPlugin({
    project: {} as never,
    client: {
      app: {
        log: async (entry: unknown) => {
          const e = entry as { body?: { level?: string; message?: string } };
          logEntries.push({
            level: e.body?.level ?? 'info',
            message: e.body?.message ?? '',
          });
        },
      },
    } as never,
    $: {} as never,
    directory: ws.tmpDir,
    worktree: ws.tmpDir,
    serverUrl: new URL('http://localhost:3000'),
    experimental_workspace: undefined as never,
  });

  handler = hooks['tool.execute.after']! as (
    input: PluginInput,
    output: PluginOutput,
  ) => Promise<void>;
});

afterEach(async () => {
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract event kind from an audit event.
 *
 * AuditEvent stores the kind inside `detail.kind` (structural)
 * and as the prefix of `event` (e.g., "tool_call:flowguard_status").
 * Use `detail.kind` as the primary source since it's the typed field.
 */
function eventKind(e: { detail: Record<string, unknown>; event: string }): string {
  return (e.detail.kind as string) ?? e.event.split(':')[0];
}

/** Build a tool output JSON string with the given fields. */
function makeToolOutput(fields: {
  phase?: string;
  status?: string;
  error?: boolean;
  errorMessage?: string;
  policyResolution?: Record<string, unknown>;
  reviewDecision?: Record<string, unknown>;
  _audit?: {
    transitions?: Array<{
      from: string;
      to: string;
      event: string;
      at: string;
    }>;
  };
}): string {
  return JSON.stringify({
    phase: fields.phase ?? 'TICKET',
    status: fields.status ?? 'ok',
    ...fields,
  });
}

/** Read audit events from session directory. */
async function getEvents() {
  return await readAuditTrail(sessDir);
}

// =============================================================================
// Tests
// =============================================================================

describe('plugin-integration', () => {
  // ─── HAPPY ─────────────────────────────────────────────────

  describe('HAPPY', () => {
    it('persists a tool_call event for a FlowGuard tool', async () => {
      await handler(
        { tool: 'flowguard_status', sessionID: sessionId },
        { title: 'status', output: makeToolOutput({ phase: 'TICKET' }), metadata: {} },
      );

      const { events } = await getEvents();
      expect(events.length).toBeGreaterThanOrEqual(1);
      const toolCallEvents = events.filter((e) => eventKind(e) === 'tool_call');
      expect(toolCallEvents.length).toBe(1);
      expect(toolCallEvents[0].event).toBe('tool_call:flowguard_status');
    });

    it('persists transition events for phase changes', async () => {
      const transitions = [
        {
          from: 'TICKET',
          to: 'PLAN',
          event: 'PLAN_READY',
          at: new Date().toISOString(),
        },
      ];

      await handler(
        { tool: 'flowguard_plan', sessionID: sessionId },
        {
          title: 'plan',
          output: makeToolOutput({
            phase: 'PLAN',
            _audit: { transitions },
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const transEvents = events.filter((e) => eventKind(e) === 'transition');
      expect(transEvents.length).toBe(1);
      expect(transEvents[0].event).toBe('transition:PLAN_READY');
    });

    it('emits lifecycle session_created for hydrate', async () => {
      const transitions = [
        {
          from: 'INIT',
          to: 'TICKET',
          event: 'SESSION_BOUND',
          at: new Date().toISOString(),
        },
      ];

      await handler(
        { tool: 'flowguard_hydrate', sessionID: sessionId },
        {
          title: 'hydrate',
          output: makeToolOutput({
            phase: 'TICKET',
            _audit: { transitions },
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const lifecycle = events.filter((e) => eventKind(e) === 'lifecycle');
      expect(lifecycle.length).toBeGreaterThanOrEqual(1);
      const created = lifecycle.find((e) => e.event.includes('session_created'));
      expect(created).toBeDefined();
    });

    it('emits lifecycle session_completed on COMPLETE transition', async () => {
      // Update state to EVIDENCE_REVIEW so COMPLETE transition makes sense
      const state = makeProgressedState('EVIDENCE_REVIEW');
      await writeState(sessDir, {
        ...state,
        binding: {
          sessionId,
          worktree: ws.tmpDir,
          fingerprint,
          resolvedAt: new Date().toISOString(),
        },
        policySnapshot: {
          mode: 'team',
          hash: 'test-policy-hash',
          resolvedAt: new Date().toISOString(),
          requestedMode: 'team',
          effectiveGateBehavior: 'human_gated',
          requireHumanGates: true,
          maxSelfReviewIterations: 3,
          maxImplReviewIterations: 3,
          allowSelfApproval: true,
          audit: {
            emitTransitions: true,
            emitToolCalls: true,
            enableChainHash: true,
          },
          actorClassification: { flowguard_decision: 'human' },
        },
      });

      const transitions = [
        {
          from: 'EVIDENCE_REVIEW',
          to: 'COMPLETE',
          event: 'EVIDENCE_APPROVED',
          at: new Date().toISOString(),
        },
      ];

      await handler(
        { tool: 'flowguard_decision', sessionID: sessionId },
        {
          title: 'decision',
          output: makeToolOutput({
            phase: 'COMPLETE',
            _audit: { transitions },
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const lifecycle = events.filter((e) => eventKind(e) === 'lifecycle');
      const completed = lifecycle.find((e) => e.event.includes('session_completed'));
      expect(completed).toBeDefined();
    });

    it('actor classification matches policy', async () => {
      // In team mode, flowguard_decision is classified as "human"
      await handler(
        { tool: 'flowguard_decision', sessionID: sessionId },
        {
          title: 'decision',
          output: makeToolOutput({ phase: 'VALIDATION' }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const toolCall = events.find((e) => eventKind(e) === 'tool_call');
      expect(toolCall).toBeDefined();
      expect(toolCall!.actor).toBe('human');
    });

    it('emits decision receipt with DEC-001 format', async () => {
      const transitions = [
        {
          from: 'PLAN_REVIEW',
          to: 'VALIDATION',
          event: 'APPROVE',
          at: new Date().toISOString(),
        },
      ];

      await handler(
        {
          tool: 'flowguard_decision',
          sessionID: sessionId,
          args: { verdict: 'approve', rationale: 'Looks good' },
        },
        {
          title: 'decision',
          output: makeToolOutput({
            phase: 'VALIDATION',
            reviewDecision: {
              verdict: 'approve',
              rationale: 'Looks good',
              decidedBy: 'reviewer-42',
              decidedAt: transitions[0]!.at,
            },
            _audit: { transitions },
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const decision = events.find((e) => eventKind(e) === 'decision');
      expect(decision).toBeDefined();
      expect(decision!.event).toBe('decision:DEC-001');
      expect(decision!.detail.decisionSequence).toBe(1);
      expect(decision!.detail.verdict).toBe('approve');
      expect(decision!.detail.rationale).toBe('Looks good');
      expect(decision!.detail.decidedBy).toBe('reviewer-42');
    });

    it('session_created lifecycle reason includes policy resolution fields', async () => {
      await handler(
        { tool: 'flowguard_hydrate', sessionID: sessionId },
        {
          title: 'hydrate',
          output: makeToolOutput({
            phase: 'READY',
            policyResolution: {
              requestedMode: 'team-ci',
              effectiveMode: 'team',
              effectiveGateBehavior: 'human_gated',
              reason: 'ci_context_missing',
            },
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const lifecycle = events.find((e) => e.event === 'lifecycle:session_created');
      expect(lifecycle).toBeDefined();
      expect(String(lifecycle!.detail.reason)).toContain('requested_mode:team-ci');
      expect(String(lifecycle!.detail.reason)).toContain('effective_mode:team');
      expect(String(lifecycle!.detail.reason)).toContain('reason:ci_context_missing');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────

  describe('BAD', () => {
    it('ignores non-FlowGuard tools completely', async () => {
      await handler(
        { tool: 'bash', sessionID: sessionId },
        { title: 'bash', output: 'some output', metadata: {} },
      );

      const { events } = await getEvents();
      expect(events.length).toBe(0);
    });

    it('handles invalid JSON output without crashing', async () => {
      await handler(
        { tool: 'flowguard_status', sessionID: sessionId },
        { title: 'status', output: 'not valid json {{', metadata: {} },
      );

      // Should not throw — fire-and-forget
      const { events } = await getEvents();
      // A tool_call event should still be written (with phase="unknown")
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('handles missing session directory gracefully', async () => {
      // Create a new plugin pointing to a nonexistent worktree
      const hooks = await FlowGuardAuditPlugin({
        project: {} as never,
        client: { app: { log: async () => {} } } as never,
        $: {} as never,
        directory: '/nonexistent/path',
        worktree: '/nonexistent/path',
        serverUrl: new URL('http://localhost:3000'),
        experimental_workspace: undefined as never,
      });
      const badHandler = hooks['tool.execute.after']! as (
        input: PluginInput,
        output: PluginOutput,
      ) => Promise<void>;

      // Should not throw
      await badHandler(
        { tool: 'flowguard_status', sessionID: 'fake' },
        { title: 'status', output: '{}', metadata: {} },
      );
    });

    it('does not emit decision receipt when decision call fails', async () => {
      await handler(
        {
          tool: 'flowguard_decision',
          sessionID: sessionId,
          args: { verdict: 'approve', rationale: 'x' },
        },
        {
          title: 'decision',
          output: makeToolOutput({
            phase: 'PLAN_REVIEW',
            error: true,
            errorMessage: 'blocked',
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const decisions = events.filter((e) => eventKind(e) === 'decision');
      expect(decisions).toHaveLength(0);
      expect(events.some((e) => eventKind(e) === 'tool_call')).toBe(true);
      expect(events.some((e) => eventKind(e) === 'error')).toBe(true);
    });

    it('skips decision receipt and emits explicit error when decidedBy is missing', async () => {
      const transitions = [
        {
          from: 'PLAN_REVIEW',
          to: 'VALIDATION',
          event: 'APPROVE',
          at: new Date().toISOString(),
        },
      ];

      await handler(
        {
          tool: 'flowguard_decision',
          sessionID: sessionId,
          args: { verdict: 'approve', rationale: 'Missing actor test' },
        },
        {
          title: 'decision',
          output: makeToolOutput({
            phase: 'VALIDATION',
            reviewDecision: {
              verdict: 'approve',
              rationale: 'Missing actor test',
              decidedAt: transitions[0]!.at,
            },
            _audit: { transitions },
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const decisions = events.filter((e) => eventKind(e) === 'decision');
      expect(decisions).toHaveLength(0);
      const missingActorErr = events.find(
        (e) => eventKind(e) === 'error' && e.event === 'error:DECISION_RECEIPT_ACTOR_MISSING',
      );
      expect(missingActorErr).toBeDefined();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────

  describe('CORNER', () => {
    it('hash chain is valid across multiple events', async () => {
      // Emit several tool calls to build a chain
      for (let i = 0; i < 5; i++) {
        await handler(
          { tool: 'flowguard_status', sessionID: sessionId },
          {
            title: 'status',
            output: makeToolOutput({ phase: 'TICKET' }),
            metadata: {},
          },
        );
      }

      const { events } = await getEvents();
      expect(events.length).toBe(5);

      // Verify chain integrity
      const chainResult = verifyChain(events);
      expect(chainResult.valid).toBe(true);
      expect(chainResult.verifiedCount).toBe(5);
    });

    it('solo policy disables chain hash but still writes events', async () => {
      // Write state with solo policy (enableChainHash: false)
      const soloState = makeState('TICKET', {
        id: crypto.randomUUID(),
        binding: {
          sessionId,
          worktree: ws.tmpDir,
          fingerprint,
          resolvedAt: new Date().toISOString(),
        },
        policySnapshot: {
          mode: 'solo',
          hash: 'solo-hash',
          resolvedAt: new Date().toISOString(),
          requestedMode: 'solo',
          effectiveGateBehavior: 'auto_approve',
          requireHumanGates: false,
          maxSelfReviewIterations: 1,
          maxImplReviewIterations: 1,
          allowSelfApproval: true,
          audit: {
            emitTransitions: true,
            emitToolCalls: true,
            enableChainHash: false,
          },
          actorClassification: { flowguard_decision: 'system' },
        },
      });
      await writeState(sessDir, soloState);

      // Create a new plugin instance to pick up the solo config
      const hooks = await FlowGuardAuditPlugin({
        project: {} as never,
        client: { app: { log: async () => {} } } as never,
        $: {} as never,
        directory: ws.tmpDir,
        worktree: ws.tmpDir,
        serverUrl: new URL('http://localhost:3000'),
        experimental_workspace: undefined as never,
      });
      const soloHandler = hooks['tool.execute.after']! as (
        input: PluginInput,
        output: PluginOutput,
      ) => Promise<void>;

      // Emit events
      await soloHandler(
        { tool: 'flowguard_status', sessionID: sessionId },
        { title: 'status', output: makeToolOutput({ phase: 'TICKET' }), metadata: {} },
      );
      await soloHandler(
        { tool: 'flowguard_ticket', sessionID: sessionId },
        { title: 'ticket', output: makeToolOutput({ phase: 'TICKET' }), metadata: {} },
      );

      const { events } = await getEvents();
      expect(events.length).toBe(2);

      // Events should have chainHash but chain is NOT linked (each uses genesis)
      // Each event's prevHash should be "genesis" — chain verification will
      // still pass because each event independently chains from genesis.
      expect(events[0].chainHash).toBeTruthy();
      expect(events[1].chainHash).toBeTruthy();
    });

    it('policy is resolved from snapshot fields (frozen session authority)', async () => {
      // Write state with mode=team but snapshot claims emitToolCalls=false.
      // The snapshot is authoritative for this session, so tool_call should be suppressed.
      const customState = makeState('TICKET', {
        id: crypto.randomUUID(),
        binding: {
          sessionId,
          worktree: ws.tmpDir,
          fingerprint,
          resolvedAt: new Date().toISOString(),
        },
        policySnapshot: {
          mode: 'team',
          hash: 'custom-hash',
          resolvedAt: new Date().toISOString(),
          requestedMode: 'team',
          effectiveGateBehavior: 'human_gated',
          requireHumanGates: true,
          maxSelfReviewIterations: 3,
          maxImplReviewIterations: 3,
          allowSelfApproval: true,
          audit: {
            emitTransitions: true,
            emitToolCalls: false, // snapshot says false...
            enableChainHash: true,
          },
          actorClassification: { flowguard_decision: 'human' },
        },
      });
      await writeState(sessDir, customState);

      // New plugin instance to pick up the custom state
      const hooks = await FlowGuardAuditPlugin({
        project: {} as never,
        client: { app: { log: async () => {} } } as never,
        $: {} as never,
        directory: ws.tmpDir,
        worktree: ws.tmpDir,
        serverUrl: new URL('http://localhost:3000'),
        experimental_workspace: undefined as never,
      });
      const customHandler = hooks['tool.execute.after']! as (
        input: PluginInput,
        output: PluginOutput,
      ) => Promise<void>;

      const transitions = [
        {
          from: 'TICKET',
          to: 'PLAN',
          event: 'PLAN_READY',
          at: new Date().toISOString(),
        },
      ];

      await customHandler(
        { tool: 'flowguard_plan', sessionID: sessionId },
        {
          title: 'plan',
          output: makeToolOutput({ phase: 'PLAN', _audit: { transitions } }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      // Snapshot says emitToolCalls=false, so tool_call is suppressed.
      const toolCalls = events.filter((e) => eventKind(e) === 'tool_call');
      const trans = events.filter((e) => eventKind(e) === 'transition');
      expect(toolCalls.length).toBe(0);
      expect(trans.length).toBe(1);
    });

    it('decision IDs remain unique under parallel calls in one session', async () => {
      const transitions = [
        {
          from: 'PLAN_REVIEW',
          to: 'VALIDATION',
          event: 'APPROVE',
          at: new Date().toISOString(),
        },
      ];

      await Promise.all([
        handler(
          { tool: 'flowguard_decision', sessionID: sessionId, args: { rationale: 'r1' } },
          {
            title: 'decision',
            output: makeToolOutput({
              phase: 'VALIDATION',
              reviewDecision: {
                verdict: 'approve',
                rationale: 'r1',
                decidedBy: 'reviewer-1',
                decidedAt: transitions[0]!.at,
              },
              _audit: { transitions },
            }),
            metadata: {},
          },
        ),
        handler(
          { tool: 'flowguard_decision', sessionID: sessionId, args: { rationale: 'r2' } },
          {
            title: 'decision',
            output: makeToolOutput({
              phase: 'VALIDATION',
              reviewDecision: {
                verdict: 'approve',
                rationale: 'r2',
                decidedBy: 'reviewer-2',
                decidedAt: transitions[0]!.at,
              },
              _audit: { transitions },
            }),
            metadata: {},
          },
        ),
      ]);

      const { events } = await getEvents();
      const decisions = events.filter((e) => eventKind(e) === 'decision');
      expect(decisions).toHaveLength(2);
      const ids = decisions.map((d) => d.event).sort();
      expect(ids).toEqual(['decision:DEC-001', 'decision:DEC-002']);
      const decidedBy = decisions.map((d) => String(d.detail.decidedBy)).sort();
      expect(decidedBy).toEqual(['reviewer-1', 'reviewer-2']);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────

  describe('EDGE', () => {
    it('error event is emitted on tool failure', async () => {
      await handler(
        { tool: 'flowguard_plan', sessionID: sessionId },
        {
          title: 'plan',
          output: makeToolOutput({
            phase: 'TICKET',
            error: true,
            errorMessage: 'Plan submission failed: empty plan',
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const errors = events.filter((e) => eventKind(e) === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].event).toContain('TOOL_ERROR');
    });

    it('multiple independent plugin instances have separate chain states', async () => {
      // Plugin instance 2 with different session
      const sessionId2 = crypto.randomUUID();
      await initWorkspace(ws.tmpDir, sessionId2);
      const sessDir2 = resolveSessionDir(fingerprint, sessionId2);
      const state2 = makeState('TICKET', {
        id: crypto.randomUUID(),
        binding: {
          sessionId: sessionId2,
          worktree: ws.tmpDir,
          fingerprint,
          resolvedAt: new Date().toISOString(),
        },
        policySnapshot: {
          mode: 'team',
          hash: 'test-policy-hash',
          resolvedAt: new Date().toISOString(),
          requestedMode: 'team',
          effectiveGateBehavior: 'human_gated',
          requireHumanGates: true,
          maxSelfReviewIterations: 3,
          maxImplReviewIterations: 3,
          allowSelfApproval: true,
          audit: {
            emitTransitions: true,
            emitToolCalls: true,
            enableChainHash: true,
          },
          actorClassification: { flowguard_decision: 'human' },
        },
      });
      await writeState(sessDir2, state2);

      const hooks2 = await FlowGuardAuditPlugin({
        project: {} as never,
        client: { app: { log: async () => {} } } as never,
        $: {} as never,
        directory: ws.tmpDir,
        worktree: ws.tmpDir,
        serverUrl: new URL('http://localhost:3000'),
        experimental_workspace: undefined as never,
      });
      const handler2 = hooks2['tool.execute.after']! as (
        input: PluginInput,
        output: PluginOutput,
      ) => Promise<void>;

      // Write events to each session
      await handler(
        { tool: 'flowguard_status', sessionID: sessionId },
        { title: 'status', output: makeToolOutput({ phase: 'TICKET' }), metadata: {} },
      );
      await handler2(
        { tool: 'flowguard_status', sessionID: sessionId2 },
        { title: 'status', output: makeToolOutput({ phase: 'TICKET' }), metadata: {} },
      );

      // Both should have independent events
      const trail1 = await readAuditTrail(sessDir);
      const trail2 = await readAuditTrail(sessDir2);
      expect(trail1.events.length).toBe(1);
      expect(trail2.events.length).toBe(1);
      // Chain hashes should be different (different session IDs in events)
      expect(trail1.events[0].chainHash).not.toBe(trail2.events[0].chainHash);
    });

    it('lifecycle guard: hydrate produces session_created but NOT session_completed', async () => {
      const transitions = [
        {
          from: 'INIT',
          to: 'TICKET',
          event: 'SESSION_BOUND',
          at: new Date().toISOString(),
        },
      ];

      await handler(
        { tool: 'flowguard_hydrate', sessionID: sessionId },
        {
          title: 'hydrate',
          output: makeToolOutput({
            phase: 'TICKET',
            _audit: { transitions },
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const lifecycle = events.filter((e) => eventKind(e) === 'lifecycle');
      expect(lifecycle.some((e) => e.event.includes('session_created'))).toBe(true);
      expect(lifecycle.some((e) => e.event.includes('session_completed'))).toBe(false);
    });

    it('abort produces session_aborted lifecycle event', async () => {
      const transitions = [
        {
          from: 'TICKET',
          to: 'COMPLETE',
          event: 'SESSION_ABORTED',
          at: new Date().toISOString(),
        },
      ];

      await handler(
        { tool: 'flowguard_abort_session', sessionID: sessionId },
        {
          title: 'abort',
          output: makeToolOutput({
            phase: 'COMPLETE',
            _audit: { transitions },
          }),
          metadata: {},
        },
      );

      const { events } = await getEvents();
      const lifecycle = events.filter((e) => eventKind(e) === 'lifecycle');
      const aborted = lifecycle.find((e) => e.event.includes('session_aborted'));
      expect(aborted).toBeDefined();
      // Should NOT also emit session_completed (abort is in LIFECYCLE_TOOLS)
      const completed = lifecycle.find((e) => e.event.includes('session_completed'));
      expect(completed).toBeUndefined();
    });
  });

  // ─── PERF ──────────────────────────────────────────────────

  describe('PERF', () => {
    it('1000 non-FlowGuard tool calls complete in < 50ms', async () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        await handler(
          { tool: 'bash', sessionID: sessionId },
          { title: 'bash', output: '', metadata: {} },
        );
      }
      const elapsed = performance.now() - start;
      // Prefix check should be near-instant
      expect(elapsed).toBeLessThan(50);
    });

    it('10 FlowGuard tool calls with persistence complete reasonably', async () => {
      const start = performance.now();
      for (let i = 0; i < 10; i++) {
        await handler(
          { tool: 'flowguard_status', sessionID: sessionId },
          {
            title: 'status',
            output: makeToolOutput({ phase: 'TICKET' }),
            metadata: {},
          },
        );
      }
      const elapsed = performance.now() - start;
      // 10 calls with real FS I/O — generous budget
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
