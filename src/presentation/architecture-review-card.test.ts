/**
 * @module presentation/architecture-review-card.test
 * @description Unit tests for buildArchitectureReviewCard.
 */
import { describe, it, expect } from 'vitest';
import { buildArchitectureReviewCard } from './architecture-review-card.js';

const baseInput = {
  phase: 'ARCH_REVIEW' as const,
  phaseLabel: 'Ready for architecture review',
  iteration: 2,
  productNextAction: {
    text: 'Review gate active. Run /approve to accept.',
    commands: ['/approve', '/request-changes', '/reject'] as readonly string[],
  },
  isApproved: false,
};

describe('buildArchitectureReviewCard', () => {
  it('renders header with ADR title and status', () => {
    const card = buildArchitectureReviewCard({
      ...baseInput,
      adrTitle: 'Use presentation-only command aliases',
    });
    expect(card).toContain('# FlowGuard Architecture Review');
    expect(card).toContain('> **ADR:** Use presentation-only command aliases');
    expect(card).toContain('> **Status:** Ready for architecture review');
  });

  it('renders ADR details with id, digest, and iteration', () => {
    const card = buildArchitectureReviewCard({
      ...baseInput,
      adrId: 'ADR-001',
      adrDigest: 'abc123',
    });
    expect(card).toContain('## ADR Details');
    expect(card).toContain('`ADR-001`');
    expect(card).toContain('`abc123`');
    expect(card).toContain('**Review iteration:** 2');
  });

  it('renders reviewer findings when present', () => {
    const card = buildArchitectureReviewCard({
      ...baseInput,
      overallVerdict: 'changes_requested',
      blockingIssues: [
        { severity: 'critical', category: 'completeness', message: 'Missing alternatives' },
      ],
      majorRisks: [{ severity: 'major', category: 'risk', message: 'Race condition' }],
      missingVerification: ['No integration test for the new error path'],
      scopeCreep: ['Unrelated dependency upgrade'],
      unknowns: ['Behaviour under sustained load'],
    });
    expect(card).toContain('## Reviewer Findings');
    expect(card).toContain('### Blocking Issues (1)');
    expect(card).toContain('Missing alternatives');
    expect(card).toContain('### Major Risks (1)');
    expect(card).toContain('### Missing Verification (1)');
    expect(card).toContain('### Scope Creep (1)');
    expect(card).toContain('### Unknowns (1)');
  });

  it('shows next actions at ARCH_REVIEW', () => {
    const card = buildArchitectureReviewCard(baseInput);
    expect(card).toContain('/approve');
    expect(card).toContain('/request-changes');
    expect(card).toContain('/reject');
  });

  it('does not show next actions at ARCH_COMPLETE', () => {
    const card = buildArchitectureReviewCard({
      ...baseInput,
      phase: 'ARCH_COMPLETE',
      phaseLabel: 'Architecture complete',
      isApproved: true,
      productNextAction: {
        text: 'ADR approved. No further action required.',
        commands: [],
      },
    });
    expect(card).toContain('> **Status:** Architecture complete');
    expect(card).not.toContain('/approve');
    expect(card).not.toContain('/request-changes');
  });

  it('omits findings section when none present', () => {
    const card = buildArchitectureReviewCard(baseInput);
    expect(card).not.toContain('## Reviewer Findings');
  });
});
