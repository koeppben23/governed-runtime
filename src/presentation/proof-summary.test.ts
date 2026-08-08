/**
 * @test-policy
 * RENDERER: renders declaration sections with claim counts, falsification warnings,
 *           and AWAITING EVIDENCE status.
 * RENDERER: renders evaluation sections with headline (PROVEN/CONTRADICTED/etc.),
 *           highlighted claims with reason and recovery, tally counts,
 *           revision digest, evidence freshness, and detail-view pointer.
 * CORNER: PROVEN headline → no blocking claims, summary tally only.
 * CORNER: CONTRADICTED headline → reason "falsified" without invented scenario text.
 * CORNER: STALE headline → reason does not assert implementation change.
 * CORNER: BLOCKED headline → reason about provider failure.
 * EDGE: declaration with no critical claims → no falsification warning.
 * EDGE: empty highlightedClaims → no claim detail section.
 * PERF: pure functions, no I/O.
 */

import { describe, expect, it } from 'vitest';
import { renderCompactProofSection, buildProofGraphSection } from './proof-summary.js';
import type { ClaimVerificationState, CompactProofPresentation } from './proof-model.js';

function makeDeclaration(opts?: {
  flow?: 'plan' | 'architecture';
  claimCount?: number;
  criticalCount?: number;
  falsificationReadyCount?: number;
  missingFalsificationCount?: number;
}): CompactProofPresentation {
  return {
    kind: 'declaration',
    flow: opts?.flow ?? 'plan',
    overallStatus: 'AWAITING_EVIDENCE',
    claimCount: opts?.claimCount ?? 3,
    criticalCount: opts?.criticalCount ?? 3,
    falsificationReadyCount: opts?.falsificationReadyCount,
    missingFalsificationCount: opts?.missingFalsificationCount,
    approval: { attestations: [] },
  };
}

function makeEvaluation(
  headlineStatus: ClaimVerificationState,
  opts?: {
    provenCount?: number;
    contradictedCount?: number;
    blockedCount?: number;
    staleCount?: number;
    unprovenCount?: number;
    notVerifiedCount?: number;
    decisionContext?: 'current_gate' | 'prospective_approval' | 'completion';
    revisionDigest?: string;
    evidenceFreshness?: 'CURRENT' | 'STALE' | 'NOT_VERIFIED';
  },
): CompactProofPresentation {
  return {
    kind: 'evaluation',
    overallStatus: headlineStatus,
    claimCount: 5,
    criticalCount: 3,
    criticalProvenCount: headlineStatus === 'PROVEN' ? 3 : 0,
    provenCount: opts?.provenCount ?? 2,
    contradictedCount: opts?.contradictedCount ?? 0,
    blockedCount: opts?.blockedCount ?? 0,
    staleCount: opts?.staleCount ?? 0,
    unprovenCount: opts?.unprovenCount ?? 0,
    notVerifiedCount: opts?.notVerifiedCount ?? 0,
    coverage: headlineStatus === 'PROVEN' ? 'PROVEN' : 'NOT_VERIFIED',
    headlineStatus,
    decisionContext: opts?.decisionContext ?? 'current_gate',
    revisionDigest: opts?.revisionDigest,
    evidenceFreshness: opts?.evidenceFreshness ?? 'CURRENT',
    approval: { attestations: [] },
    unmetCriticalClaims: [],
    otherHighlightedClaims: [],
  };
}

