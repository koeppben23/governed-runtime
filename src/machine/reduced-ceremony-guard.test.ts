/**
 * @module machine/reduced-ceremony-guard.test
 * @description Pure machine-guard invariants for reduced ceremony: the digest
 * triangle alone is not risk authority. A stale or escalated assessment, a
 * blocked risk gate, a non-TRIVIAL claim or a mismatched basis must all fail
 * closed without duplicating the integration classifier.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { describe, expect, it } from 'vitest';

import {
  IMPL_EVIDENCE,
  makeState,
  POLICY_SNAPSHOT,
  VALIDATION_PASSED,
  VERIFICATION_CANDIDATES,
} from '../fixtures.js';
import type {
  ImplementationRiskAssessment,
  ReducedCeremonyDecision,
  SessionState,
} from '../state/schema.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { hashText } from '../shared/hashing.js';
import {
  parseTicketRiskDeclaration,
  type TicketRiskDeclaration,
} from '../state/risk-declaration.js';
import { reducedCeremonyReady } from './guards.js';

const DOC_IMPL = {
  ...IMPL_EVIDENCE,
  changedFiles: ['docs/usage-notes.md'],
  domainFiles: [],
};

const TEST_ATTEMPT_ID = '00000000-0000-4000-8000-0000000000a1';
const LINT_ATTEMPT_ID = '00000000-0000-4000-8000-0000000000a2';

function attempt(checkId: string) {
  const base = VALIDATION_PASSED[checkId === 'test' ? 0 : 1]!;
  return {
    attemptId: checkId === 'test' ? TEST_ATTEMPT_ID : LINT_ATTEMPT_ID,
    scope: 'implementation' as const,
    implementationId: DOC_IMPL.implementationId,
    implementationDigest: DOC_IMPL.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: { ...base, checkId, passed: true },
  };
}

const RISK_ASSESSMENT: ImplementationRiskAssessment = {
  computedMinimumTaskClass: 'TRIVIAL',
  effectiveTaskClass: 'TRIVIAL',
  declaredTaskClass: null,
  declarationKind: 'absent' as const,
  ticketDigest: null,
  touchedSurfaces: ['docs/usage-notes.md'],
  riskTriggers: [],
  assessedFrom: 'implementation_changed_files',
  assessedFileCount: 1,
  implementationDigest: DOC_IMPL.digest,
};

const POLICY = {
  ...POLICY_SNAPSHOT,
  allowReducedCeremony: true,
  requireHumanGates: true,
  effectiveGateBehavior: 'human_gated' as const,
};

const DECISION: ReducedCeremonyDecision = {
  profile: 'reduced',
  reason: 'POST_IMPL_VERIFIED_TRIVIAL',
  effectiveTaskClass: 'TRIVIAL',
  declaredTaskClass: null,
  declarationKind: 'absent' as const,
  ticketDigest: null,
  computedMinimumTaskClass: 'TRIVIAL',
  touchedSurfaces: ['docs/usage-notes.md'],
  implementationId: DOC_IMPL.implementationId,
  implementationDigest: DOC_IMPL.digest,
  policyDigest: POLICY.hash,
  verificationBasis: {
    checkIds: ['test', 'lint'],
    attempts: [
      { checkId: 'test', attemptId: TEST_ATTEMPT_ID, executedAt: VALIDATION_PASSED[0]!.executedAt },
      { checkId: 'lint', attemptId: LINT_ATTEMPT_ID, executedAt: VALIDATION_PASSED[1]!.executedAt },
    ],
  },
  decidedAt: '2026-01-02T00:00:00.000Z',
};

function boundState(overrides: Partial<SessionState> = {}): SessionState {
  return makeState('IMPL_VALIDATION', {
    verificationCandidates: VERIFICATION_CANDIDATES,
    implementation: DOC_IMPL,
    implementationRiskAssessment: RISK_ASSESSMENT,
    activeChecks: ['test', 'lint'],
    implValidation: VALIDATION_PASSED,
    validationAttempts: [attempt('test'), attempt('lint')],
    policySnapshot: POLICY,
    reducedCeremony: DECISION,
    ...overrides,
  });
}

function ticketFor(text: string): NonNullable<SessionState['ticket']> {
  return {
    text,
    digest: hashText(text),
    source: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    riskDeclaration: parseTicketRiskDeclaration(text),
  };
}

function bindAssessmentToTicket(
  ticket: NonNullable<SessionState['ticket']>,
  overrides: Partial<ImplementationRiskAssessment> = {},
): ImplementationRiskAssessment {
  const declaration = ticket.riskDeclaration;
  return {
    ...RISK_ASSESSMENT,
    ticketDigest: ticket.digest,
    declarationKind: declaration.kind,
    declaredTaskClass: declaration.kind === 'declared' ? declaration.taskClass : null,
    effectiveTaskClass: declaration.kind === 'declared' ? declaration.taskClass : 'TRIVIAL',
    ...overrides,
  };
}

function decisionFor(
  ticket: NonNullable<SessionState['ticket']>,
  declaration: TicketRiskDeclaration,
  overrides: Partial<ReducedCeremonyDecision> = {},
): ReducedCeremonyDecision {
  const declaredTaskClass = declaration.kind === 'declared' ? declaration.taskClass : null;
  return {
    ...DECISION,
    effectiveTaskClass: declaredTaskClass ?? 'TRIVIAL',
    declaredTaskClass,
    declarationKind: declaration.kind,
    ticketDigest: ticket.digest,
    ...overrides,
  };
}

describe('reducedCeremonyReady binding invariants', () => {
  it('HAPPY: accepts only the fully bound decision', () => {
    expect(reducedCeremonyReady(boundState())).toBe(true);
  });

  it('BAD: a HIGH-RISK assessment rejects the decision', () => {
    const state = boundState({
      implementationRiskAssessment: { ...RISK_ASSESSMENT, computedMinimumTaskClass: 'HIGH-RISK' },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a changed assessment digest rejects the decision', () => {
    const state = boundState({
      implementationRiskAssessment: { ...RISK_ASSESSMENT, implementationDigest: 'other' },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a blocked risk gate rejects the decision', () => {
    const state = boundState({
      riskGate: {
        status: 'blocked',
        code: 'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
        message: 'blocked',
        blockedAt: '2026-01-02T00:00:00.000Z',
        lastDecisionId: 'RISK-1',
      },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a non-TRIVIAL claim rejects the decision', () => {
    expect(reducedCeremonyReady(boundState({ claimedTaskClass: 'STANDARD' }))).toBe(false);
  });

  it('BAD: a decision with a non-TRIVIAL computed class rejects', () => {
    const state = boundState({
      reducedCeremony: { ...DECISION, computedMinimumTaskClass: 'HIGH-RISK' },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a decision claimed as STANDARD rejects', () => {
    const state = boundState({ reducedCeremony: { ...DECISION, effectiveTaskClass: 'STANDARD' } });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: disabled policy flags reject the decision', () => {
    expect(
      reducedCeremonyReady(
        boundState({ policySnapshot: { ...POLICY, allowReducedCeremony: false } }),
      ),
    ).toBe(false);
    expect(
      reducedCeremonyReady(boundState({ policySnapshot: { ...POLICY, requireHumanGates: false } })),
    ).toBe(false);
  });

  it('EDGE: a basis that no longer matches the canonical evidence rejects', () => {
    const state = boundState({
      reducedCeremony: {
        ...DECISION,
        verificationBasis: {
          ...DECISION.verificationBasis,
          attempts: DECISION.verificationBasis.attempts.map((entry, index) =>
            index === 0 ? { ...entry, attemptId: '00000000-0000-4000-8000-0000000000ff' } : entry,
          ),
        },
      },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('EDGE: a changed policy hash rejects the decision', () => {
    const state = boundState({ reducedCeremony: { ...DECISION, policyDigest: 'b'.repeat(64) } });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('EDGE: a changed executedAt in the stored basis rejects', () => {
    const state = boundState({
      reducedCeremony: {
        ...DECISION,
        verificationBasis: {
          ...DECISION.verificationBasis,
          attempts: DECISION.verificationBasis.attempts.map((entry, index) =>
            index === 0 ? { ...entry, executedAt: '2026-02-01T00:00:00.000Z' } : entry,
          ),
        },
      },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('EDGE: touched surfaces that no longer match the frozen file list reject', () => {
    const state = boundState({
      implementationRiskAssessment: { ...RISK_ASSESSMENT, touchedSurfaces: ['config'] },
    });
    expect(reducedCeremonyReady(state)).toBe(false);

    const decisionDrift = boundState({
      reducedCeremony: { ...DECISION, touchedSurfaces: ['config'] },
    });
    expect(reducedCeremonyReady(decisionDrift)).toBe(false);

    expect(reducedCeremonyReady(boundState())).toBe(true);
  });

  it('BAD: a forged TRIVIAL assessment over a HIGH-RISK file list rejects', () => {
    const implementation = {
      ...DOC_IMPL,
      changedFiles: ['src/machine/guards.ts'],
      domainFiles: ['src/machine/guards.ts'],
    };
    const state = boundState({
      implementation,
      implementationRiskAssessment: { ...RISK_ASSESSMENT, assessedFileCount: 1 },
      reducedCeremony: { ...DECISION },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });
  it('HAPPY: a ticket-declared TRIVIAL bound to its digest is accepted', () => {
    const ticket = ticketFor('Risk: TRIVIAL\n\nDocs only.');
    const state = boundState({
      ticket,
      implementationRiskAssessment: bindAssessmentToTicket(ticket),
      reducedCeremony: decisionFor(ticket, ticket.riskDeclaration),
    });
    expect(reducedCeremonyReady(state)).toBe(true);
  });

  it('BAD: a stale assessment from a previous ticket rejects', () => {
    const previousTicket = ticketFor('Risk: TRIVIAL\n\nOld scope.');
    const currentTicket = ticketFor('Risk: TRIVIAL\n\nNew scope.');
    const state = boundState({
      ticket: currentTicket,
      implementationRiskAssessment: bindAssessmentToTicket(previousTicket),
      reducedCeremony: decisionFor(currentTicket, currentTicket.riskDeclaration),
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a ticket-declared STANDARD rejects even for a docs-only change', () => {
    const ticket = ticketFor('Risk: STANDARD\n\nDocs only.');
    const state = boundState({
      ticket,
      implementationRiskAssessment: bindAssessmentToTicket(ticket),
      reducedCeremony: decisionFor(ticket, ticket.riskDeclaration),
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a decision claiming TRIVIAL while the ticket declares STANDARD rejects', () => {
    const ticket = ticketFor('Risk: STANDARD\n\nDocs only.');
    const state = boundState({
      ticket,
      implementationRiskAssessment: bindAssessmentToTicket(ticket),
      reducedCeremony: decisionFor(ticket, { kind: 'declared', taskClass: 'TRIVIAL' }),
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: conflict and invalid ticket declarations reject', () => {
    const conflict = ticketFor('Risk: TRIVIAL\nRisk: HIGH-RISK');
    expect(reducedCeremonyReady(boundState({ ticket: conflict }))).toBe(false);
    const invalid = ticketFor('Risk: HIGH');
    expect(reducedCeremonyReady(boundState({ ticket: invalid }))).toBe(false);
  });

  it('BAD: a stale ticket digest on the decision rejects', () => {
    const ticket = ticketFor('Risk: TRIVIAL');
    const stale: SessionState['ticket'] = { ...ticket, digest: 'stale-digest' };
    const state = boundState({
      ticket,
      reducedCeremony: decisionFor(stale, ticket.riskDeclaration),
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a manipulated declaration that no longer matches the ticket text rejects', () => {
    const ticket = {
      ...ticketFor('Risk: TRIVIAL'),
      riskDeclaration: { kind: 'declared', taskClass: 'STANDARD' } as const,
    };
    const state = boundState({
      ticket,
      reducedCeremony: decisionFor(ticketFor('Risk: TRIVIAL'), ticket.riskDeclaration),
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });
});
