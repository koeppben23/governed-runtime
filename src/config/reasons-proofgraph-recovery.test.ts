/** Recovery copy must describe the executable topology, including the external session handoff. */
import { describe, expect, it } from 'vitest';
import { defaultReasonRegistry } from './reasons.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import { resolveTransition } from '../machine/topology.js';

const AUTHORITY_REASONS = [
  'PROOFGRAPH_CERTIFICATE_INVALID',
  'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
  'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
  'PROOFGRAPH_CLAIM_UNSATISFIABLE',
  'PROOFGRAPH_CLAIM_NOT_DECLARED',
  'PROOFGRAPH_COUNTEREXAMPLE_OBSERVED',
  'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
  'PROOFGRAPH_EVIDENCE_ROLE_COLLISION',
];

describe('ProofGraph recovery reachability', () => {
  it.each(AUTHORITY_REASONS)('%s supplies a truthful two-session authority recovery', (code) => {
    const copy = defaultReasonRegistry
      .format(code, {
        claimRef: 'claim',
        claimId: 'claim',
        claimIds: 'claim',
        triggers: 'state_integrity',
        field: 'claims',
        detail: 'invalid',
        consequence: 'blocked',
      })
      .recovery.join('\n');
    expect(copy).toContain('different host-session id');
    expect(copy).toContain('distinct FlowGuard session id');
    expect(copy).toContain('original trusted pre-change base');
    expect(copy).toContain('explicit user instruction');
    expect(copy).toContain('governed host-mutation contract');
    expect(copy).toContain('identical code bytes');
    expect(copy).toContain('report that recovery prerequisite as blocked');
    expect(copy).not.toContain('Request changes to return to plan');
    expect(copy).not.toContain('Return to plan review');
  });

  it('advertises commands at their actual positions, with no implicit backward transition', () => {
    expect(isCommandAllowed('EVIDENCE_REVIEW', Command.REVIEW_DECISION)).toBe(true);
    const repair = resolveTransition('EVIDENCE_REVIEW', 'CHANGES_REQUESTED');
    expect(repair).toBe('IMPLEMENTATION');
    expect(isCommandAllowed(repair!, Command.IMPLEMENT)).toBe(true);
    expect(isCommandAllowed(repair!, Command.PLAN)).toBe(false);
    expect(isCommandAllowed('EVIDENCE_REVIEW', Command.PLAN)).toBe(false);
    expect(isCommandAllowed('EVIDENCE_REVIEW', Command.ABORT)).toBe(true);
    expect(resolveTransition('EVIDENCE_REVIEW', 'ABORT')).toBe('ABORTED');
    expect(isCommandAllowed('ABORTED', Command.HYDRATE)).toBe(true);
    expect(isCommandAllowed('ABORTED', Command.TICKET)).toBe(false);
    expect(isCommandAllowed('READY', Command.HYDRATE)).toBe(true);
    expect(isCommandAllowed('READY', Command.TICKET)).toBe(true);
    expect(isCommandAllowed('TICKET', Command.PLAN)).toBe(true);
    expect(resolveTransition('PLAN_REVIEW', 'CHANGES_REQUESTED')).toBe('PLAN');
    expect(isCommandAllowed('PLAN', Command.PLAN)).toBe(true);
  });

  it.each(['PROOFGRAPH_EVALUATION_UNAVAILABLE', 'PROOFGRAPH_RISK_ASSESSMENT_STALE'])(
    '%s repairs evidence through recording, checks and review, without changing approved claims',
    (code) => {
      const recovery = defaultReasonRegistry
        .format(code, { claimIds: 'claim' })
        .recovery.join('\n');
      expect(recovery).toContain('IMPLEMENTATION');
      expect(recovery).toContain('/implement');
      expect(recovery).toContain('/check');
      expect(recovery).not.toContain('return to PLAN');
    },
  );
});
