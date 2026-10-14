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
});
