/**
 * @module integration/plugin-workspace-composition
 * @description Production composition contract for `createWorkspace()`.
 *
 * The semantic outbox is exercised elsewhere against `PluginWorkspaceImpl`
 * directly. That proves the implementation but not the wiring: production does
 * not use the class, it uses the `createWorkspace()` factory, whose result is
 * handed to the orchestrator in `plugin.ts` and reaches the review pipeline as
 * `OrchestratorDeps.updateReviewAssurance`.
 *
 * A factory closure that forwards fewer arguments than the contract declares is
 * assignable in TypeScript and silently drops the extra ones at runtime, so the
 * semantic-intent callback can be lost between a correct interface and a
 * correct implementation. These tests bind the factory itself to real
 * persistence and assert on the durable outbox.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readState, writeState } from '../adapters/persistence.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { createDecisionEvent, GENESIS_HASH } from '../audit/types.js';
import { makeState } from '../fixtures.js';
import { createWorkspace } from './plugin-workspace.js';
import { freezeReviewMaterial } from './review/assurance.js';
import { blockObligation } from './review/obligation-state.js';
import type { SessionState } from '../state/schema.js';

const NOW = '2026-05-15T12:00:00.000Z';
const OBLIGATION_ID = '33333333-3333-4333-8333-333333333333';
const FLOWGUARD_SESSION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_SESSION_ID = '55555555-5555-4555-8555-555555555555';

function stateWithBlockedCode(blockedCode: string): SessionState {
  const base = makeState('PLAN');
  return makeState('PLAN', {
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6',
      obligations: [
        {
          obligationId: OBLIGATION_ID,
          obligationType: 'plan',
          requiredChallengeCount: 0,
          requiredChallengeKind: 'design_challenge',
          challengePolicyVersion: 'challenge-policy.v1',
          subjectDigest: 'subject-digest',
          reviewMaterial: freezeReviewMaterial('frozen review material', 'subject-digest'),
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 1,
          planVersion: 1,
          criteriaVersion: 'review-criteria.v1',
          mandateDigest: 'mandate-digest',
          maxReviewerOutputRepairAttempts: 1,
          createdAt: NOW,
          pluginHandshakeAt: NOW,
          status: 'blocked',
          invocationId: null,
          blockedCode,
          fulfilledAt: null,
          consumedAt: null,
          reviewSubjectScope: {
            kind: 'repository_change',
            paths: ['src/a.ts'],
            revisions: ['head'],
          },
        },
      ],
      invocations: [],
      attempts: [],
      dispatches: [],
    },
    policySnapshot: base.policySnapshot,
  });
}

/** The semantic-intent callback the review pipeline supplies in production. */
function semanticIntents(state: SessionState) {
  return [
    {
      phase: state.phase,
      event: 'review:obligation_blocked' as const,
      occurredAt: NOW,
      detail: { obligationId: OBLIGATION_ID, code: 'REVIEWER_INVOCATION_EXHAUSTED' },
    },
  ];
}

function decisionReceipt(
  flowguardSessionId: string,
  hostSessionId: string | undefined,
  decisionSequence: number,
) {
  return createDecisionEvent({
    flowguardSessionId,
    hostSessionId,
    gatePhase: 'PLAN_REVIEW',
    detail: {
      decisionId: `DEC-${decisionSequence}`,
      decisionSequence,
      verdict: 'approve',
      rationale: 'reviewed',
      decidedBy: 'reviewer',
      decidedAt: NOW,
      fromPhase: 'PLAN_REVIEW',
      toPhase: 'VALIDATION',
      transitionEvent: 'APPROVE',
      policyMode: 'strict',
    },
    occurredAt: NOW,
    actor: 'human',
    prevHash: GENESIS_HASH,
  });
}

async function withSessionDir<T>(fn: (sessDir: string) => Promise<T>): Promise<T> {
  const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-composition-'));
  try {
    return await fn(sessDir);
  } finally {
    await fs.rm(sessDir, { recursive: true, force: true });
  }
}

