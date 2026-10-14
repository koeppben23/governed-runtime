import { describe, expect, it } from 'vitest';
import { makeProgressedState, FIXED_TIME } from '../../fixtures.js';
import {
  consumeEvidenceApprovalAdmission,
  issueEvidenceApprovalAdmission,
} from './evidence-approval-admission.js';
import type { SessionState } from '../../state/schema.js';

function setup() {
  const predecessor = makeProgressedState('EVIDENCE_REVIEW');
  const state: SessionState = {
    ...predecessor,
    phase: 'EXPORT_READY',
    transition: { from: 'EVIDENCE_REVIEW', to: 'EXPORT_READY', event: 'APPROVE', at: FIXED_TIME },
  };
  return { predecessor, state, admission: issueEvidenceApprovalAdmission(state) };
}
describe('approval capability consumption', () => {
  it.each([null, undefined, 'handle', {}, { kind: 'evidence-approval-admission' }])(
    'rejects unauthentic handles (%j)',
    (admission) => {
      expect(consumeEvidenceApprovalAdmission({ ...setup(), admission }).kind).toBe('rejected');
    },
  );
  it('consumes only once', () => {
    const input = setup();
    expect(consumeEvidenceApprovalAdmission(input).kind).toBe('accepted');
    expect(consumeEvidenceApprovalAdmission(input).kind).toBe('rejected');
  });
  it.each([
    (s: SessionState) => ({ ...s, flowguardSessionId: '00000000-0000-4000-8000-000000000099' }),
    (s: SessionState) => ({ ...s, binding: { ...s.binding, fingerprint: 'foreign' } }),
    (s: SessionState) => ({ ...s, implementationRework: { rejectedDigest: 'x', exhausted: true } }),
    (s: SessionState) => ({
      ...s,
      implementation: { ...s.implementation!, executedAt: '2030-01-01T00:00:00.000Z' },
    }),
    (s: SessionState) => ({ ...s, initiatedBy: 'foreign' }),
    (s: SessionState) => ({ ...s, ticket: null }),
  ])('rejects authority/binding drift', (mutate) => {
    const input = setup();
    expect(consumeEvidenceApprovalAdmission({ ...input, state: mutate(input.state) }).kind).toBe(
      'rejected',
    );
  });
  it('rejects predecessor drift and transition replay', () => {
    const input = setup();
    expect(
      consumeEvidenceApprovalAdmission({
        ...input,
        predecessor: { ...input.predecessor, ticket: null },
      }).kind,
    ).toBe('rejected');
    expect(
      consumeEvidenceApprovalAdmission({ ...input, state: { ...input.state, transition: null } })
        .kind,
    ).toBe('rejected');
  });

  // Each dedicated check is proven by its own reason, not only by `kind`:
  // session and binding are also part of the basis, so a kind-only assertion
  // could not show which branch rejected.
  it.each([
    [
      'a forged lookalike handle',
      (input: ReturnType<typeof setup>) => ({
        ...input,
        admission: { kind: 'evidence-approval-admission' },
      }),
      'not issued by this runtime',
    ],
    [
      'a foreign session',
      (input: ReturnType<typeof setup>) => ({
        ...input,
        state: { ...input.state, flowguardSessionId: '00000000-0000-4000-8000-000000000099' },
      }),
      'belongs to another session',
    ],
    [
      'a foreign worktree binding',
      (input: ReturnType<typeof setup>) => ({
        ...input,
        state: { ...input.state, binding: { ...input.state.binding, fingerprint: 'foreign' } },
      }),
      'belongs to another worktree binding',
    ],
    [
      'a missing predecessor',
      (input: ReturnType<typeof setup>) => ({ ...input, predecessor: null }),
      'persisted predecessor changed',
    ],
    [
      'a replaced applied transition',
      (input: ReturnType<typeof setup>) => ({
        ...input,
        state: { ...input.state, transition: null },
      }),
      'applied approval transition changed',
    ],
    [
      'evidence drift after admission',
      (input: ReturnType<typeof setup>) => ({
        ...input,
        state: { ...input.state, ticket: null },
      }),
      'evidence basis changed',
    ],
  ])('rejects %s through its dedicated check', (_label, mutate, reason) => {
    const result = consumeEvidenceApprovalAdmission(mutate(setup()));
    expect(result).toMatchObject({ kind: 'rejected' });
    expect(result.kind === 'rejected' ? result.reason : '').toContain(reason);
  });

  it('a rejected consumption does not burn the admission', () => {
    const input = setup();
    expect(consumeEvidenceApprovalAdmission({ ...input, predecessor: null }).kind).toBe('rejected');
    expect(consumeEvidenceApprovalAdmission(input).kind).toBe('accepted');
  });
});
