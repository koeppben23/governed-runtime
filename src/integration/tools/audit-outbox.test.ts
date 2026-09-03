/**
 * @module integration/tools/audit-outbox.test
 * @description Direct tests for the durable audit outbox authority:
 *              state-digest SSOT, transition inference, operation shaping,
 *              and the state↔audit digest binding.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeState } from '../../fixtures.js';
import { SessionState, type PendingAuditOperation } from '../../state/schema.js';
import {
  computeStateDigest,
  prepareAuditOperations,
  prepareStateWithAuditOperations,
} from './audit-outbox.js';
import { computeCanonicalEventDigest } from '../../audit/canonical-digest.js';
import { buildStateWriteBody, buildTransitionBody } from '../../audit/types.js';
import { buildSemanticAuditBody } from '../../audit/semantic-event.js';
import { hashText } from '../../shared/hashing.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';

const FIXED_AT = '2026-05-15T12:00:00.000Z';
const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

const TICKET_TO_PLAN = {
  from: 'TICKET',
  to: 'PLAN',
  event: 'PLAN_READY',
  at: FIXED_AT,
} as const;

function requireTransition(
  operation: PendingAuditOperation,
): Extract<PendingAuditOperation, { kind: 'transition' }> {
  if (operation.kind !== 'transition') throw new Error('expected transition operation');
  return operation;
}

describe('computeStateDigest', () => {
  it('GOOD: excludes pendingAuditOperations from the digest', () => {
    const state = makeState('PLAN', { id: SESSION_ID });
    const withOps = makeState('PLAN', {
      id: SESSION_ID,
      pendingAuditOperations: [
        {
          kind: 'transition',
          operationId: 'bbbbbbbb-0000-4000-8000-000000000001',
          preStateDigest: 'a'.repeat(64),
          mutationDigest: 'b'.repeat(64),
          postStateDigest: 'c'.repeat(64),
          auditEventDigest: 'd'.repeat(64),
          transition: {
            from: 'TICKET',
            to: 'PLAN',
            event: 'PLAN_READY',
            at: FIXED_AT,
            chainIndex: 0,
            autoAdvanced: false,
          },
          status: 'state_committed',
        },
      ],
    });
    expect(computeStateDigest(state)).toBe(computeStateDigest(withOps));
  });

  it('BAD: differs when any other state field changes', () => {
    const state = makeState('PLAN', { id: SESSION_ID });
    const changed = makeState('PLAN', { id: SESSION_ID, activeChecks: ['test'] });
    expect(computeStateDigest(state)).not.toBe(computeStateDigest(changed));
  });
});

describe('prepareStateWithAuditOperations', () => {
  it('HAPPY: infers the transition from previous state and commits one operation', async () => {
    const previous = makeState('TICKET', { id: SESSION_ID });
    const next = makeState('PLAN', { id: SESSION_ID, transition: TICKET_TO_PLAN });

    const prepared = await prepareStateWithAuditOperations(previous, next, undefined);

    expect(prepared.pendingAuditOperations).toHaveLength(1);
    const op = requireTransition(prepared.pendingAuditOperations[0]!);
    expect(op.status).toBe('state_committed');
    expect(op.transition).toMatchObject({
      from: 'TICKET',
      to: 'PLAN',
      event: 'PLAN_READY',
      at: FIXED_AT,
      chainIndex: 0,
      autoAdvanced: false,
    });
    expect(op.preStateDigest).toBe(computeStateDigest(previous));
    expect(op.postStateDigest).toBe(computeStateDigest(prepared));
    expect(op.mutationDigest).toBe(hashText(canonicalJsonStringify([TICKET_TO_PLAN])));
  });

  it('HAPPY: binds pre/post/mutation digests into the committed event digest', async () => {
    const previous = makeState('TICKET', { id: SESSION_ID });
    const next = makeState('PLAN', { id: SESSION_ID, transition: TICKET_TO_PLAN });

    const prepared = await prepareStateWithAuditOperations(previous, next, undefined);
    const op = requireTransition(prepared.pendingAuditOperations[0]!);
    const body = buildTransitionBody(
      prepared.flowguardSessionId,
      prepared.binding.hostSessionId,
      op.transition.to,
      {
        operationId: op.operationId,
        preStateDigest: op.preStateDigest,
        mutationDigest: op.mutationDigest,
        postStateDigest: op.postStateDigest,
        from: op.transition.from,
        to: op.transition.to,
        event: op.transition.event,
        autoAdvanced: op.transition.autoAdvanced,
        chainIndex: op.transition.chainIndex,
      },
      op.transition.at,
      'genesis',
    );

    expect(computeCanonicalEventDigest(body)).toBe(op.auditEventDigest);
  });

  it('CORNER: records a same-phase authority write when the transition is unchanged', async () => {
    const previous = makeState('PLAN', { id: SESSION_ID, transition: TICKET_TO_PLAN });
    const next = makeState('PLAN', { id: SESSION_ID, transition: TICKET_TO_PLAN });

    const prepared = await prepareStateWithAuditOperations(previous, next, undefined);
    expect(prepared.pendingAuditOperations).toHaveLength(1);
    expect(prepared.pendingAuditOperations[0]!.kind).toBe('state_write');
  });

  it.each([
    ['from', { from: 'VALIDATION', to: 'PLAN', event: 'PLAN_READY', at: FIXED_AT }],
    ['to', { from: 'TICKET', to: 'PLAN_REVIEW', event: 'PLAN_READY', at: FIXED_AT }],
    ['event', { from: 'TICKET', to: 'PLAN', event: 'SELF_REVIEW_MET', at: FIXED_AT }],
    ['at', { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: '2026-05-15T13:00:00.000Z' }],
  ] as const)(
    'CORNER: commits an operation when only %s differs from the previous transition',
    async (_field, priorTransition) => {
      const previous = makeState('PLAN', { id: SESSION_ID, transition: priorTransition });
      const next = makeState('PLAN', { id: SESSION_ID, transition: TICKET_TO_PLAN });

      const prepared = await prepareStateWithAuditOperations(previous, next, undefined);
      expect(prepared.pendingAuditOperations).toHaveLength(1);
    },
  );

  it('CORNER: suppresses the transition projection but still binds the authority write when the policy does not emit transitions', async () => {
    const previous = makeState('TICKET', { id: SESSION_ID });
    const base = makeState('PLAN', { id: SESSION_ID, transition: TICKET_TO_PLAN });
    const next = makeState('PLAN', {
      id: SESSION_ID,
      transition: TICKET_TO_PLAN,
      policySnapshot: {
        ...base.policySnapshot,
        audit: { ...base.policySnapshot.audit, emitTransitions: false },
      },
    });

    const prepared = await prepareStateWithAuditOperations(previous, next, undefined);

    // emitTransitions governs the transition projection only. Dropping the
    // operation entirely would commit a mutation of authority state with no
    // durable audit binding, which is unrecoverable after a crash.
    expect(prepared.pendingAuditOperations).toHaveLength(1);
    expect(prepared.pendingAuditOperations[0]!.kind).toBe('state_write');
  });

  it('CORNER: records a transition-less authority write', async () => {
    const previous = makeState('TICKET', { id: SESSION_ID });
    const next = makeState('PLAN', { id: SESSION_ID });

    const prepared = await prepareStateWithAuditOperations(previous, next, undefined);
    expect(prepared.pendingAuditOperations).toHaveLength(1);
    const operation = prepared.pendingAuditOperations[0]!;
    expect(operation.kind).toBe('state_write');
    if (operation.kind !== 'state_write') throw new Error('expected state_write operation');
    const body = buildStateWriteBody(
      prepared.flowguardSessionId,
      prepared.binding.hostSessionId,
      operation.stateWrite.phase,
      {
        operationId: operation.operationId,
        preStateDigest: operation.preStateDigest,
        mutationDigest: operation.mutationDigest,
        postStateDigest: operation.postStateDigest,
      },
      operation.stateWrite.at,
      'genesis',
    );
    expect(operation.preStateDigest).toBe(computeStateDigest(previous));
    expect(operation.postStateDigest).toBe(computeStateDigest(prepared));
    expect(computeCanonicalEventDigest(body)).toBe(operation.auditEventDigest);
  });

  it('commits semantic review intent with the same state authority binding', () => {
    const previous = makeState('PLAN', { id: SESSION_ID });
    const next = makeState('PLAN', { id: SESSION_ID, activeChecks: ['review-complete'] });
    const prepared = prepareAuditOperations(previous, next, undefined, [
      {
        phase: 'PLAN',
        event: 'review:obligation_fulfilled',
        occurredAt: FIXED_AT,
        detail: { obligationId: 'obl-1', childSessionId: 'child-1' },
      },
    ]);
    const operation = prepared.pendingAuditOperations.find((item) => item.kind === 'semantic');
    if (!operation || operation.kind !== 'semantic') throw new Error('expected semantic operation');

    const body = buildSemanticAuditBody({
      flowguardSessionId: prepared.flowguardSessionId,
      hostSessionId: prepared.binding.hostSessionId,
      phase: operation.semantic.phase,
      detail: operation.semantic.detail,
      event: operation.semantic.event,
      occurredAt: operation.semantic.occurredAt,
      prevHash: 'genesis',
      operationId: operation.operationId,
      preStateDigest: operation.preStateDigest,
      mutationDigest: operation.mutationDigest,
      postStateDigest: operation.postStateDigest,
    });
    expect(operation.postStateDigest).toBe(computeStateDigest(prepared));
    expect(computeCanonicalEventDigest(body)).toBe(operation.auditEventDigest);
  });

  it('CORNER: a chain of transitions carries chainIndex and autoAdvanced markers', async () => {
    const previous = makeState('TICKET', { id: SESSION_ID });
    const next = makeState('PLAN_REVIEW', {
      id: SESSION_ID,
      transition: {
        from: 'PLAN',
        to: 'PLAN_REVIEW',
        event: 'SELF_REVIEW_PENDING',
        at: FIXED_AT,
      },
    });
    const transitions = [
      TICKET_TO_PLAN,
      { from: 'PLAN', to: 'PLAN_REVIEW', event: 'SELF_REVIEW_PENDING', at: FIXED_AT },
    ];

    const prepared = await prepareStateWithAuditOperations(previous, next, transitions);
    expect(prepared.pendingAuditOperations).toHaveLength(2);
    expect(requireTransition(prepared.pendingAuditOperations[0]!).transition).toMatchObject({
      chainIndex: 0,
      autoAdvanced: false,
    });
    expect(requireTransition(prepared.pendingAuditOperations[1]!).transition).toMatchObject({
      chainIndex: 1,
      autoAdvanced: true,
    });
    // Both operations share one post-state authority.
    expect(prepared.pendingAuditOperations[0]!.postStateDigest).toBe(
      prepared.pendingAuditOperations[1]!.postStateDigest,
    );
  });

  it('BAD: rejects invalid next state', async () => {
    const invalid = { ...makeState('PLAN', { id: SESSION_ID }), phase: 'NOT_A_PHASE' };
    await expect(
      prepareStateWithAuditOperations(
        makeState('TICKET', { id: SESSION_ID }),
        invalid as unknown as SessionState,
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' });
  });

  it('CORNER: uses a hash marker instead of a pre-state digest for the first write', async () => {
    const next = makeState('PLAN', { id: SESSION_ID, transition: TICKET_TO_PLAN });

    const prepared = await prepareStateWithAuditOperations(null, next, undefined);
    expect(prepared.pendingAuditOperations[0]!.preStateDigest).toBe(
      hashText('state-digest.v2:absent'),
    );
  });
});

describe('prepared state remains persistable', () => {
  it('HAPPY: the prepared state passes the full session schema', async () => {
    const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-outbox-unit-'));
    try {
      const previous = makeState('TICKET', { id: SESSION_ID });
      const next = makeState('PLAN', { id: SESSION_ID, transition: TICKET_TO_PLAN });
      const prepared = await prepareStateWithAuditOperations(previous, next, undefined);

      expect(SessionState.safeParse(prepared).success).toBe(true);
    } finally {
      await fs.rm(sessDir, { recursive: true, force: true });
    }
  });
});
