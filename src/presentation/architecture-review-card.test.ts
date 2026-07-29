/**
 * @module presentation/architecture-review-card.test
 * @description Unit tests for buildArchitectureReviewCard.
 */
import { describe, it, expect } from 'vitest';
import { buildArchitectureReviewCard } from './architecture-review-card.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function readGolden(name: string): Promise<string> {
  const p = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return readFile(p, 'utf-8');
}

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
  it('keeps Unicode canonical by default and supports an ASCII transient rendering', () => {
    const input = { ...baseInput, forcedConvergence: true };
    const canonical = buildArchitectureReviewCard(input);

    expect(buildArchitectureReviewCard(input)).toBe(canonical);
    expect(canonical).toContain('⚠ Reviewer did NOT approve this ADR.');
    expect(buildArchitectureReviewCard(input, { glyphProfile: 'ascii' })).toContain(
      '[WARN] Reviewer did NOT approve this ADR.',
    );
  });

  it('renders header with ADR title and status', () => {
    const card = buildArchitectureReviewCard({
      ...baseInput,
      adrTitle: 'Use presentation-only command aliases',
    });
    expect(card).toContain('# FlowGuard Architecture Review');
    expect(card).toContain('**ADR:** Use presentation-only command aliases');
    expect(card).toContain('**Status:** Ready for architecture review');
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

  it('renders the ADR body under the Architecture Decision heading, demoting embedded headings', () => {
    const adrText = '## Context\nfoo\n\n## Decision\nbar\n\n## Consequences\nbaz\n';
    const card = buildArchitectureReviewCard({ ...baseInput, adrText });
    expect(card).toContain('## Architecture Decision');
    // Embedded MADR ## sections are demoted to ### so they nest under the
    // owning ## Architecture Decision section (no heading-level inversion).
    expect(card).toContain('### Context\nfoo');
    expect(card).toContain('### Decision\nbar');
    expect(card).toContain('### Consequences\nbaz');
    // Card contributes exactly one document-level H1 (its title).
    expect(card.match(/^# /gm)).toHaveLength(1);
  });

  it('omits the ADR body section when adrText is absent', () => {
    const card = buildArchitectureReviewCard(baseInput);
    expect(card).not.toContain('## Architecture Decision');
  });

  it('omits the ADR body section when adrText is whitespace-only', () => {
    const card = buildArchitectureReviewCard({ ...baseInput, adrText: '   \n \t ' });
    expect(card).not.toContain('## Architecture Decision');
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
    expect(card).toContain('## Missing Verification (1)');
    expect(card).toContain('## Scope Creep (1)');
    expect(card).toContain('## Unknowns (1)');
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
    expect(card).toContain('**Status:** Architecture complete');
    expect(card).not.toContain('/approve');
    expect(card).not.toContain('/request-changes');
  });

  it('omits findings section when none present', () => {
    const card = buildArchitectureReviewCard(baseInput);
    expect(card).not.toContain('## Reviewer Findings');
  });

  it('renders a "reviewer did NOT approve" warning when forceConverged at the gate', () => {
    const card = buildArchitectureReviewCard({
      ...baseInput,
      forcedConvergence: true,
    });
    expect(card).toContain('Reviewer did NOT approve this ADR.');
    expect(card).toContain('iteration limit');
  });

  it('suppresses the forced-convergence warning once the ADR is approved', () => {
    const card = buildArchitectureReviewCard({
      ...baseInput,
      phase: 'ARCH_COMPLETE',
      phaseLabel: 'Architecture complete',
      isApproved: true,
      forcedConvergence: true,
    });
    expect(card).not.toContain('Reviewer did NOT approve');
  });
});

// ─── Golden Baseline Tests ──────────────────────────────────────────────────────

describe('architecture review golden fixtures', () => {
  it('review-architecture-accepted matches golden output', async () => {
    const card = buildArchitectureReviewCard({
      phase: 'ARCH_COMPLETE',
      phaseLabel: 'Architecture complete',
      adrTitle: 'Use presentation-only command aliases',
      adrId: 'ADR-001',
      adrDigest: 'abc123',
      iteration: 2,
      overallVerdict: 'accept',
      isApproved: true,
      productNextAction: { text: 'Architecture approved.', commands: [] },
    });
    expect(card).toBe(await readGolden('review-architecture-accepted.md'));
  });

  it('review-architecture-changes-requested matches golden output', async () => {
    const card = buildArchitectureReviewCard({
      phase: 'ARCH_REVIEW',
      phaseLabel: 'Ready for architecture review',
      adrTitle: 'Use presentation-only command aliases',
      adrId: 'ADR-001',
      adrDigest: 'abc123',
      iteration: 3,
      overallVerdict: 'changes_requested',
      isApproved: false,
      forcedConvergence: true,
      productNextAction: {
        text: 'Review the ADR and decide.',
        commands: ['/approve', '/request-changes', '/reject'],
      },
    });
    expect(card).toBe(await readGolden('review-architecture-changes-requested.md'));
  });
});
