/**
 * @module presentation/evidence-review-card.test
 * @description Tests for the EVIDENCE_REVIEW card builder and shared decision projection.
 */

import { describe, expect, it } from 'vitest';
import { buildEvidenceReviewCard } from './evidence-review-card.js';
import { buildReviewDecisionConclusion } from './review-decision.js';
import type { CompactProofPresentation } from './proof-model.js';

const EVIDENCE_ACTION_DESCRIPTIONS: Record<string, string> = {
  '/approve': 'approve the implementation evidence',
  '/request-changes': 'return to implementation for revision',
  '/reject': 'discard this implementation',
};

const PLAN_ACTION_DESCRIPTIONS: Record<string, string> = {
  '/approve': 'approve the plan if it is complete and acceptable',
  '/request-changes': 'send the plan back for revision',
  '/reject': 'stop this task',
};

const productNextAction = {
  text: 'Review the implementation evidence.',
  commands: ['/approve', '/request-changes', '/reject'] as readonly string[],
};

const terminalNextAction = {
  text: 'Workflow complete.',
  commands: [] as readonly string[],
};

const evalProofSummary: CompactProofPresentation = {
  kind: 'evaluation',
  overallStatus: 'PROVEN',
  headlineStatus: 'PROVEN',
  claimCount: 2,
  criticalCount: 1,
  criticalProvenCount: 1,
  provenCount: 2,
  unprovenCount: 0,
  contradictedCount: 0,
  blockedCount: 0,
  staleCount: 0,
  notVerifiedCount: 0,
  coverage: 'PROVEN',
  unmetCriticalClaims: [],
  otherHighlightedClaims: [],
  evidenceFreshness: 'CURRENT',
  approval: { attestations: [] },
  decisionContext: 'current_gate',
};

describe('buildReviewDecisionConclusion', () => {
  it('returns decision_required when /approve is in commands', () => {
    const conclusion = buildReviewDecisionConclusion(
      { text: 'Decide.', commands: ['/approve', '/request-changes'] },
      PLAN_ACTION_DESCRIPTIONS,
    );
    expect(conclusion.kind).toBe('decision_required');
    if (conclusion.kind === 'decision_required') {
      expect(conclusion.actions).toHaveLength(2);
      expect(conclusion.actions.map((a) => a.invocation)).toEqual(['/approve', '/request-changes']);
    }
  });

  it('returns terminal when no gate commands are present', () => {
    const conclusion = buildReviewDecisionConclusion(terminalNextAction, PLAN_ACTION_DESCRIPTIONS);
    expect(conclusion.kind).toBe('terminal');
  });

  it('uses the provided description map per card context', () => {
    const planConclusion = buildReviewDecisionConclusion(
      { text: 'Decide.', commands: ['/approve'] },
      PLAN_ACTION_DESCRIPTIONS,
    );
    const evidenceConclusion = buildReviewDecisionConclusion(
      { text: 'Decide.', commands: ['/approve'] },
      EVIDENCE_ACTION_DESCRIPTIONS,
    );
    if (
      planConclusion.kind === 'decision_required' &&
      evidenceConclusion.kind === 'decision_required'
    ) {
      expect(planConclusion.actions[0]?.description).toContain('plan');
      expect(evidenceConclusion.actions[0]?.description).toContain('implementation');
    }
  });
});

describe('buildEvidenceReviewCard', () => {
  const baseInput = {
    phaseLabel: 'Ready for final review',
    productNextAction,
    proofSummary: evalProofSummary,
    statusLine: 'Implementation review converged at iteration 1. Reviewer accepted.',
  };

  it('renders # FlowGuard Implementation Review as the card title', () => {
    const card = buildEvidenceReviewCard(baseInput);
    expect(card).toContain('# FlowGuard Implementation Review');
  });

  it('includes status line and phase in key-value metadata', () => {
    const card = buildEvidenceReviewCard(baseInput);
    expect(card).toContain(baseInput.statusLine);
    expect(card).toContain(baseInput.phaseLabel);
  });

  it('includes ## ProofGraph section via canonical buildProofGraphSection', () => {
    const card = buildEvidenceReviewCard(baseInput);
    expect(card).toContain('## ProofGraph');
    expect(card).toContain('All critical claims PROVEN');
  });

  it('includes ## Decision required with gate commands when commands present', () => {
    const card = buildEvidenceReviewCard(baseInput);
    expect(card).toContain('## Decision required');
    expect(card).toContain('/approve');
    expect(card).toContain('/request-changes');
    expect(card).toContain('/reject');
    expect(card).toContain('approve the implementation evidence');
    expect(card).toContain('return to implementation for revision');
    expect(card).toContain('discard this implementation');
  });

  it('omits ## Decision required when no gate commands present', () => {
    const card = buildEvidenceReviewCard({
      ...baseInput,
      productNextAction: terminalNextAction,
    });
    expect(card).not.toContain('## Decision required');
  });

  it('renders the decision gate with its mandatory ProofGraph summary', () => {
    const card = buildEvidenceReviewCard({
      ...baseInput,
      proofSummary: evalProofSummary,
    });
    expect(card).toContain('# FlowGuard Implementation Review');
    expect(card).toContain(baseInput.statusLine);
    expect(card).toContain('## ProofGraph');
    expect(card).toContain('## Decision required');
    expect(card).toContain('/approve');
    expect(card).toContain('/request-changes');
    expect(card).toContain('/reject');
  });

  it('renders force-convergence warning when forcedConvergence is true', () => {
    const card = buildEvidenceReviewCard({
      ...baseInput,
      forcedConvergence: true,
      statusLine: 'Implementation review reached max iterations (3/3). Force-converged.',
    });
    expect(card).toContain('Reviewer did NOT approve this implementation');
  });

  it('renders accepted advisory implementation findings', () => {
    const card = buildEvidenceReviewCard({
      ...baseInput,
      majorRisks: [
        {
          severity: 'major',
          category: 'correctness',
          message: 'Concurrent updates may race.',
          location: 'src/updates.ts',
        },
      ],
      missingVerification: ['No integration test covers concurrent updates.'],
      unknowns: ['Production contention is unknown.'],
    });
    expect(card).toContain('## Reviewer Findings');
    expect(card).toContain('Concurrent updates may race.');
    expect(card).toContain('## Missing Verification (1)');
    expect(card).toContain('No integration test covers concurrent updates.');
    expect(card).toContain('## Unknowns (1)');
    expect(card).toContain('Production contention is unknown.');
  });

  it('ASCII glyph profile uses [WARN] prefix for force-convergence', () => {
    const card = buildEvidenceReviewCard(
      {
        ...baseInput,
        forcedConvergence: true,
        statusLine: 'Implementation review reached max iterations (3/3). Force-converged.',
      },
      { glyphProfile: 'ascii' },
    );
    expect(card).toContain('[WARN]');
  });

  it('omits force-convergence warning when forcedConvergence is false', () => {
    const card = buildEvidenceReviewCard(baseInput);
    expect(card).not.toContain('Reviewer did NOT approve');
  });

  it('ProofGraph section appears before ## Decision required', () => {
    const card = buildEvidenceReviewCard(baseInput);
    const proofGraphIdx = card.indexOf('## ProofGraph');
    const decisionIdx = card.indexOf('## Decision required');
    expect(proofGraphIdx).toBeGreaterThan(-1);
    expect(decisionIdx).toBeGreaterThan(-1);
    expect(proofGraphIdx).toBeLessThan(decisionIdx);
  });
});