describe('renderCompactProofSection', () => {
  describe('declaration', () => {
    it('renders plan declaration with claim counts', () => {
      const result = renderCompactProofSection(makeDeclaration());
      expect(result).toContain('AWAITING_EVIDENCE');
      expect(result).toContain('3 plan claim(s) declared');
      expect(result).toContain('3 critical');
      expect(result).toContain('AWAITING_EVIDENCE');
    });

    it('renders architecture declaration', () => {
      const result = renderCompactProofSection(makeDeclaration({ flow: 'architecture' }));
      expect(result).toContain('3 architecture claim(s) declared');
    });

    it('warns about missing falsification checks', () => {
      const result = renderCompactProofSection(
        makeDeclaration({
          criticalCount: 3,
          falsificationReadyCount: 1,
          missingFalsificationCount: 2,
        }),
      );
      expect(result).toContain('2 critical claim(s) lack a counterexample check');
      expect(result).toContain('1 critical claim(s) with counterexample checks');
    });

    it('does not warn when all critical claims have falsification checks', () => {
      const result = renderCompactProofSection(
        makeDeclaration({
          criticalCount: 2,
          falsificationReadyCount: 2,
          missingFalsificationCount: 0,
        }),
      );
      expect(result).not.toContain('lack a counterexample check');
    });
  });

  describe('evaluation', () => {
    it('renders PROVEN headline', () => {
      const result = renderCompactProofSection(makeEvaluation('PROVEN', { provenCount: 5 }));
      expect(result).toContain('All critical claims PROVEN');
      expect(result).toContain('5 PROVEN');
      expect(result).toContain('Evidence lineage:');
    });

    it('renders CONTRADICTED headline with reason, no scenario text', () => {
      const pres = makeEvaluation('CONTRADICTED', {
        contradictedCount: 1,
        provenCount: 1,
      });
      (pres as Record<string, unknown>).unmetCriticalClaims = [
        {
          claimId: 'a'.repeat(36),
          statement: 'No SQL injection is possible.',
          status: 'CONTRADICTED',
          critical: true,
          reason: 'Fresh adversarial evidence falsified this claim.',
          recovery: ['Correct the implementation or revise the approved claim.'],
        },
      ];
      const result = renderCompactProofSection(pres);
      expect(result).toContain('CONTRADICTED');
      expect(result).toContain('falsified');
      expect(result).toContain('Fresh adversarial evidence falsified');
      expect(result).not.toContain('scenario');
      expect(result).toContain('Inspect the blocking claim');
      expect(result).toContain('1 CONTRADICTED');
    });

    it('renders BLOCKED headline with provider-failure reason', () => {
      const pres = makeEvaluation('BLOCKED', { blockedCount: 1 });
      (pres as Record<string, unknown>).unmetCriticalClaims = [
        {
          claimId: 'b'.repeat(36),
          statement: 'All API endpoints are covered.',
          status: 'BLOCKED',
          critical: true,
          reason: 'A required evidence provider could not produce a usable verdict.',
          recovery: ['Restore the unavailable or errored evidence provider and run it again.'],
        },
      ];
      const result = renderCompactProofSection(pres);
      expect(result).toContain('BLOCKED');
      expect(result).toContain('could not produce a usable verdict');
    });

    it('renders STALE headline without asserting implementation changed', () => {
      const pres = makeEvaluation('STALE', { staleCount: 1 });
      (pres as Record<string, unknown>).unmetCriticalClaims = [
        {
          claimId: 'c'.repeat(36),
          statement: 'Rate limiting is enforced.',
          status: 'STALE',
          critical: true,
          reason:
            'Previously recorded evidence is no longer current for the relevant revision or governed surface.',
        },
      ];
      const result = renderCompactProofSection(pres);
      expect(result).toContain('STALE');
      expect(result).toContain('no longer current');
      expect(result).not.toContain('implementation changed');
    });

    it('renders revision digest shorthand', () => {
      const result = renderCompactProofSection(
        makeEvaluation('PROVEN', {
          revisionDigest: 'abc123def4567890',
        }),
      );
      expect(result).toContain('Revision: `abc123def456`');
    });

    it('renders evidence freshness', () => {
      const result = renderCompactProofSection(
        makeEvaluation('PROVEN', { evidenceFreshness: 'STALE' }),
      );
      expect(result).toContain('Evidence freshness: Stale');
    });

    it('renders multiple approval attestations without collapsing their binding', () => {
      const presentation = makeEvaluation('PROVEN', { provenCount: 5 });
      if (presentation.kind !== 'evaluation') throw new Error('expected evaluation presentation');
      const result = renderCompactProofSection({
        ...presentation,
        approval: {
          attestations: [
            { flow: 'plan', certificateId: 'plan-cert', binding: 'current' },
            { flow: 'architecture', certificateId: 'architecture-cert', binding: 'current' },
          ],
        },
      });
      expect(result).toContain('- plan: Current (certificate `plan-cert`)');
      expect(result).toContain('- architecture: Current (certificate `architecture-cert`)');
      expect(result).not.toContain('Stale or unbound');
    });

    it('renders prospective approval prefix', () => {
      const pres = makeEvaluation('UNPROVEN', {
        unprovenCount: 1,
        decisionContext: 'prospective_approval',
      });
      (pres as Record<string, unknown>).unmetCriticalClaims = [
        {
          claimId: 'd'.repeat(36),
          statement: 'Memory safety is guaranteed.',
          status: 'UNPROVEN',
          critical: true,
          reason: 'The available evidence does not establish this claim.',
        },
      ];
      const result = renderCompactProofSection(pres);
      expect(result).toContain('If submitted for approval now:');
    });

    it('renders completion context without approval language', () => {
      const pres = makeEvaluation('UNPROVEN', {
        unprovenCount: 1,
        decisionContext: 'completion',
      });
      (pres as Record<string, unknown>).unmetCriticalClaims = [
        {
          claimId: 'e'.repeat(36),
          statement: 'Final unresolved claim.',
          status: 'UNPROVEN',
          critical: true,
          reason: 'The available evidence does not establish this claim.',
        },
      ];
      const result = renderCompactProofSection(pres);
      expect(result).not.toContain('If submitted for approval');
      expect(result).not.toContain('Current status:');
      expect(result).toContain('UNPROVEN');
    });

    it('renders primaryReason alongside highlighted claims (not instead)', () => {
      const pres = makeEvaluation('BLOCKED', { blockedCount: 1 });
      (pres as Record<string, unknown>).primaryReason =
        'The implementation risk assessment is outdated and must be refreshed.';
      (pres as Record<string, unknown>).unmetCriticalClaims = [
        {
          claimId: 'f'.repeat(36),
          statement: 'Additional claim still unresolved.',
          status: 'UNPROVEN',
          critical: true,
          reason: 'The available evidence does not establish this claim.',
        },
      ];
      const result = renderCompactProofSection(pres);
      // Both the gate reason and the claim detail appear
      expect(result).toContain('The implementation risk assessment is outdated');
      expect(result).toContain('"Additional claim still unresolved."');
      // The gate reason must appear before the claim detail
      const reasonIdx = result.indexOf('risk assessment is outdated');
      const claimIdx = result.indexOf('Additional claim');
      expect(reasonIdx).toBeLessThan(claimIdx);
    });

    it('renders primaryReason when there are no highlighted claims', () => {
      const pres = makeEvaluation('BLOCKED', { blockedCount: 0 });
      (pres as Record<string, unknown>).primaryReason =
        'The ProofGraph evaluator could not produce a verdict.';
      const result = renderCompactProofSection(pres);
      expect(result).toContain('The ProofGraph evaluator could not produce a verdict');
    });

    it('tally includes all relevant counts', () => {
      const result = renderCompactProofSection(
        makeEvaluation('UNPROVEN', {
          provenCount: 3,
          contradictedCount: 1,
          blockedCount: 1,
          staleCount: 0,
          unprovenCount: 1,
          notVerifiedCount: 0,
        }),
      );
      expect(result).toContain('3 PROVEN');
      expect(result).toContain('1 CONTRADICTED');
      expect(result).toContain('1 BLOCKED');
      expect(result).toContain('1 UNPROVEN');
      // STALE and NOT_VERIFIED should not appear when zero
      expect(result).not.toContain('0 STALE');
      expect(result).not.toContain('0 NOT_VERIFIED');
    });
  });
});

describe('buildProofGraphSection', () => {
  it('returns a typed proofGraph section', () => {
    const section = buildProofGraphSection(makeEvaluation('PROVEN', { provenCount: 1 }));
    expect(section.kind).toBe('proofGraph');
    expect(section.proof.overallStatus).toBe('PROVEN');
  });

  it('preserves declaration semantics in a typed section', () => {
    const decl = makeDeclaration({ flow: 'plan', claimCount: 1, criticalCount: 1 });
    const section = buildProofGraphSection(decl);
    expect(section.kind).toBe('proofGraph');
    expect(section.proof.claimCount).toBe(1);
  });
});
