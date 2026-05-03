/**
 * @module presentation/review-report-card.test
 * @description Unit tests for buildReviewReportCard.
 */
import { describe, it, expect } from 'vitest';
import { buildReviewReportCard } from './review-report-card.js';

const baseInput = {
  phase: 'REVIEW_COMPLETE' as const,
  phaseLabel: 'Review complete',
  overallStatus: 'complete' as const,
  findings: [] as Array<{
    severity: string;
    category: string;
    message: string;
    location?: string;
  }>,
  completeness: {
    overallComplete: true,
    fourEyes: false,
    summary: '3/3 complete, 0 missing',
  },
};

describe('buildReviewReportCard', () => {
  it('renders header with status and input origin', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      inputOrigin: 'pr',
    });
    expect(card).toContain('# FlowGuard Review Report');
    expect(card).toContain('> **Status:** Review complete');
    expect(card).toContain('> **Input:** pr');
  });

  it('renders references with fallback formatting', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      references: [
        { ref: 'https://github.com/owner/repo/pull/42', type: 'pr' },
        { ref: '' } as never,
        { title: 'JIRA-456' } as never,
      ],
    });
    expect(card).toContain('pr: https://github.com/owner/repo/pull/42');
    expect(card).toContain('JIRA-456');
  });

  it('renders all finding groups sorted by severity', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      overallStatus: 'incomplete',
      findings: [
        { severity: 'critical', category: 'risk', message: 'SQL injection vulnerability' },
        { severity: 'major', category: 'correctness', message: 'Logic error in token refresh' },
        { severity: 'warning', category: 'quality', message: 'Unused import' },
        { severity: 'info', category: 'unknown', message: 'Load test results unavailable' },
      ],
    });
    expect(card).toContain('### Critical (1)');
    expect(card).toContain('SQL injection vulnerability');
    expect(card).toContain('### Major (1)');
    expect(card).toContain('Logic error in token refresh');
    expect(card).toContain('### Warnings (1)');
    expect(card).toContain('### Notes (1)');
  });

  it('omits evidence section when no evidence fields present', () => {
    const card = buildReviewReportCard(baseInput);
    expect(card).not.toContain('## Evidence');
  });

  it('renders evidence section when obligationId present', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      obligationId: '00000000-0000-0000-0000-000000000001',
      invocationSource: 'host-orchestrated',
      reviewerSessionId: 'child-session-1',
    });
    expect(card).toContain('## Evidence');
    expect(card).toContain('00000000-0000-0000-0000-000000000001');
    expect(card).toContain('host-orchestrated');
    expect(card).toContain('child-session-1');
  });

  it('has no command footer (/approve, /request-changes, /reject)', () => {
    const card = buildReviewReportCard(baseInput);
    expect(card).not.toContain('/approve');
    expect(card).not.toContain('/request-changes');
    expect(card).not.toContain('/reject');
  });

  it('shows "no follow-up required" when findings are empty', () => {
    const card = buildReviewReportCard(baseInput);
    expect(card).toContain('No follow-up required from this review');
  });

  it('shows action follow-up when critical/major findings present', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      findings: [{ severity: 'critical', category: 'risk', message: 'SQL injection' }],
    });
    expect(card).toContain('Address critical and major findings');
    expect(card).not.toContain('No follow-up required');
  });
});