describe('createWorkspace composition contract', () => {
  it('forwards the semantic intent for an idempotent blocked retry (no state delta)', async () => {
    // The case #868 exists for: blocking an already-blocked obligation with the
    // same code produces no state delta, so the semantic intent is the ONLY
    // thing that can make the retry durable. If the factory drops it, the
    // auditworthy occurrence disappears entirely.
    await withSessionDir(async (sessDir) => {
      await writeState(sessDir, stateWithBlockedCode('REVIEWER_INVOCATION_EXHAUSTED'));

      const ws = createWorkspace({ auditWorktree: undefined });
      await ws.updateReviewAssurance(
        sessDir,
        (state) => blockObligation(state, OBLIGATION_ID, 'REVIEWER_INVOCATION_EXHAUSTED'),
        semanticIntents,
      );

      const persisted = await readState(sessDir);
      expect(persisted!.pendingAuditOperations).toHaveLength(1);
      const operation = persisted!.pendingAuditOperations[0]!;
      expect(operation.kind).toBe('semantic');
      // Semantic-only: the outbox must not fabricate a state_write for a
      // mutation that changed nothing.
      expect(operation.preStateDigest).toBe(operation.postStateDigest);
    });
  });

  it('forwards the semantic intent alongside a real state delta', async () => {
    await withSessionDir(async (sessDir) => {
      await writeState(sessDir, stateWithBlockedCode('REVIEWER_OUTPUT_INVALID'));

      const ws = createWorkspace({ auditWorktree: undefined });
      await ws.updateReviewAssurance(
        sessDir,
        (state) => blockObligation(state, OBLIGATION_ID, 'REVIEWER_INVOCATION_EXHAUSTED'),
        semanticIntents,
      );

      const persisted = await readState(sessDir);
      expect(persisted!.reviewAssurance!.obligations[0]!.blockedCode).toBe(
        'REVIEWER_INVOCATION_EXHAUSTED',
      );
      const kinds = persisted!.pendingAuditOperations.map((operation) => operation.kind);
      expect(kinds).toContain('semantic');
      // The state genuinely changed, so the authority write is bound too.
      expect(kinds).toContain('state_write');
    });
  });

  it('records no semantic operation when the caller supplies no intent', async () => {
    // Guards the opposite direction: the forwarding must not invent intents.
    await withSessionDir(async (sessDir) => {
      await writeState(sessDir, stateWithBlockedCode('REVIEWER_OUTPUT_INVALID'));

      const ws = createWorkspace({ auditWorktree: undefined });
      await ws.updateReviewAssurance(sessDir, (state) =>
        blockObligation(state, OBLIGATION_ID, 'REVIEWER_INVOCATION_EXHAUSTED'),
      );

      const persisted = await readState(sessDir);
      const kinds = persisted!.pendingAuditOperations.map((operation) => operation.kind);
      expect(kinds).not.toContain('semantic');
    });
  });

  it('allocates decision sequences from receipts bound to either session identity', async () => {
    await withSessionDir(async (sessDir) => {
      await appendAuditEvent(sessDir, decisionReceipt(FLOWGUARD_SESSION_ID, undefined, 3));
      await appendAuditEvent(sessDir, decisionReceipt(OTHER_SESSION_ID, FLOWGUARD_SESSION_ID, 8));
      await appendAuditEvent(sessDir, decisionReceipt(OTHER_SESSION_ID, 'other-host', 99));

      const ws = createWorkspace({ auditWorktree: undefined });
      expect(await ws.nextDecisionSequence(sessDir, FLOWGUARD_SESSION_ID)).toBe(9);
      // Once allocated, the value belongs to this session even if the durable
      // trail contains receipts for a different identity with higher numbers.
      await appendAuditEvent(sessDir, decisionReceipt(OTHER_SESSION_ID, 'different-host', 100));
      expect(await ws.nextDecisionSequence(sessDir, FLOWGUARD_SESSION_ID)).toBe(10);
    });
  });
});
