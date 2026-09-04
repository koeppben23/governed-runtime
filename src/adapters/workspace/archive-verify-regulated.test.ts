/**
 * @module adapters/workspace/archive-verify-regulated.test
 * @description Unit tests for the regulated completion verifier binding.
 *
 * Coverage: HAPPY, BAD, CORNER
 * - HAPPY: exact EVIDENCE_REVIEW APPROVE COMPLETE with a bound decision passes
 * - BAD: decision receipt mismatches reviewDecision fields or decisionIdentity
 * - CORNER: non-exact terminal transitions and non-regulated states are rejected/skipped
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, expect, it } from 'vitest';
import type { ChainedAuditEvent } from '../../audit/types.js';
import { CURRENT_AUDIT_FORMAT_VERSION } from '../../audit/types.js';
import type { ArchiveFinding } from '../../archive/types.js';
import type { SessionState } from '../../state/schema.js';
import { makeState, REGULATED_POLICY_SNAPSHOT, REVIEW_APPROVE } from '../../fixtures.js';
import { verifyRegulatedCompletionCompleteness } from './archive-verify-regulated.js';

const AT = '2026-01-01T00:00:00.000Z';

function chainedEvent(detail: Record<string, unknown>): ChainedAuditEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    flowguardSessionId: 'fg-session',
    hostSessionId: 'host-session',
    phase: 'COMPLETE',
    event: (detail.kind as string) === 'transition' ? 'APPROVE' : 'custom',
    auditSequence: 1,
    occurredAt: AT,
    recordedAt: AT,
    actor: 'human',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail,
    prevHash: 'genesis',
    chainHash: 'a'.repeat(64),
    semanticEventDigest: 'b'.repeat(64),
  } as ChainedAuditEvent;
}

function transitionEvent(): ChainedAuditEvent {
  return {
    ...chainedEvent({
      kind: 'transition',
      from: 'EVIDENCE_REVIEW',
      to: 'COMPLETE',
      event: 'APPROVE',
      at: AT,
    }),
    event: 'APPROVE',
  };
}

function decisionEvent(overrides: Record<string, unknown> = {}): ChainedAuditEvent {
  return {
    ...chainedEvent({
      kind: 'decision',
      decisionId: 'DEC-001',
      decisionSequence: 1,
      gatePhase: 'EVIDENCE_REVIEW',
      verdict: 'approve',
      rationale: 'LGTM',
      decidedBy: 'reviewer-1',
      decidedAt: AT,
      fromPhase: 'EVIDENCE_REVIEW',
      toPhase: 'COMPLETE',
      transitionEvent: 'APPROVE',
      policyMode: 'regulated',
      ...overrides,
    }),
    event: 'decision:DEC-001',
    actor: 'reviewer-1',
  };
}

function lifecycleEvent(): ChainedAuditEvent {
  return {
    ...chainedEvent({ kind: 'lifecycle', action: 'session_completed', finalPhase: 'COMPLETE' }),
    event: 'lifecycle:session_completed',
    actor: 'machine',
  };
}

function regulatedCompleteState(
  reviewDecision: SessionState['reviewDecision'] = REVIEW_APPROVE,
): SessionState {
  return makeState('COMPLETE', {
    policySnapshot: REGULATED_POLICY_SNAPSHOT,
    reviewDecision,
    regulatedArchiveStatus: 'verified',
    transition: {
      from: 'EVIDENCE_REVIEW',
      to: 'COMPLETE',
      event: 'APPROVE',
      at: AT,
    },
  });
}

function run(
  state: SessionState | null,
  events: ChainedAuditEvent[],
): { codes: string[]; findings: ArchiveFinding[] } {
  const findings: ArchiveFinding[] = [];
  verifyRegulatedCompletionCompleteness(state, events, findings);
  return { findings, codes: findings.map((finding) => finding.code) };
}

describe('verifyRegulatedCompletionCompleteness', () => {
  it('accepts an exact bound completion chain', () => {
    const { codes } = run(regulatedCompleteState(), [
      transitionEvent(),
      decisionEvent(),
      lifecycleEvent(),
    ]);
    expect(codes).toEqual([]);
  });

  it('skips non-regulated sessions', () => {
    const state = makeState('COMPLETE', { reviewDecision: REVIEW_APPROVE });
    const { codes } = run(state, [transitionEvent(), decisionEvent(), lifecycleEvent()]);
    expect(codes).toEqual([]);
  });

  it('fails closed on a regulated archive whose snapshot is not terminal', () => {
    const state = makeState('EVIDENCE_REVIEW', {
      policySnapshot: REGULATED_POLICY_SNAPSHOT,
      reviewDecision: REVIEW_APPROVE,
      regulatedArchiveStatus: 'pending',
      transition: {
        from: 'EVIDENCE_REVIEW',
        to: 'COMPLETE',
        event: 'APPROVE',
        at: AT,
      },
    });
    const { codes } = run(state, [transitionEvent(), decisionEvent(), lifecycleEvent()]);
    expect(codes).toContain('regulated_terminal_transition_missing');
  });

  it('rejects a terminal transition that is not EVIDENCE_REVIEW APPROVE to COMPLETE', () => {
    const state = makeState('COMPLETE', {
      policySnapshot: REGULATED_POLICY_SNAPSHOT,
      reviewDecision: REVIEW_APPROVE,
      regulatedArchiveStatus: 'verified',
      transition: { from: 'IMPL_REVIEW', to: 'COMPLETE', event: 'APPROVE', at: AT },
    });
    const { codes } = run(state, [transitionEvent(), decisionEvent(), lifecycleEvent()]);
    expect(codes).toContain('regulated_terminal_transition_missing');
  });

  it('rejects when reviewDecision is not an approval authority', () => {
    const state = regulatedCompleteState({
      ...REVIEW_APPROVE,
      verdict: 'changes_requested' as const,
    });
    const { codes } = run(state, [transitionEvent(), decisionEvent(), lifecycleEvent()]);
    expect(codes).toContain('regulated_terminal_decision_invalid');
  });

  it.each([
    { override: { verdict: 'reject' }, label: 'verdict' },
    { override: { rationale: 'other' }, label: 'rationale' },
    { override: { decidedBy: 'other-reviewer' }, label: 'decidedBy' },
    { override: { decidedAt: '2025-12-31T23:59:59.000Z' }, label: 'decidedAt' },
  ])('binds the decision receipt $label to reviewDecision', ({ override }) => {
    const { findings } = run(regulatedCompleteState(), [
      transitionEvent(),
      decisionEvent(override),
      lifecycleEvent(),
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'regulated_terminal_decision_invalid',
        message: expect.stringContaining('reviewDecision'),
      }),
    );
  });

  it('binds decisionIdentity actorId to the persisted identity', () => {
    const state = regulatedCompleteState({
      ...REVIEW_APPROVE,
      decisionIdentity: {
        actorId: 'reviewer-1',
        actorEmail: null,
        actorSource: 'env' as const,
        actorAssurance: 'best_effort' as const,
      },
    });
    const { findings } = run(state, [
      transitionEvent(),
      decisionEvent({ decisionIdentity: { actorId: 'other-reviewer' } }),
      lifecycleEvent(),
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'regulated_terminal_decision_invalid',
        message: expect.stringContaining('decisionIdentity'),
      }),
    );
  });

  it('binds the receipt actor to the deciding authority', () => {
    const state = regulatedCompleteState({
      ...REVIEW_APPROVE,
      decisionIdentity: {
        actorId: 'reviewer-1',
        actorEmail: null,
        actorSource: 'env' as const,
        actorAssurance: 'best_effort' as const,
      },
    });
    const events = [transitionEvent(), decisionEvent(), lifecycleEvent()];
    events[1] = { ...events[1]!, actor: 'machine' };
    const { findings } = run(state, events);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'regulated_terminal_decision_invalid',
        message: expect.stringContaining('actor'),
      }),
    );
  });

  it('binds every decisionIdentity field to the persisted identity', () => {
    const state = regulatedCompleteState({
      ...REVIEW_APPROVE,
      decisionIdentity: {
        actorId: 'reviewer-1',
        actorEmail: 'reviewer-1@regulated.dev',
        actorDisplayName: 'Regulated Reviewer',
        actorSource: 'env' as const,
        actorAssurance: 'claim_validated' as const,
      },
    });
    const { findings } = run(state, [
      transitionEvent(),
      decisionEvent({
        decisionIdentity: {
          actorId: 'reviewer-1',
          actorEmail: 'reviewer-2@regulated.dev',
          actorSource: 'env',
          actorAssurance: 'claim_validated',
        },
      }),
      lifecycleEvent(),
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'regulated_terminal_decision_invalid',
        message: expect.stringContaining('decisionIdentity'),
      }),
    );
  });

  it('flags out-of-order completion evidence', () => {
    const { codes } = run(regulatedCompleteState(), [
      transitionEvent(),
      lifecycleEvent(),
      decisionEvent(),
    ]);
    expect(codes).toContain('regulated_completion_order_invalid');
  });

  it('flags duplicate terminal decisions', () => {
    const { codes } = run(regulatedCompleteState(), [
      transitionEvent(),
      decisionEvent(),
      decisionEvent({ decisionId: 'DEC-002' }),
      lifecycleEvent(),
    ]);
    expect(codes).toContain('regulated_terminal_decision_invalid');
  });

  it('binds the lifecycle finalPhase exactly to the completion transition target', () => {
    const events = [transitionEvent(), decisionEvent(), lifecycleEvent()];
    events[2] = {
      ...events[2]!,
      detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'ARCH_COMPLETE' },
    };
    const { codes } = run(regulatedCompleteState(), events);
    expect(codes).toContain('regulated_completion_lifecycle_invalid');
  });
});
