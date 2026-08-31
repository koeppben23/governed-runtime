/**
 * @module integration/plugin-audit.test
 * @description Direct tests for the plugin audit module.
 *
 * Verifies audit event emission, prevHash threading, failure modes
 * (regulated vs solo), decision receipt handling, and lifecycle events.
 * All deps are injected via makeDeps() — no vi.mock, no Hoisting risk.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readState, writeState } from '../adapters/persistence.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { makeState, REVIEW_APPROVE } from '../fixtures.js';
import { SessionState, type PendingAuditOperation } from '../state/schema.js';
import {
  auditEnforcementDenied,
  reconcilePendingAuditOperations,
  runAudit,
  type AuditDeps,
} from './plugin-audit.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
import {
  buildTransitionBody,
  buildToolCallBody,
  finalizeWithTimestampEvidence,
} from '../audit/types.js';
import { MockTimestampAuthorityProvider } from '../audit/tsa-provider.js';
import type { TimestampAuthorityProvider } from '../audit/tsa-provider.js';
import { PkijsTimestampVerifier } from '../audit/rfc-3161-pkijs-verifier.js';
import { makeRfc3161Fixture, makeRfc3161FixtureAuthority } from '../audit/__fixtures__/rfc3161.js';

class FixtureTimestampAuthorityProvider implements TimestampAuthorityProvider {
  constructor(
    private readonly authority: Awaited<ReturnType<typeof makeRfc3161FixtureAuthority>>,
  ) {}

  async requestTimestamp(input: {
    digest: Uint8Array;
    digestAlgorithm: 'sha256';
    tsaUrl: string;
    timeoutMs: number;
  }): Promise<{ tokenDerBase64: string; receivedAt: string }> {
    const issued = await this.authority.issue({ digest: input.digest });
    return { tokenDerBase64: issued.tokenDerBase64, receivedAt: FIXED_DECISION_AT };
  }
}

// ─── Deps Factory ──────────────────────────────────────────────────────────

let chainSeq: number;

function resetChainSeq(): void {
  chainSeq = 0;
}

function makeDeps(overrides: Partial<AuditDeps> = {}): AuditDeps {
  return {
    resolveFingerprint: vi.fn().mockResolvedValue('fp-abc'),
    getSessionDir: vi.fn().mockReturnValue('/tmp/sess-dir'),
    resolveSessionPolicy: vi.fn().mockResolvedValue({
      policy: {
        audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: true },
        actorClassification: {},
        mode: 'solo',
        requireHumanGates: false,
      },
      state: makeState('PLAN'),
    }),
    initChain: vi.fn().mockResolvedValue('prev-hash-001'),
    invalidateChainState: vi.fn(),
    // Chain-threading contract: appendAndTrack mutates evt.chainHash.
    // plugin-audit.ts reads evt.chainHash! after every call to thread prevHash.
    appendAndTrack: vi.fn(async (evt: Record<string, unknown>) => {
      evt.chainHash = `chain-${String(chainSeq++).padStart(3, '0')}`;
    }),
    nextDecisionSequence: vi.fn().mockResolvedValue(1),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    logError: vi.fn(),
    cachedFingerprint: 'fp-abc',
    mode: 'solo',
    ...overrides,
  };
}

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FIXED_DECISION_AT = '2026-05-15T12:00:00.000Z';

function requireTransition(
  operation: PendingAuditOperation,
): Extract<PendingAuditOperation, { kind: 'transition' }> {
  if (operation.kind !== 'transition') throw new Error('expected transition operation');
  return operation;
}

// ─── H1: Noop ohne Session-Dir ────────────────────────────────────────────

describe('runAudit', () => {
  describe('HAPPY', () => {
    it('returns undefined when no session dir exists', async () => {
      const deps = makeDeps({ getSessionDir: vi.fn().mockReturnValue(null) });

      const result = await runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID);

      expect(result).toBeUndefined();
      expect(deps.initChain).not.toHaveBeenCalled();
      expect(deps.appendAndTrack).not.toHaveBeenCalled();
    });

    it('does not persist audit for an unhydrated host session', async () => {
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: true },
            actorClassification: {},
            mode: 'team',
            requireHumanGates: true,
          },
          state: null,
        }),
      });

      await expect(
        runAudit(deps, 'flowguard_abort_session', {}, {}, SESSION_ID),
      ).resolves.toBeUndefined();
      expect(deps.initChain).not.toHaveBeenCalled();
      expect(deps.appendAndTrack).not.toHaveBeenCalled();
      expect(deps.log.debug).toHaveBeenCalledWith(
        'audit',
        'skipping unhydrated session audit',
        expect.objectContaining({ sessionId: SESSION_ID, tool: 'flowguard_abort_session' }),
      );
    });

    // ─── H2: tool_call emitted ──────────────────────────────────────

    it('emits tool_call event with correct phase and tool name', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = { phase: 'PLAN', error: false };

      await runAudit(deps, 'flowguard_plan', { args: { key: 'val' } }, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'tool_call' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
      const call = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      const detail = call.detail as Record<string, unknown>;
      expect(detail.kind).toBe('tool_call');
      expect(detail.tool).toBe('flowguard_plan');
      expect(call.phase).toBe('PLAN');
    });

    it('records structured blocked codes and messages', async () => {
      resetChainSeq();
      const deps = makeDeps();

      await runAudit(
        deps,
        'flowguard_plan',
        {},
        { error: true, code: 'COMMAND_NOT_ALLOWED', message: 'Plan submission is not allowed.' },
        SESSION_ID,
      );

      const toolCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        detail: Record<string, unknown>;
      };
      expect(toolCall.detail).toMatchObject({
        kind: 'tool_call',
        success: false,
        errorCode: 'COMMAND_NOT_ALLOWED',
        errorMessage: 'Plan submission is not allowed.',
      });
      const error = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
        detail: Record<string, unknown>;
      };
      expect(error.detail).toMatchObject({
        kind: 'error',
        code: 'COMMAND_NOT_ALLOWED',
      });
    });

    it('writes a correlated enforcement denial without weakening the deny path', async () => {
      resetChainSeq();
      const deps = makeDeps();

      await auditEnforcementDenied({
        deps,
        sessionId: SESSION_ID,
        tool: 'bash',
        reasonCode: 'HOST_TOOL_PHASE_DENIED',
        hostCallId: 'call-123',
        traceId: 'call-123',
      });

      const event = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        event: string;
        detail: Record<string, unknown>;
      };
      expect(event.event).toBe('enforcement:denied');
      expect(event.detail).toMatchObject({
        kind: 'enforcement_denied',
        tool: 'bash',
        reasonCode: 'HOST_TOOL_PHASE_DENIED',
        hostCallId: 'call-123',
      });
    });

    it('emits chained audit events even when policy enableChainHash is false', async () => {
      resetChainSeq();
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: false },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state: makeState('TICKET'),
        }),
      });

      await runAudit(
        deps,
        'flowguard_plan',
        { args: { key: 'val' } },
        { phase: 'PLAN' },
        SESSION_ID,
      );

      expect(deps.initChain).toHaveBeenCalledWith('/tmp/sess-dir', SESSION_ID);
      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ prevHash: 'prev-hash-001', chainHash: 'chain-000' }),
        '/tmp/sess-dir',
        false,
        SESSION_ID,
      );
    });

    // ─── H3: tool_call NOT emitted when disabled ────────────────────

    it('does NOT emit tool_call when emitToolCalls is false', async () => {
      resetChainSeq();
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state: makeState('TICKET'),
        }),
      });
      const output = { phase: 'PLAN', error: false };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).not.toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'tool_call' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
    });

    // ─── H4: transitions + prevHash threading ───────────────────────

    it('does not derive persisted transition audits from tool output', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        phase: 'PLAN',
        error: false,
        _audit: {
          transitions: [
            {
              event: 'PLAN_READY',
              from: 'TICKET',
              to: 'PLAN',
              at: FIXED_DECISION_AT,
            },
          ],
        },
      };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      const calls = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls;

      expect(calls).toHaveLength(1);
      expect(
        ((calls[0]![0] as Record<string, unknown>).detail as Record<string, unknown>).kind,
      ).toBe('tool_call');
    });

    // ─── H4b: metadata.transitions channel (contract gate) ───────────

    it('ignores transition-shaped metadata from tool output', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        title: 'flowguard_plan',
        output: JSON.stringify({ phase: 'PLAN', error: false }),
        metadata: {
          transitions: [
            {
              event: 'PLAN_READY',
              from: 'TICKET',
              to: 'PLAN',
              at: FIXED_DECISION_AT,
            },
          ],
        },
      };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledTimes(1);
    });

    it('ignores legacy _audit.transitions from tool output', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        title: 'flowguard_plan',
        output: JSON.stringify({
          phase: 'PLAN',
          error: false,
          _audit: {
            transitions: [
              { event: 'PLAN_READY', from: 'TICKET', to: 'PLAN', at: FIXED_DECISION_AT },
            ],
          },
        }),
      };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledTimes(1);
    });

    it('does not prefer either output transition channel', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        title: 'flowguard_plan',
        output: JSON.stringify({
          phase: 'PLAN',
          error: false,
          _audit: { transitions: [{ event: 'LEGACY', from: 'X', to: 'Y', at: FIXED_DECISION_AT }] },
        }),
        metadata: {
          transitions: [{ event: 'PLAN_READY', from: 'TICKET', to: 'PLAN', at: FIXED_DECISION_AT }],
        },
      };

      await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledTimes(1);
    });

    // ─── H5: hydrate lifecycle + reason string ──────────────────────

    it('emits session_created lifecycle for flowguard_hydrate with reason', async () => {
      resetChainSeq();
      const deps = makeDeps();
      const output = {
        phase: 'TICKET',
        error: false,
        policyResolution: {
          requestedMode: 'regulated',
          effectiveMode: 'solo',
          source: 'local',
          reason: 'degraded',
        },
      };

      await runAudit(deps, 'flowguard_hydrate', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'lifecycle' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
      const lifecycleCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => {
          const evtDetail = (c[0] as Record<string, unknown>).detail as Record<string, unknown>;
          return evtDetail?.kind === 'lifecycle';
        },
      );
      const lifecycleEvent = lifecycleCall![0] as Record<string, unknown>;
      const detail = lifecycleEvent.detail as Record<string, unknown>;
      expect(detail.action).toBe('session_created');
      expect(detail.reason).toEqual(expect.stringContaining('requested_mode'));
      expect(detail.reason).toEqual(expect.stringContaining('effective_mode'));
      expect(detail.reason).toEqual(expect.stringContaining('requested_mode:regulated'));
      expect(detail.reason).toEqual(expect.stringContaining('effective_mode:solo'));
    });
  });

  // ─── BAD ──────────────────────────────────────────────────────────────

  describe('BAD', () => {
    beforeEach(() => {
      resetChainSeq();
    });

    // ─── B1: Append-Fehler in regulated → block ────────────────────

    it('blocks with AUDIT_PERSISTENCE_FAILED in regulated mode', async () => {
      const deps = makeDeps({
        mode: 'regulated',
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: true, emitTransitions: false, enableChainHash: true },
            actorClassification: {},
            mode: 'regulated',
            requireHumanGates: false,
          },
          state: makeState('TICKET'),
        }),
        appendAndTrack: vi.fn().mockRejectedValue(new Error('disk full')),
      });
      const output = { phase: 'TICKET', error: false };

      const result = await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(result).toEqual({
        auditOk: false,
        block: true,
        code: 'AUDIT_PERSISTENCE_FAILED',
        reason: 'disk full',
      });
    });

    // ─── B2: Append-Fehler in solo → warn ─────────────────────────

    it('warns and returns undefined in solo mode', async () => {
      const deps = makeDeps({
        mode: 'solo',
        appendAndTrack: vi.fn().mockRejectedValue(new Error('disk full')),
      });
      const output = { phase: 'TICKET', error: false };

      const result = await runAudit(deps, 'flowguard_plan', {}, output, SESSION_ID);

      expect(result).toBeUndefined();
      expect(deps.logError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write audit events'),
        expect.any(Error),
      );
    });

    // ─── B3: resolveSessionPolicy throws → block even in solo ─────

    it('blocks when resolveSessionPolicy throws, even in solo mode', async () => {
      const deps = makeDeps({
        mode: 'solo',
        resolveSessionPolicy: vi.fn().mockRejectedValue(new Error('policy read failure')),
      });

      const result = await runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID);

      expect(result).toMatchObject({
        auditOk: false,
        block: true,
        code: 'AUDIT_PERSISTENCE_FAILED',
      });
    });

    it('strict TSA failure on critical event records evidence and enters session ERROR', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-strict-tsa-'));
      try {
        const state = makeState('TICKET', {
          policySnapshot: {
            ...makeState('TICKET').policySnapshot,
            mode: 'regulated',
            audit: {
              ...makeState('TICKET').policySnapshot.audit,
              timestampAssurance: {
                enabled: true,
                mode: 'tsa_critical',
                strict: true,
                criticalEvents: ['lifecycle'],
                tsaUrl: 'https://tsa.example.test',
                trustAnchors: ['pem'],
                ntpServers: ['pool.ntp.org'],
                ntpDriftThresholdMs: 30000,
                tsaTimeoutMs: 10000,
              },
            },
          },
        });
        await writeState(sessDir, state);
        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: {
                emitToolCalls: false,
                emitTransitions: false,
                enableChainHash: true,
                timestampAssurance: state.policySnapshot.audit.timestampAssurance,
              },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state,
          }),
          tsaProvider: new MockTimestampAuthorityProvider({ simulateFailure: true }),
        });

        const result = await runAudit(
          deps,
          'flowguard_hydrate',
          {},
          { phase: 'TICKET', error: false },
          SESSION_ID,
        );

        expect(result).toMatchObject({
          block: true,
          code: 'TSA_TIMESTAMP_ASSURANCE_FAILED',
        });
        expect(deps.appendAndTrack).toHaveBeenCalledWith(
          expect.objectContaining({
            timestampEvidence: expect.objectContaining({ status: 'tsa_failed' }),
          }),
          sessDir,
          true,
          SESSION_ID,
        );
        const persisted = await readState(sessDir);
        expect(persisted?.error?.code).toBe('TSA_TIMESTAMP_ASSURANCE_FAILED');
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('strict TSA success records real verified timestamp evidence on lifecycle event', async () => {
      const authority = await makeRfc3161FixtureAuthority();
      const state = makeState('TICKET', {
        policySnapshot: {
          ...makeState('TICKET').policySnapshot,
          mode: 'regulated',
          audit: {
            ...makeState('TICKET').policySnapshot.audit,
            timestampAssurance: {
              enabled: true,
              mode: 'tsa_critical',
              strict: true,
              criticalEvents: ['lifecycle'],
              tsaUrl: 'https://tsa.example.test',
              trustAnchors: [authority.trustAnchorPem],
              ntpServers: ['pool.ntp.org'],
              ntpDriftThresholdMs: 30000,
              tsaTimeoutMs: 10000,
            },
          },
        },
      });
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: {
              emitToolCalls: false,
              emitTransitions: false,
              enableChainHash: true,
              timestampAssurance: state.policySnapshot.audit.timestampAssurance,
            },
            actorClassification: {},
            mode: 'regulated',
            requireHumanGates: true,
          },
          state,
        }),
        tsaProvider: new FixtureTimestampAuthorityProvider(authority),
        timestampVerifier: new PkijsTimestampVerifier(),
      });

      const result = await runAudit(
        deps,
        'flowguard_hydrate',
        {},
        { phase: 'TICKET', error: false },
        SESSION_ID,
      );

      expect(result).toBeUndefined();
      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          timestampEvidence: expect.objectContaining({
            status: 'tsa_stamped',
            tsa: expect.objectContaining({ verificationStatus: 'valid' }),
          }),
        }),
        expect.any(String),
        true,
        SESSION_ID,
      );
    });

    it('non-strict TSA failure preserves Slice 1 behavior without session ERROR', async () => {
      const state = makeState('TICKET');
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: {
              emitToolCalls: false,
              emitTransitions: false,
              enableChainHash: true,
              timestampAssurance: {
                enabled: true,
                mode: 'tsa_critical',
                strict: false,
                criticalEvents: ['lifecycle'],
                tsaUrl: 'https://tsa.example.test',
                trustAnchors: ['pem'],
                ntpServers: ['pool.ntp.org'],
                ntpDriftThresholdMs: 30000,
                tsaTimeoutMs: 10000,
              },
            },
            actorClassification: {},
            mode: 'regulated',
            requireHumanGates: true,
          },
          state,
        }),
        tsaProvider: new MockTimestampAuthorityProvider({ simulateFailure: true }),
      });

      const result = await runAudit(
        deps,
        'flowguard_hydrate',
        {},
        { phase: 'TICKET', error: false },
        SESSION_ID,
      );

      expect(result).toBeUndefined();
      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          timestampEvidence: expect.objectContaining({ status: 'tsa_failed' }),
        }),
        expect.any(String),
        true,
        SESSION_ID,
      );
    });

    // ─── B4: missing decidedBy → error event ──────────────────────

    it('emits error event when decidedBy is missing in flowguard_decision', async () => {
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: true },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state: makeState('PLAN_REVIEW', {
            transition: {
              event: 'APPROVE',
              from: 'PLAN_REVIEW',
              to: 'PLAN',
              at: FIXED_DECISION_AT,
            },
          }),
        }),
      });
      const output = {
        phase: 'PLAN_REVIEW',
        error: false,
        _audit: {
          transitions: [
            { event: 'APPROVE', from: 'PLAN_REVIEW', to: 'PLAN', at: FIXED_DECISION_AT },
          ],
        },
        reviewDecision: {
          rationale: 'looks good',
          decidedAt: FIXED_DECISION_AT,
          // decidedBy intentionally missing
        },
      };

      await runAudit(deps, 'flowguard_decision', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'error' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
      const errorCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => {
          const evtDetail = (c[0] as Record<string, unknown>).detail as Record<string, unknown>;
          return evtDetail?.kind === 'error';
        },
      );
      const errorDetail = (errorCall![0] as Record<string, unknown>).detail as Record<
        string,
        unknown
      >;
      expect(errorDetail.code).toBe('DECISION_RECEIPT_ACTOR_MISSING');
    });
  });

  // ─── D: decision receipt verdict branches ────────────────────────────────

  describe('decision receipts', () => {
    const decidedBy = 'opencode/big-pickle';

    function decisionDeps(state: SessionState, overrides: Partial<AuditDeps> = {}): AuditDeps {
      return makeDeps({
        ...overrides,
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: true },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state,
        }),
      });
    }

    function decisionEvent(deps: AuditDeps): Record<string, unknown> {
      const call = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind ===
          'decision',
      );
      return call![0] as Record<string, unknown>;
    }

    beforeEach(() => {
      resetChainSeq();
    });

    it('emits a changes_requested decision event', async () => {
      const state = makeState('PLAN_REVIEW', {
        transition: {
          from: 'PLAN_REVIEW',
          to: 'PLAN',
          event: 'CHANGES_REQUESTED',
          at: FIXED_DECISION_AT,
        },
      });
      const deps = decisionDeps(state);

      await runAudit(
        deps,
        'flowguard_decision',
        {},
        {
          phase: 'PLAN_REVIEW',
          error: false,
          reviewDecision: { decidedBy, rationale: 'revise', decidedAt: FIXED_DECISION_AT },
        },
        SESSION_ID,
      );

      const detail = decisionEvent(deps).detail as Record<string, unknown>;
      expect(detail.verdict).toBe('changes_requested');
    });

    it('emits a reject decision event', async () => {
      const state = makeState('PLAN_REVIEW', {
        transition: {
          from: 'PLAN_REVIEW',
          to: 'TICKET',
          event: 'REJECT',
          at: FIXED_DECISION_AT,
        },
      });
      const deps = decisionDeps(state);

      await runAudit(
        deps,
        'flowguard_decision',
        {},
        {
          phase: 'PLAN_REVIEW',
          error: false,
          reviewDecision: { decidedBy, rationale: 'start over', decidedAt: FIXED_DECISION_AT },
        },
        SESSION_ID,
      );

      const detail = decisionEvent(deps).detail as Record<string, unknown>;
      expect(detail.verdict).toBe('reject');
    });

    it('resolves rationale from input.args when no structured decision exists', async () => {
      const state = makeState('PLAN_REVIEW', {
        transition: { from: 'PLAN_REVIEW', to: 'PLAN', event: 'APPROVE', at: FIXED_DECISION_AT },
      });
      const deps = decisionDeps(state);

      await runAudit(
        deps,
        'flowguard_decision',
        { args: { rationale: 'arg rationale' } },
        { phase: 'PLAN_REVIEW', error: false, reviewDecision: { decidedBy } },
        SESSION_ID,
      );

      const detail = decisionEvent(deps).detail as Record<string, unknown>;
      expect(detail.rationale).toBe('arg rationale');
      expect(detail.decidedAt).toBe(FIXED_DECISION_AT);
    });

    it('resolves decidedBy from persisted reviewDecision when output lacks it', async () => {
      const state = makeState('PLAN_REVIEW', {
        transition: { from: 'PLAN_REVIEW', to: 'PLAN', event: 'APPROVE', at: FIXED_DECISION_AT },
        reviewDecision: { ...REVIEW_APPROVE, decidedAt: FIXED_DECISION_AT },
      });
      const deps = decisionDeps(state);

      await runAudit(
        deps,
        'flowguard_decision',
        {},
        { phase: 'PLAN_REVIEW', error: false },
        SESSION_ID,
      );

      const detail = decisionEvent(deps).detail as Record<string, unknown>;
      expect(detail.decidedBy).toBe(REVIEW_APPROVE.decidedBy);
      expect(detail.decidedAt).toBe(FIXED_DECISION_AT);
    });

    it('skips the decision receipt when the tool call failed', async () => {
      const state = makeState('PLAN_REVIEW', {
        transition: { from: 'PLAN_REVIEW', to: 'PLAN', event: 'APPROVE', at: FIXED_DECISION_AT },
      });
      const deps = decisionDeps(state);

      await runAudit(
        deps,
        'flowguard_decision',
        {},
        { phase: 'PLAN_REVIEW', error: true, reviewDecision: { decidedBy } },
        SESSION_ID,
      );

      expect(
        (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.every(
          (c: unknown[]) =>
            ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind !==
            'decision',
        ),
      ).toBe(true);
    });

    it('never emits a decision receipt for non-decision tools', async () => {
      const state = makeState('PLAN', {
        transition: { from: 'PLAN_REVIEW', to: 'PLAN', event: 'APPROVE', at: FIXED_DECISION_AT },
      });
      const deps = decisionDeps(state);

      await runAudit(
        deps,
        'flowguard_plan',
        {},
        { phase: 'PLAN', error: false, reviewDecision: { decidedBy } },
        SESSION_ID,
      );

      expect(
        (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.every(
          (c: unknown[]) =>
            ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind !==
            'decision',
        ),
      ).toBe(true);
    });

    it('skips the decision receipt when the state has no transition', async () => {
      const deps = decisionDeps(makeState('PLAN_REVIEW'));

      await runAudit(
        deps,
        'flowguard_decision',
        {},
        { phase: 'PLAN_REVIEW', error: false, reviewDecision: { decidedBy } },
        SESSION_ID,
      );

      expect(
        (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.every(
          (c: unknown[]) =>
            ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind !==
            'decision',
        ),
      ).toBe(true);
    });

    it('emits the actor-missing error for a whitespace-only decidedBy', async () => {
      const state = makeState('PLAN_REVIEW', {
        transition: { from: 'PLAN_REVIEW', to: 'PLAN', event: 'APPROVE', at: FIXED_DECISION_AT },
      });
      const deps = decisionDeps(state);

      await runAudit(
        deps,
        'flowguard_decision',
        {},
        {
          phase: 'PLAN_REVIEW',
          error: false,
          reviewDecision: { decidedBy: '   ', rationale: 'x', decidedAt: FIXED_DECISION_AT },
        },
        SESSION_ID,
      );

      const errorCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind === 'error',
      );
      expect(
        ((errorCall![0] as Record<string, unknown>).detail as Record<string, unknown>).code,
      ).toBe('DECISION_RECEIPT_ACTOR_MISSING');
    });

    it('skips the receipt for a non-verdict transition event', async () => {
      const state = makeState('PLAN_REVIEW', {
        transition: {
          from: 'PLAN',
          to: 'PLAN_REVIEW',
          event: 'SELF_REVIEW_MET',
          at: FIXED_DECISION_AT,
        },
      });
      const deps = decisionDeps(state);

      await runAudit(
        deps,
        'flowguard_decision',
        {},
        { phase: 'PLAN_REVIEW', error: false, reviewDecision: { decidedBy } },
        SESSION_ID,
      );

      expect(
        (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.every(
          (c: unknown[]) =>
            ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind !==
            'decision',
        ),
      ).toBe(true);
    });
  });

  // ─── E: session completion + auto-archive ────────────────────────────────

  describe('session completion and auto-archive', () => {
    beforeEach(() => {
      resetChainSeq();
    });

    function completionDeps(
      sessDir: string,
      state: SessionState,
      overrides: Partial<AuditDeps> = {},
    ): AuditDeps {
      return makeDeps({
        ...overrides,
        getSessionDir: vi.fn().mockReturnValue(sessDir),
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: true },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state,
        }),
      });
    }

    function completeState(overrides: Partial<SessionState> = {}): SessionState {
      const state = makeState('COMPLETE', {
        transition: {
          from: 'EVIDENCE_REVIEW',
          to: 'COMPLETE',
          event: 'IMPL_COMPLETE',
          at: FIXED_DECISION_AT,
        },
        ...overrides,
      });
      const transition = state.transition!;
      const operation: Extract<PendingAuditOperation, { kind: 'transition' }> = {
        kind: 'transition',
        operationId: 'bbbbbbbb-0000-4000-8000-000000000001',
        preStateDigest: 'a'.repeat(64),
        mutationDigest: 'b'.repeat(64),
        postStateDigest: 'c'.repeat(64),
        auditEventDigest: 'd'.repeat(64),
        status: 'reconciled',
        transition: { ...transition, chainIndex: 0, autoAdvanced: false },
      };
      return { ...state, pendingAuditOperations: [...state.pendingAuditOperations, operation] };
    }

    it('emits session_completed lifecycle and archives in solo mode', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-complete-'));
      try {
        const state = completeState({
          policySnapshot: { ...completeState().policySnapshot, mode: 'solo' as const },
        });
        await writeState(sessDir, state);
        const deps = completionDeps(sessDir, state, { cachedFingerprint: 'fp-abc' });

        await runAudit(deps, 'flowguard_plan', {}, { phase: 'COMPLETE', error: false }, SESSION_ID);

        const lifecycleCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) =>
            ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind ===
            'lifecycle',
        );
        expect(lifecycleCall).toBeDefined();
        // The archive attempt is fire-and-forget; its failure surfaces via warn.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(deps.log.warn).toHaveBeenCalledWith(
          'audit',
          'auto-archive failed',
          expect.any(Object),
        );
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('skips auto-archive in team mode', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-complete-'));
      try {
        const teamState = completeState({
          policySnapshot: { ...completeState().policySnapshot, mode: 'team' as const },
        });
        await writeState(sessDir, teamState);
        const deps = completionDeps(sessDir, teamState, { cachedFingerprint: 'fp-abc' });

        await runAudit(deps, 'flowguard_plan', {}, { phase: 'COMPLETE', error: false }, SESSION_ID);

        const lifecycleCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) =>
            ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind ===
            'lifecycle',
        );
        expect(lifecycleCall).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(deps.log.warn).not.toHaveBeenCalled();
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('skips session_completed when the tool layer already archived', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-complete-'));
      try {
        const state = completeState({
          archiveStatus: 'created',
          policySnapshot: { ...completeState().policySnapshot, mode: 'solo' as const },
        });
        await writeState(sessDir, state);
        const deps = completionDeps(sessDir, state, { cachedFingerprint: 'fp-abc' });

        await runAudit(deps, 'flowguard_plan', {}, { phase: 'COMPLETE', error: false }, SESSION_ID);

        expect(
          (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.every(
            (c: unknown[]) =>
              ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind !==
              'lifecycle',
          ),
        ).toBe(true);
        expect(deps.log.debug).toHaveBeenCalledWith(
          'audit',
          'session_completed handled by tool layer',
          expect.any(Object),
        );
        expect(deps.log.debug).toHaveBeenCalledWith(
          'audit',
          'archive handled by tool layer',
          expect.any(Object),
        );
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('emits session_completed even without a cached fingerprint', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-complete-'));
      try {
        const state = completeState();
        await writeState(sessDir, state);
        const deps = completionDeps(sessDir, state, { cachedFingerprint: null });

        await runAudit(deps, 'flowguard_plan', {}, { phase: 'COMPLETE', error: false }, SESSION_ID);

        const lifecycleCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) =>
            ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind ===
            'lifecycle',
        );
        expect(lifecycleCall).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(deps.log.warn).not.toHaveBeenCalled();
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('does not emit session_completed for lifecycle tools themselves', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-complete-'));
      try {
        const state = completeState();
        await writeState(sessDir, state);
        const deps = completionDeps(sessDir, state, { cachedFingerprint: 'fp-abc' });

        await runAudit(
          deps,
          'flowguard_hydrate',
          {},
          { phase: 'COMPLETE', error: false },
          SESSION_ID,
        );

        const hydrateLifecycle = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) =>
            ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind ===
            'lifecycle',
        );
        expect(
          ((hydrateLifecycle![0] as Record<string, unknown>).detail as Record<string, unknown>)
            .action,
        ).toBe('session_created');
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────────────────

  describe('CORNER', () => {
    beforeEach(() => {
      resetChainSeq();
    });

    it('counts only transitions emitted by the current tool call', async () => {
      resetChainSeq();
      const unreconciledA = {
        kind: 'transition',
        operationId: 'cccccccc-0000-4000-8000-000000000001',
        preStateDigest: 'a'.repeat(64),
        mutationDigest: 'b'.repeat(64),
        postStateDigest: 'c'.repeat(64),
        auditEventDigest: 'd'.repeat(64),
        transition: {
          from: 'TICKET',
          to: 'PLAN',
          event: 'PLAN_READY',
          at: FIXED_DECISION_AT,
          chainIndex: 0,
          autoAdvanced: false,
        },
        status: 'state_committed',
      } as const;
      const state = makeState('PLAN', {
        pendingAuditOperations: [unreconciledA],
      });
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: true, emitTransitions: false, enableChainHash: true },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state,
        }),
      });

      await runAudit(
        deps,
        'flowguard_plan',
        { input: {} },
        {
          output: JSON.stringify({ phase: 'PLAN', error: false }),
          metadata: { transitions: [unreconciledA.transition, unreconciledA.transition] },
        },
        SESSION_ID,
      );

      const toolCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind ===
          'tool_call',
      );
      const detail = (toolCall![0] as Record<string, unknown>).detail as Record<string, unknown>;
      expect(detail.transitionCount).toBe(2);
    });

    it('summarizes the nested input object of the tool call payload', async () => {
      resetChainSeq();
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: true, emitTransitions: false, enableChainHash: true },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state: makeState('PLAN'),
        }),
      });

      await runAudit(
        deps,
        'flowguard_plan',
        { input: { key: 'val', nested: { a: 1 } } },
        { phase: 'PLAN', error: false },
        SESSION_ID,
      );

      const toolCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) =>
          ((c[0] as Record<string, unknown>).detail as Record<string, unknown>)?.kind ===
          'tool_call',
      );
      const detail = (toolCall![0] as Record<string, unknown>).detail as Record<string, unknown>;
      const argsSummary = detail.argsSummary as Record<string, string>;
      expect(argsSummary.input).toBe('[Object]');
    });

    // ─── C1: decision receipt with decidedBy ───────────────────────
    // Decision receipts are emitted independently from transition audit emission.

    it('emits decision event for flowguard_decision with decidedBy present', async () => {
      const deps = makeDeps({
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: true },
            actorClassification: {},
            mode: 'solo',
            requireHumanGates: false,
          },
          state: makeState('PLAN_REVIEW', {
            transition: {
              event: 'APPROVE',
              from: 'PLAN_REVIEW',
              to: 'PLAN',
              at: FIXED_DECISION_AT,
            },
          }),
        }),
      });
      const output = {
        phase: 'PLAN_REVIEW',
        error: false,
        _audit: {
          transitions: [
            { event: 'APPROVE', from: 'PLAN_REVIEW', to: 'PLAN', at: FIXED_DECISION_AT },
          ],
        },
        reviewDecision: {
          decidedBy: 'opencode/big-pickle',
          rationale: 'looks good',
          decidedAt: FIXED_DECISION_AT,
        },
      };

      await runAudit(deps, 'flowguard_decision', {}, output, SESSION_ID);

      expect(deps.appendAndTrack).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ kind: 'decision' }) }),
        expect.any(String),
        true,
        SESSION_ID,
      );
      const decisionCall = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => {
          const evtDetail = (c[0] as Record<string, unknown>).detail as Record<string, unknown>;
          return evtDetail?.kind === 'decision';
        },
      );
      const detail = (decisionCall![0] as Record<string, unknown>).detail as Record<
        string,
        unknown
      >;
      expect(detail.verdict).toBe('approve');
      expect(detail.decisionSequence).toBe(1);
    });

    it('reconciles an append committed before its acknowledgement without duplicating it', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-outbox-'));
      try {
        const initial = makeState('TICKET', { id: SESSION_ID });
        await writeState(sessDir, initial);
        await writeStateWithArtifactsAndAuditOperations(
          sessDir,
          makeState('PLAN', {
            id: SESSION_ID,
            transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
          }),
          [{ from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT }],
        );
        const pending = await readState(sessDir);
        const operation = requireTransition(pending!.pendingAuditOperations[0]!);
        const body = buildTransitionBody(
          pending!.flowguardSessionId,
          pending!.binding.hostSessionId,
          operation.transition.to,
          {
            operationId: operation.operationId,
            preStateDigest: operation.preStateDigest,
            mutationDigest: operation.mutationDigest,
            postStateDigest: operation.postStateDigest,
            from: operation.transition.from,
            to: operation.transition.to,
            event: operation.transition.event,
            autoAdvanced: operation.transition.autoAdvanced,
            chainIndex: operation.transition.chainIndex,
          },
          operation.transition.at,
          'genesis',
        );
        await appendAuditEvent(sessDir, finalizeWithTimestampEvidence(body, 'genesis'));

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state: pending,
          }),
        });

        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan'),
        ).resolves.toBeUndefined();
        expect(deps.appendAndTrack).not.toHaveBeenCalled();
        expect((await readState(sessDir))!.pendingAuditOperations[0]!.status).toBe('reconciled');
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('emits transition events that bind the state-authority digests', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-outbox-'));
      try {
        const initial = makeState('TICKET', { id: SESSION_ID });
        await writeState(sessDir, initial);
        await writeStateWithArtifactsAndAuditOperations(
          sessDir,
          makeState('PLAN', {
            id: SESSION_ID,
            transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
          }),
          [{ from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT }],
        );
        const pending = await readState(sessDir);
        const operation = requireTransition(pending!.pendingAuditOperations[0]!);

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state: pending,
          }),
          appendAndTrack: vi.fn(async () => {}),
        });

        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan'),
        ).resolves.toBeUndefined();
        const emitted = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock
          .calls[0]![0] as Record<string, unknown>;
        const detail = emitted.detail as Record<string, unknown>;
        expect(detail.operationId).toBe(operation.operationId);
        expect(detail.preStateDigest).toBe(operation.preStateDigest);
        expect(detail.mutationDigest).toBe(operation.mutationDigest);
        expect(detail.postStateDigest).toBe(operation.postStateDigest);
        expect((await readState(sessDir))!.pendingAuditOperations[0]!.status).toBe('reconciled');
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('reconciles a same-phase authority write with durable state digests', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-state-write-outbox-'));
      try {
        const initial = makeState('PLAN', { id: SESSION_ID });
        await writeState(sessDir, initial);
        await writeStateWithArtifactsAndAuditOperations(sessDir, {
          ...initial,
          activeChecks: ['typecheck'],
        });
        const pending = await readState(sessDir);
        const operation = pending!.pendingAuditOperations[0]!;
        expect(operation.kind).toBe('state_write');

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state: pending,
          }),
          appendAndTrack: vi.fn(async () => {}),
        });

        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_status'),
        ).resolves.toBeUndefined();
        const event = (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
          detail: Record<string, unknown>;
        };
        expect(event.detail).toMatchObject({
          kind: 'state_write',
          operationId: operation.operationId,
          preStateDigest: operation.preStateDigest,
          postStateDigest: operation.postStateDigest,
        });
        expect((await readState(sessDir))!.pendingAuditOperations[0]!.status).toBe('reconciled');
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('refuses to reconcile an operation whose state digests were tampered after append', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-outbox-'));
      try {
        const initial = makeState('TICKET', { id: SESSION_ID });
        await writeState(sessDir, initial);
        await writeStateWithArtifactsAndAuditOperations(
          sessDir,
          makeState('PLAN', {
            id: SESSION_ID,
            transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
          }),
          [{ from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT }],
        );
        const pending = await readState(sessDir);
        const operation = requireTransition(pending!.pendingAuditOperations[0]!);
        const body = buildTransitionBody(
          SESSION_ID,
          undefined,
          operation.transition.to,
          {
            operationId: operation.operationId,
            preStateDigest: operation.preStateDigest,
            mutationDigest: operation.mutationDigest,
            postStateDigest: operation.postStateDigest,
            from: operation.transition.from,
            to: operation.transition.to,
            event: operation.transition.event,
            autoAdvanced: operation.transition.autoAdvanced,
            chainIndex: operation.transition.chainIndex,
          },
          operation.transition.at,
          'genesis',
        );
        await appendAuditEvent(sessDir, finalizeWithTimestampEvidence(body, 'genesis'));

        // Crash before acknowledgement, then tamper the persisted operation:
        // operationId and auditEventDigest stay untouched, only postStateDigest
        // changes. Reconciliation must fail closed, not mark the operation
        // reconciled.
        const tampered: SessionState = {
          ...pending!,
          pendingAuditOperations: [
            {
              ...operation,
              postStateDigest: 'b'.repeat(64),
            },
          ],
        };
        await writeState(sessDir, tampered);

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state: tampered,
          }),
        });

        const result = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');
        expect(result?.block).toBe(true);
        expect(result?.code).toBe('AUDIT_PERSISTENCE_FAILED');
        expect((await readState(sessDir))!.pendingAuditOperations[0]!.status).toBe(
          'state_committed',
        );
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('blocks with AUDIT_TRANSITION_EVIDENCE_GAP for a legacy state without audit evidence', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-gap-'));
      try {
        const legacy = makeState('PLAN', {
          id: SESSION_ID,
          transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
          pendingAuditOperations: [],
        });
        await writeState(sessDir, legacy);
        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'solo',
              requireHumanGates: false,
            },
            state: legacy,
          }),
        });

        const result = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');
        expect(result).toMatchObject({ block: true, code: 'AUDIT_TRANSITION_EVIDENCE_GAP' });
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('accepts a legacy state whose transition has contemporaneous audit evidence', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-gap-'));
      try {
        const transition = {
          from: 'TICKET',
          to: 'PLAN',
          event: 'PLAN_READY',
          at: FIXED_DECISION_AT,
        } as const;
        const legacy = makeState('PLAN', {
          id: SESSION_ID,
          transition,
          pendingAuditOperations: [],
        });
        await writeState(sessDir, legacy);
        const body = buildTransitionBody(
          SESSION_ID,
          undefined,
          transition.to,
          {
            from: transition.from,
            to: transition.to,
            event: transition.event,
            autoAdvanced: false,
            chainIndex: 0,
          },
          transition.at,
          'genesis',
        );
        await appendAuditEvent(sessDir, finalizeWithTimestampEvidence(body, 'genesis'));

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'solo',
              requireHumanGates: false,
            },
            state: legacy,
          }),
          appendAndTrack: vi.fn(async () => {}),
        });

        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan'),
        ).resolves.toBeUndefined();
        expect(deps.appendAndTrack).not.toHaveBeenCalled();
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('blocks a legacy gap when a decoy transition event matches only partially', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-gap-'));
      try {
        const transition = {
          from: 'TICKET',
          to: 'PLAN',
          event: 'PLAN_READY',
          at: FIXED_DECISION_AT,
        } as const;
        const legacy = makeState('PLAN', {
          id: SESSION_ID,
          transition,
          pendingAuditOperations: [],
        });
        await writeState(sessDir, legacy);
        // Same kind/from/event/at, different `to` — must NOT count as evidence.
        const decoy = buildTransitionBody(
          SESSION_ID,
          undefined,
          'PLAN_REVIEW',
          {
            from: transition.from,
            to: 'PLAN_REVIEW',
            event: transition.event,
            autoAdvanced: false,
            chainIndex: 0,
          },
          transition.at,
          'genesis',
        );
        await appendAuditEvent(sessDir, finalizeWithTimestampEvidence(decoy, 'genesis'));
        // Same transition fields but a different event kind — must NOT count.
        const decoyToolCall = buildToolCallBody({
          flowguardSessionId: SESSION_ID,
          phase: 'PLAN',
          detail: {
            tool: 'flowguard_plan',
            argsSummary: {},
            success: true,
            transitionCount: 0,
          },
          occurredAt: transition.at,
          actor: 'machine',
          prevHash: 'genesis',
        });
        await appendAuditEvent(sessDir, finalizeWithTimestampEvidence(decoyToolCall, 'genesis'));

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'solo',
              requireHumanGates: false,
            },
            state: legacy,
          }),
        });

        const result = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');
        expect(result).toMatchObject({ block: true, code: 'AUDIT_TRANSITION_EVIDENCE_GAP' });
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('blocks a legacy gap when the audit trail is unreadable', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-gap-'));
      try {
        const legacy = makeState('PLAN', {
          id: SESSION_ID,
          transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
          pendingAuditOperations: [],
        });
        await writeState(sessDir, legacy);
        await fs.writeFile(path.join(sessDir, 'audit.jsonl'), '{ malformed json\n', 'utf8');
        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'solo',
              requireHumanGates: false,
            },
            state: legacy,
          }),
        });

        const result = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');
        expect(result).toMatchObject({ block: true, code: 'AUDIT_PERSISTENCE_FAILED' });
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('blocks when the committed auditEventDigest no longer matches the operation', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-outbox-'));
      try {
        const initial = makeState('TICKET', { id: SESSION_ID });
        await writeState(sessDir, initial);
        await writeStateWithArtifactsAndAuditOperations(
          sessDir,
          makeState('PLAN', {
            id: SESSION_ID,
            transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
          }),
          [{ from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT }],
        );
        const pending = await readState(sessDir);
        const operation = requireTransition(pending!.pendingAuditOperations[0]!);
        const tampered: SessionState = {
          ...pending!,
          pendingAuditOperations: [{ ...operation, auditEventDigest: 'e'.repeat(64) }],
        };
        await writeState(sessDir, tampered);

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state: tampered,
          }),
          appendAndTrack: vi.fn(async () => {}),
        });

        const result = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');
        expect(result?.block).toBe(true);
        expect(deps.appendAndTrack).not.toHaveBeenCalled();
        expect((await readState(sessDir))!.pendingAuditOperations[0]!.status).toBe(
          'state_committed',
        );
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('blocks when an appended event with the same operation id has different content', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-outbox-'));
      try {
        const initial = makeState('TICKET', { id: SESSION_ID });
        await writeState(sessDir, initial);
        await writeStateWithArtifactsAndAuditOperations(
          sessDir,
          makeState('PLAN', {
            id: SESSION_ID,
            transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
          }),
          [{ from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT }],
        );
        const pending = await readState(sessDir);
        const operation = requireTransition(pending!.pendingAuditOperations[0]!);
        // Same id + operationId, different transition content.
        const divergent = buildTransitionBody(
          SESSION_ID,
          undefined,
          'PLAN_REVIEW',
          {
            operationId: operation.operationId,
            preStateDigest: operation.preStateDigest,
            mutationDigest: operation.mutationDigest,
            postStateDigest: operation.postStateDigest,
            from: operation.transition.from,
            to: 'PLAN_REVIEW',
            event: operation.transition.event,
            autoAdvanced: false,
            chainIndex: 0,
          },
          operation.transition.at,
          'genesis',
        );
        await appendAuditEvent(sessDir, finalizeWithTimestampEvidence(divergent, 'genesis'));

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state: pending,
          }),
        });

        const result = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');
        expect(result?.block).toBe(true);
        expect((await readState(sessDir))!.pendingAuditOperations[0]!.status).toBe(
          'state_committed',
        );
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('tolerates a missing audit session authority only for a proven first hydrate', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-bootstrap-'));
      try {
        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(null),
          resolveCanonicalSessionDir: vi.fn().mockResolvedValue({
            status: 'resolved',
            sessDir,
          }),
          resolveSessionPolicy: vi.fn().mockRejectedValue(new Error('unreachable')),
        });

        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_hydrate'),
        ).resolves.toBeUndefined();

        const blocked = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');
        expect(blocked).toMatchObject({
          auditOk: false,
          block: true,
          code: 'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
        });
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('blocks flowguard_hydrate when the canonical resolution authority is unavailable', async () => {
      const deps = makeDeps({
        getSessionDir: vi.fn().mockReturnValue(null),
        resolveCanonicalSessionDir: vi.fn().mockResolvedValue({ status: 'unavailable' }),
        resolveSessionPolicy: vi.fn().mockRejectedValue(new Error('unreachable')),
      });

      const result = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_hydrate');
      expect(result).toMatchObject({
        auditOk: false,
        block: true,
        code: 'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
      });
    });

    it('blocks flowguard_hydrate when canonical resolution finds existing state despite the missing mapping', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-bootstrap-'));
      try {
        await writeState(sessDir, makeState('TICKET', { id: SESSION_ID }));
        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(null),
          resolveCanonicalSessionDir: vi.fn().mockResolvedValue({
            status: 'resolved',
            sessDir,
          }),
          resolveSessionPolicy: vi.fn().mockRejectedValue(new Error('unreachable')),
        });

        const result = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_hydrate');
        expect(result).toMatchObject({
          auditOk: false,
          block: true,
          code: 'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
        });
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('allows flowguard_hydrate when canonical resolution finds no persisted state', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-bootstrap-'));
      try {
        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(null),
          resolveCanonicalSessionDir: vi.fn().mockResolvedValue({
            status: 'resolved',
            sessDir,
          }),
          resolveSessionPolicy: vi.fn().mockRejectedValue(new Error('unreachable')),
        });

        await expect(
          reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_hydrate'),
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('blocks reconciliation when the persisted state no longer matches postStateDigest', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-outbox-'));
      try {
        const initial = makeState('TICKET', { id: SESSION_ID });
        await writeState(sessDir, initial);
        await writeStateWithArtifactsAndAuditOperations(
          sessDir,
          makeState('PLAN', {
            id: SESSION_ID,
            transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
          }),
          [{ from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT }],
        );
        const pending = await readState(sessDir);
        // Simulate a side-effect state write after the outbox commit (e.g. a risk
        // gate decision): the operation's committed postStateDigest no longer
        // matches the actually persisted state.
        const modified: SessionState = { ...pending!, activeChecks: ['test'] };
        await writeState(sessDir, modified);

        const deps = makeDeps({
          getSessionDir: vi.fn().mockReturnValue(sessDir),
          resolveSessionPolicy: vi.fn().mockResolvedValue({
            policy: {
              audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
              actorClassification: {},
              mode: 'regulated',
              requireHumanGates: true,
            },
            state: modified,
          }),
          appendAndTrack: vi.fn(async () => {}),
        });

        const result = await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_plan');
        expect(result?.block).toBe(true);
        expect(deps.appendAndTrack).not.toHaveBeenCalled();
        expect((await readState(sessDir))!.pendingAuditOperations[0]!.status).toBe(
          'state_committed',
        );
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });

    it('rejects states with duplicate pendingAuditOperations operationIds', async () => {
      const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-unique-'));
      try {
        const initial = makeState('TICKET', { id: SESSION_ID });
        await writeState(sessDir, initial);
        await writeStateWithArtifactsAndAuditOperations(
          sessDir,
          makeState('PLAN', {
            id: SESSION_ID,
            transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT },
          }),
          [{ from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: FIXED_DECISION_AT }],
        );
        const pending = await readState(sessDir);
        const operation = pending!.pendingAuditOperations[0]!;
        const duplicated = {
          ...pending!,
          pendingAuditOperations: [operation, operation],
        };
        expect(SessionState.safeParse(duplicated).success).toBe(false);
      } finally {
        await fs.rm(sessDir, { recursive: true, force: true });
      }
    });
  });
});
