/**
 * @module integration/services/decision-audit-intent.test
 * @description Mutation-hardening contracts for the durable decision audit intent.
 *
 * The builder is the single authority for a human decision receipt: exact
 * verdict (including governance override), frozen decidedAt, and the reserved
 * sequence. The resolver is the single authority for sequence reservation —
 * it must count persisted receipts AND committed-but-unreconciled semantic
 * operations so a restart can never mint a duplicate DEC number.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect } from 'vitest';
import { buildDecisionBody, finalizeWithTimestampEvidence } from '../../audit/types.js';
import type { ChainedAuditEvent } from '../../audit/types.js';
import type { ReviewDecision } from '../../state/evidence.js';
import type { PendingAuditOperation } from '../../state/schema.js';
import type { TransitionRecord } from '../../rails/types.js';
import {
  actorInfoMatchesDecisionIdentity,
  buildDecisionAuditIntent,
  resolveDecisionSequence,
} from './decision-audit-intent.js';

const NOW = '2026-01-01T00:00:00.000Z';

const TRANSITION: TransitionRecord = {
  from: 'PLAN_REVIEW',
  to: 'VALIDATION',
  event: 'APPROVE',
  at: NOW,
};

const DECISION: ReviewDecision = {
  verdict: 'approve',
  rationale: 'Looks good',
  decidedAt: NOW,
  decisionIdentity: {
    actorId: 'reviewer-42',
    actorEmail: 'reviewer@example.com',
    actorSource: 'env',
    actorAssurance: 'best_effort',
  },
};

function receiptEvent(decisionSequence: number): ChainedAuditEvent {
  const body = buildDecisionBody({
    flowguardSessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    gatePhase: 'PLAN_REVIEW',
    detail: {
      decisionId: `DEC-${String(decisionSequence).padStart(3, '0')}`,
      decisionSequence,
      verdict: 'approve',
      rationale: 'seeded',
      decisionIdentity: DECISION.decisionIdentity,
      decidedAt: NOW,
      fromPhase: 'PLAN_REVIEW',
      toPhase: 'VALIDATION',
      transitionEvent: 'APPROVE',
      policyMode: 'team',
    },
    occurredAt: NOW,
    actor: 'human',
    prevHash: 'genesis',
  });
  return finalizeWithTimestampEvidence(body, 'genesis');
}

function receiptWithoutSequence(): ChainedAuditEvent {
  const event = receiptEvent(0);
  const { decisionSequence: _omitted, ...detail } = event.detail as Record<string, unknown>;
  return { ...event, detail };
}

function eventOfForeignKind(decisionSequence: number): ChainedAuditEvent {
  const event = receiptEvent(0);
  return { ...event, detail: { ...event.detail, kind: 'tool_call', decisionSequence } };
}

function pendingDecisionOperation(decisionSequence: number): PendingAuditOperation {
  const decisionId = `DEC-${String(decisionSequence).padStart(3, '0')}`;
  return {
    kind: 'semantic',
    operationId: '00000000-0000-4000-8000-000000000001',
    preStateDigest: 'a'.repeat(64),
    mutationDigest: 'b'.repeat(64),
    postStateDigest: 'c'.repeat(64),
    auditEventDigest: 'd'.repeat(64),
    status: 'state_committed',
    semantic: {
      phase: 'PLAN_REVIEW',
      event: `decision:${decisionId}`,
      occurredAt: NOW,
      detail: { kind: 'decision', decisionId, decisionSequence },
    },
  };
}

describe('buildDecisionAuditIntent', () => {
  it('HAPPY: builds the exact receipt fields from the decision transition', () => {
    const intent = buildDecisionAuditIntent({
      transition: TRANSITION,
      decision: DECISION,
      policyMode: 'team',
      decisionSequence: 7,
      actor: 'human',
    });

    expect(intent).toEqual({
      phase: 'PLAN_REVIEW',
      event: 'decision:DEC-007',
      occurredAt: NOW,
      detail: {
        kind: 'decision',
        gatePhase: 'PLAN_REVIEW',
        decisionId: 'DEC-007',
        decisionSequence: 7,
        verdict: 'approve',
        rationale: 'Looks good',
        decisionIdentity: DECISION.decisionIdentity,
        decidedAt: NOW,
        fromPhase: 'PLAN_REVIEW',
        toPhase: 'VALIDATION',
        transitionEvent: 'APPROVE',
        policyMode: 'team',
      },
      actor: 'human',
    });
  });

  it('HAPPY: preserves the governance-override verdict verbatim', () => {
    const intent = buildDecisionAuditIntent({
      transition: TRANSITION,
      decision: { ...DECISION, verdict: 'approve_with_governance_override' },
      policyMode: 'regulated',
      decisionSequence: 2,
      actor: 'human',
    });

    expect(intent.detail.verdict).toBe('approve_with_governance_override');
    expect(intent.detail.decisionId).toBe('DEC-002');
  });

  it('HAPPY: binds persisted actorInfo when present', () => {
    const actorInfo = {
      id: 'reviewer-42',
      email: 'reviewer@example.com',
      source: 'env' as const,
      assurance: 'best_effort' as const,
    };
    const intent = buildDecisionAuditIntent({
      transition: TRANSITION,
      decision: DECISION,
      policyMode: 'team',
      decisionSequence: 1,
      actor: 'human',
      actorInfo,
    });

    expect(intent.actorInfo).toEqual(actorInfo);
  });

  it('HAPPY: omits actorInfo entirely when no persisted actor info is supplied', () => {
    const intent = buildDecisionAuditIntent({
      transition: TRANSITION,
      decision: DECISION,
      policyMode: 'team',
      decisionSequence: 1,
      actor: 'human',
    });

    expect('actorInfo' in intent).toBe(false);
  });
});

describe('actorInfoMatchesDecisionIdentity', () => {
  const actorInfo = {
    id: 'reviewer-42',
    email: 'reviewer@example.com',
    displayName: null,
    source: 'env' as const,
    assurance: 'best_effort' as const,
  };

  it('HAPPY: matches when every identity field agrees', () => {
    expect(actorInfoMatchesDecisionIdentity(actorInfo, DECISION.decisionIdentity)).toBe(true);
  });

  it.each([
    ['id', { ...actorInfo, id: 'other-actor' }],
    ['email', { ...actorInfo, email: null }],
    ['displayName', { ...actorInfo, displayName: 'Other Reviewer' }],
    ['source', { ...actorInfo, source: 'git' as const }],
    ['assurance', { ...actorInfo, assurance: 'claim_validated' as const }],
  ])('BAD: rejects a differing %s', (_label, candidate) => {
    expect(actorInfoMatchesDecisionIdentity(candidate, DECISION.decisionIdentity)).toBe(false);
  });
});

describe('resolveDecisionSequence', () => {
  it('BAD: reserves 1 for an empty session authority', () => {
    expect(resolveDecisionSequence([], [])).toBe(1);
  });

  it('HAPPY: reserves one past the highest persisted receipt', () => {
    expect(resolveDecisionSequence([receiptEvent(1), receiptEvent(4)], [])).toBe(5);
  });

  it('HAPPY: counts committed-but-unreconciled semantic operations (crash window)', () => {
    expect(
      resolveDecisionSequence(
        [receiptEvent(1)],
        [pendingDecisionOperation(6), pendingDecisionOperation(2)],
      ),
    ).toBe(7);
  });

  it('CORNER: ignores non-decision events, non-semantic operations, and missing sequences', () => {
    const stateWrite: PendingAuditOperation = {
      kind: 'state_write',
      operationId: '00000000-0000-4000-8000-000000000002',
      preStateDigest: 'a'.repeat(64),
      mutationDigest: 'b'.repeat(64),
      postStateDigest: 'c'.repeat(64),
      auditEventDigest: 'd'.repeat(64),
      status: 'state_committed',
      stateWrite: { phase: 'PLAN_REVIEW', at: NOW },
    };
    expect(
      resolveDecisionSequence(
        [receiptWithoutSequence(), eventOfForeignKind(9)],
        [stateWrite, pendingDecisionOperation(3)],
      ),
    ).toBe(4);
  });
});
