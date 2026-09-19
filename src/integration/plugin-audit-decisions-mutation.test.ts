/**
 * @module integration/plugin-audit-decisions-mutation.test
 * @description Mutation-hardening contracts for decision-receipt emission.
 *
 * These cases are registered into `plugin-audit.test.ts` (the base Stryker
 * owning suite for `plugin-audit-decisions.ts`) via an import in that suite.
 * They live in a focused module so the owning suite stays within the 2000-LOC
 * test budget while every case still runs under a stryker-selected suite.
 *
 * Coverage targets are the observable decision-receipt contracts:
 * existing-receipt deduplication, identity/rationale resolution, host-session
 * and actorInfo bindings, and timestamp-evidence error propagation.
 *
 * @test-policy BAD, CORNER
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { buildDecisionBody, finalizeWithTimestampEvidence } from '../audit/types.js';
import { MockTimestampAuthorityProvider } from '../audit/tsa-provider.js';
import type { TimestampAuthorityProvider } from '../audit/tsa-provider.js';
import type { TimestampAssurancePolicy } from '../config/policy-types.js';
import { BINDING, makeState, REGULATED_POLICY_SNAPSHOT, REVIEW_APPROVE } from '../fixtures.js';
import type { ReviewVerdict } from '../state/evidence.js';
import type { Event, Phase, SessionState } from '../state/schema.js';
import { runAudit, type AuditDeps } from './plugin-audit.js';
import {
  FIXED_DECISION_AT,
  makeDeps,
  resetChainSeq,
  SESSION_ID,
} from './plugin-audit-test-helpers.js';

const DECISION_IDENTITY = {
  actorId: 'reviewer-1',
  actorEmail: 'reviewer@test.com',
  actorSource: 'env' as const,
  actorAssurance: 'best_effort' as const,
};

const ACTOR_INFO = {
  id: 'reviewer-1',
  email: 'reviewer@test.com',
  source: 'env' as const,
  assurance: 'best_effort' as const,
};

const APPROVE_TRANSITION = {
  event: 'APPROVE' as const,
  from: 'PLAN_REVIEW' as const,
  to: 'PLAN' as const,
  at: FIXED_DECISION_AT,
};

const APPROVE_OUTPUT = {
  phase: 'PLAN_REVIEW',
  error: false,
  reviewDecision: {
    decisionIdentity: DECISION_IDENTITY,
    rationale: 'looks good',
    decidedAt: FIXED_DECISION_AT,
  },
};

interface DecisionDepsOptions {
  readonly sessDir?: string;
  readonly timestampAssurance?: TimestampAssurancePolicy;
  readonly tsaProvider?: TimestampAuthorityProvider;
}

function decisionDeps(state: SessionState, options: DecisionDepsOptions = {}): AuditDeps {
  return makeDeps({
    ...(options.sessDir !== undefined
      ? { getSessionDir: vi.fn().mockReturnValue(options.sessDir) }
      : {}),
    ...(options.tsaProvider !== undefined ? { tsaProvider: options.tsaProvider } : {}),
    resolveSessionPolicy: vi.fn().mockResolvedValue({
      policy: {
        audit: {
          emitToolCalls: false,
          emitTransitions: false,
          enableChainHash: true,
          ...(options.timestampAssurance !== undefined
            ? { timestampAssurance: options.timestampAssurance }
            : {}),
        },
        actorClassification: {},
        mode: 'solo',
        requireHumanGates: false,
      },
      state,
    }),
  });
}

function auditEvents(deps: AuditDeps): Array<Record<string, unknown>> {
  return (deps.appendAndTrack as ReturnType<typeof vi.fn>).mock.calls.map(
    (call: unknown[]) => call[0] as Record<string, unknown>,
  );
}

function eventsOfKind(deps: AuditDeps, kind: string): Array<Record<string, unknown>> {
  return auditEvents(deps).filter(
    (event) => (event.detail as { kind?: string } | undefined)?.kind === kind,
  );
}

interface SeededDecision {
  readonly fromPhase?: Phase;
  readonly toPhase?: Phase;
  readonly transitionEvent?: Event;
  readonly verdict?: ReviewVerdict;
}

/** Persist a prior decision receipt through the production event builder. */
async function seedDecisionEvent(sessDir: string, fields: SeededDecision = {}): Promise<void> {
  const body = buildDecisionBody({
    flowguardSessionId: SESSION_ID,
    hostSessionId: BINDING.hostSessionId,
    gatePhase: 'PLAN_REVIEW',
    detail: {
      decisionId: 'DEC-SEEDED',
      decisionSequence: 1,
      verdict: fields.verdict ?? 'approve',
      rationale: 'seeded',
      decisionIdentity: DECISION_IDENTITY,
      decidedAt: FIXED_DECISION_AT,
      fromPhase: fields.fromPhase ?? 'PLAN_REVIEW',
      toPhase: fields.toPhase ?? 'PLAN',
      transitionEvent: fields.transitionEvent ?? 'APPROVE',
      policyMode: 'regulated',
    },
    occurredAt: FIXED_DECISION_AT,
    actor: 'human',
    prevHash: 'genesis',
  });
  await appendAuditEvent(sessDir, finalizeWithTimestampEvidence(body, 'genesis'));
}

