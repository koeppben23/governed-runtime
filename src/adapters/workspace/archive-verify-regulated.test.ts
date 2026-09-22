/**
 * @module adapters/workspace/archive-verify-regulated.test
 * @description Unit tests for the regulated completion verifier binding.
 *
 * Coverage: HAPPY, BAD, CORNER
 * - HAPPY: exact EVIDENCE_REVIEW APPROVE → EXPORT_READY, then EXPORT_MATERIALIZED
 *   → COMPLETE with a bound decision passes
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
  };
}

function approvalTransitionEvent(): ChainedAuditEvent {
  return {
    ...chainedEvent({
      kind: 'transition',
      from: 'EVIDENCE_REVIEW',
      to: 'EXPORT_READY',
      event: 'APPROVE',
      at: AT,
    }),
    event: 'APPROVE',
  };
}

function exportTransitionEvent(): ChainedAuditEvent {
  return {
    ...chainedEvent({
      kind: 'transition',
      from: 'EXPORT_READY',
      to: 'COMPLETE',
      event: 'EXPORT_MATERIALIZED',
      at: AT,
    }),
    event: 'EXPORT_MATERIALIZED',
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
      decisionIdentity: {
        actorId: 'reviewer-1',
        actorEmail: 'reviewer@test.com',
        actorSource: 'env',
        actorAssurance: 'best_effort',
      },
      decidedAt: AT,
      fromPhase: 'EVIDENCE_REVIEW',
      toPhase: 'EXPORT_READY',
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
      from: 'EXPORT_READY',
      to: 'COMPLETE',
      event: 'EXPORT_MATERIALIZED',
      at: AT,
    },
  });
}

/** The canonical completion evidence order: approval, decision, export, lifecycle. */
function boundCompletionEvents(
  decisionOverrides: Record<string, unknown> = {},
): ChainedAuditEvent[] {
  return [
    approvalTransitionEvent(),
    decisionEvent(decisionOverrides),
    exportTransitionEvent(),
    lifecycleEvent(),
  ];
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
    const { codes } = run(regulatedCompleteState(), boundCompletionEvents());
    expect(codes).toEqual([]);
  });

  it('skips non-regulated sessions', () => {
    const state = makeState('COMPLETE', { reviewDecision: REVIEW_APPROVE });
    const { codes } = run(state, boundCompletionEvents());
    expect(codes).toEqual([]);
  });

  it('fails closed on a regulated archive whose snapshot is not terminal', () => {
    const state = makeState('EVIDENCE_REVIEW', {
      policySnapshot: REGULATED_POLICY_SNAPSHOT,
      reviewDecision: REVIEW_APPROVE,
      regulatedArchiveStatus: 'pending',
      transition: {
        from: 'EXPORT_READY',
        to: 'COMPLETE',
        event: 'EXPORT_MATERIALIZED',
        at: AT,
      },
    });
    const { codes } = run(state, boundCompletionEvents());
    expect(codes).toContain('regulated_terminal_transition_missing');
  });

  it('rejects a terminal transition that is not EXPORT_READY EXPORT_MATERIALIZED to COMPLETE', () => {
    const state = makeState('COMPLETE', {
      policySnapshot: REGULATED_POLICY_SNAPSHOT,
      reviewDecision: REVIEW_APPROVE,
      regulatedArchiveStatus: 'verified',
      transition: { from: 'IMPL_REVIEW', to: 'COMPLETE', event: 'APPROVE', at: AT },
    });
    const { codes } = run(state, boundCompletionEvents());
    expect(codes).toContain('regulated_terminal_transition_missing');
  });

  it('rejects when reviewDecision is not an approval authority', () => {
    const state = regulatedCompleteState({
      ...REVIEW_APPROVE,
      verdict: 'changes_requested' as const,
    });
    const { codes } = run(state, boundCompletionEvents());
    expect(codes).toContain('regulated_terminal_decision_invalid');
  });

  it.each([
    { override: { verdict: 'reject' }, label: 'verdict', expectedMessage: 'reviewDecision' },
    { override: { rationale: 'other' }, label: 'rationale', expectedMessage: 'reviewDecision' },
    {
      override: {
        decisionIdentity: {
          actorId: 'other-reviewer',
          actorEmail: 'other@test.com',
          actorSource: 'env',
          actorAssurance: 'best_effort',
        },
      },
      label: 'decisionIdentity',
      expectedMessage: 'decisionIdentity',
    },
    {
      override: { decidedAt: '2025-12-31T23:59:59.000Z' },
      label: 'decidedAt',
      expectedMessage: 'reviewDecision',
    },
  ])('binds the decision receipt $label to reviewDecision', ({ override, expectedMessage }) => {
    const { findings } = run(regulatedCompleteState(), boundCompletionEvents(override));
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'regulated_terminal_decision_invalid',
        message: expect.stringContaining(expectedMessage),
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
    const { findings } = run(
      state,
      boundCompletionEvents({ decisionIdentity: { actorId: 'other-reviewer' } }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'regulated_terminal_decision_invalid',
        message: expect.stringContaining('decisionIdentity'),
      }),
    );
  });

  it.each([
    { actor: 'reviewer-1', label: 'the legacy deciding-authority actor field' },
    { actor: 'human', label: 'the policy classification actor field' },
  ])('accepts $label while binding identity via decisionIdentity ($actor)', ({ actor }) => {
    const events = boundCompletionEvents();
    events[1] = { ...events[1]!, actor };
    const { codes } = run(regulatedCompleteState(), events);
    expect(codes).toEqual([]);
  });

  it('accepts a governance-override approval for a regulated completion', () => {
    const state = regulatedCompleteState({
      ...REVIEW_APPROVE,
      verdict: 'approve_with_governance_override',
    });
    const { codes } = run(
      state,
      boundCompletionEvents({ verdict: 'approve_with_governance_override' }),
    );
    expect(codes).toEqual([]);
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
    const { findings } = run(
      state,
      boundCompletionEvents({
        decisionIdentity: {
          actorId: 'reviewer-1',
          actorEmail: 'reviewer-2@regulated.dev',
          actorSource: 'env',
          actorAssurance: 'claim_validated',
        },
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'regulated_terminal_decision_invalid',
        message: expect.stringContaining('decisionIdentity'),
      }),
    );
  });

  it('flags out-of-order completion evidence', () => {
    const { codes } = run(regulatedCompleteState(), [
      approvalTransitionEvent(),
      lifecycleEvent(),
      decisionEvent(),
      exportTransitionEvent(),
    ]);
    expect(codes).toContain('regulated_completion_order_invalid');
  });

  it('flags duplicate terminal decisions', () => {
    const { codes } = run(regulatedCompleteState(), [
      approvalTransitionEvent(),
      decisionEvent(),
      decisionEvent({ decisionId: 'DEC-002' }),
      exportTransitionEvent(),
      lifecycleEvent(),
    ]);
    expect(codes).toContain('regulated_terminal_decision_invalid');
  });

  it('flags a missing approval transition', () => {
    const { codes } = run(regulatedCompleteState(), [
      decisionEvent(),
      exportTransitionEvent(),
      lifecycleEvent(),
    ]);
    expect(codes).toContain('regulated_terminal_transition_missing');
  });

  it('flags a missing export transition', () => {
    const { codes } = run(regulatedCompleteState(), [
      approvalTransitionEvent(),
      decisionEvent(),
      lifecycleEvent(),
    ]);
    expect(codes).toContain('regulated_terminal_transition_missing');
  });

  it('binds the lifecycle finalPhase exactly to the completion transition target', () => {
    const events = boundCompletionEvents();
    const lifecycle = events[3]!;
    events[3] = {
      ...lifecycle,
      detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'ARCH_COMPLETE' },
    };
    const { codes } = run(regulatedCompleteState(), events);
    expect(codes).toContain('regulated_completion_lifecycle_invalid');
  });
});