async function withSessDir(fn: (sessDir: string) => Promise<void>): Promise<void> {
  const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-decision-receipts-'));
  try {
    await fn(sessDir);
  } finally {
    await fs.rm(sessDir, { recursive: true, force: true });
  }
}

function approvedState(): SessionState {
  return makeState('PLAN_REVIEW', { transition: APPROVE_TRANSITION });
}

function regulatedArchiveState(): SessionState {
  return makeState('PLAN_REVIEW', {
    transition: APPROVE_TRANSITION,
    regulatedArchiveStatus: 'created',
    policySnapshot: REGULATED_POLICY_SNAPSHOT,
  });
}

function strictTimestampPolicy(eventKind: string): TimestampAssurancePolicy {
  return {
    enabled: true,
    mode: 'tsa_critical',
    strict: true,
    criticalEvents: [eventKind],
    tsaUrl: 'https://tsa.invalid',
    trustAnchors: ['pem'],
    ntpServers: ['invalid.invalid'],
    ntpDriftThresholdMs: 30000,
    tsaTimeoutMs: 1000,
  };
}

describe('decision receipt mutation contracts', () => {
  describe('existing-receipt deduplication', () => {
    beforeEach(() => {
      resetChainSeq();
    });

    it('emits the receipt when every pre-existing decision differs in one field', async () => {
      await withSessDir(async (sessDir) => {
        await seedDecisionEvent(sessDir, { fromPhase: 'TICKET' });
        await seedDecisionEvent(sessDir, { toPhase: 'TICKET' });
        await seedDecisionEvent(sessDir, { transitionEvent: 'CHANGES_REQUESTED' });
        await seedDecisionEvent(sessDir, { verdict: 'reject' });
        const deps = decisionDeps(regulatedArchiveState(), { sessDir });

        await runAudit(deps, 'flowguard_decision', {}, APPROVE_OUTPUT, SESSION_ID);

        const decisions = eventsOfKind(deps, 'decision');
        expect(decisions).toHaveLength(1);
        expect(decisions[0]!.detail).toMatchObject({
          kind: 'decision',
          verdict: 'approve',
          fromPhase: 'PLAN_REVIEW',
          toPhase: 'PLAN',
          transitionEvent: 'APPROVE',
        });
      });
    });

    it('suppresses the receipt when a matching decision already exists in a regulated archive', async () => {
      await withSessDir(async (sessDir) => {
        await seedDecisionEvent(sessDir);
        await seedDecisionEvent(sessDir, { verdict: 'reject' });
        const deps = decisionDeps(regulatedArchiveState(), { sessDir });

        await runAudit(deps, 'flowguard_decision', {}, APPROVE_OUTPUT, SESSION_ID);

        expect(eventsOfKind(deps, 'decision')).toHaveLength(0);
      });
    });

    it('does not suppress a matching decision outside the regulated archive path', async () => {
      await withSessDir(async (sessDir) => {
        await seedDecisionEvent(sessDir);
        const state = makeState('PLAN_REVIEW', {
          transition: APPROVE_TRANSITION,
          regulatedArchiveStatus: 'created',
        });
        const deps = decisionDeps(state, { sessDir });

        await runAudit(deps, 'flowguard_decision', {}, APPROVE_OUTPUT, SESSION_ID);

        expect(eventsOfKind(deps, 'decision')).toHaveLength(1);
      });
    });
  });

  describe('identity and rationale resolution', () => {
    beforeEach(() => {
      resetChainSeq();
    });

    it('treats a blank actorId carried by persisted state as a missing identity', async () => {
      const state = makeState('PLAN_REVIEW', {
        transition: APPROVE_TRANSITION,
        reviewDecision: {
          ...REVIEW_APPROVE,
          decisionIdentity: { ...REVIEW_APPROVE.decisionIdentity, actorId: '   ' },
        },
      });
      const deps = decisionDeps(state);

      await runAudit(
        deps,
        'flowguard_decision',
        {},
        { phase: 'PLAN_REVIEW', error: false },
        SESSION_ID,
      );

      expect(eventsOfKind(deps, 'decision')).toHaveLength(0);
      expect(eventsOfKind(deps, 'error')[0]!.detail).toMatchObject({
        kind: 'error',
        code: 'DECISION_RECEIPT_ACTOR_MISSING',
      });
    });

    it('falls back to an empty rationale when args are absent', async () => {
      const deps = decisionDeps(approvedState());

      await runAudit(
        deps,
        'flowguard_decision',
        undefined,
        {
          phase: 'PLAN_REVIEW',
          error: false,
          reviewDecision: { decisionIdentity: DECISION_IDENTITY },
        },
        SESSION_ID,
      );

      const decisions = eventsOfKind(deps, 'decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.detail).toMatchObject({ kind: 'decision', rationale: '' });
    });

    it('binds the persisted host session id into the emitted receipt', async () => {
      const deps = decisionDeps(approvedState());

      await runAudit(deps, 'flowguard_decision', {}, APPROVE_OUTPUT, SESSION_ID);

      expect(eventsOfKind(deps, 'decision')[0]!.hostSessionId).toBe(BINDING.hostSessionId);
    });

    it('binds persisted actorInfo into the emitted receipt', async () => {
      const deps = decisionDeps(
        makeState('PLAN_REVIEW', { transition: APPROVE_TRANSITION, actorInfo: ACTOR_INFO }),
      );

      await runAudit(deps, 'flowguard_decision', {}, APPROVE_OUTPUT, SESSION_ID);

      expect(eventsOfKind(deps, 'decision')[0]!.actorInfo).toEqual(ACTOR_INFO);
    });
  });

  describe('timestamp evidence propagation', () => {
    beforeEach(() => {
      resetChainSeq();
    });

    it('records the actor-missing diagnostic and a strict timestamp failure for the error event', async () => {
      await withSessDir(async (sessDir) => {
        const deps = decisionDeps(approvedState(), {
          sessDir,
          timestampAssurance: strictTimestampPolicy('error'),
          tsaProvider: new MockTimestampAuthorityProvider({ simulateFailure: true }),
        });

        const result = await runAudit(
          deps,
          'flowguard_decision',
          {},
          { phase: 'PLAN_REVIEW', error: false },
          SESSION_ID,
        );

        expect(deps.log.warn).toHaveBeenCalledWith(
          'audit',
          'skipping decision receipt: missing decision identity',
          { tool: 'flowguard_decision', sessionId: SESSION_ID },
        );
        expect(eventsOfKind(deps, 'error')[0]!.detail).toMatchObject({
          kind: 'error',
          code: 'DECISION_RECEIPT_ACTOR_MISSING',
        });
        expect(result).toMatchObject({ block: true, code: 'TSA_TIMESTAMP_ASSURANCE_FAILED' });
      });
    });

    it('records a strict timestamp failure for the decision receipt itself', async () => {
      await withSessDir(async (sessDir) => {
        const deps = decisionDeps(approvedState(), {
          sessDir,
          timestampAssurance: strictTimestampPolicy('decision'),
          tsaProvider: new MockTimestampAuthorityProvider({ simulateFailure: true }),
        });

        const result = await runAudit(deps, 'flowguard_decision', {}, APPROVE_OUTPUT, SESSION_ID);

        const decisions = eventsOfKind(deps, 'decision');
        expect(decisions).toHaveLength(1);
        expect(decisions[0]!.timestampEvidence).toMatchObject({ status: 'tsa_failed' });
        expect(result).toMatchObject({ block: true, code: 'TSA_TIMESTAMP_ASSURANCE_FAILED' });
      });
    });

    it('carries the NTP evidence warning into the decision receipt', async () => {
      const deps = decisionDeps(approvedState(), {
        timestampAssurance: {
          enabled: true,
          mode: 'ntp_check',
          strict: false,
          criticalEvents: [],
          ntpServers: ['invalid.invalid'],
          ntpDriftThresholdMs: 30000,
          tsaTimeoutMs: 1000,
        },
      });

      await runAudit(deps, 'flowguard_decision', {}, APPROVE_OUTPUT, SESSION_ID);

      const decisions = eventsOfKind(deps, 'decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.timestampEvidence).toMatchObject({
        status: 'ntp_checked',
        warning: expect.stringContaining('All NTP servers unreachable'),
      });
    });
  });
});
