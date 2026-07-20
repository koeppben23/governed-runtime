/**
 * @module presentation/review-report-card.test
 * @description Unit tests for buildReviewReportCard.
 */
import { describe, it, expect } from 'vitest';
import { buildReviewReportCard } from './review-report-card.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function readGolden(name: string): Promise<string> {
  const p = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return readFile(p, 'utf-8');
}

const baseInput = {
  phase: 'REVIEW_COMPLETE' as const,
  phaseLabel: 'Review complete',
  overallStatus: 'clean' as const,
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
    expect(card).toContain('**Status:** Review complete');
    expect(card).toContain('**Input:** pr');
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
      overallStatus: 'issues',
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

  it('renders lower-assurance text compatibility metadata', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      reviewOutputMode: 'text_compat',
      structuredOutputUsed: false,
      reviewAssuranceLevel: 'text_compat_lower',
      extractionMethod: 'json_fence',
    });
    expect(card).toContain('**Review output mode:** text_compat');
    expect(card).toContain('**Structured output used:** no');
    expect(card).toContain('**Review assurance:** text_compat_lower');
    expect(card).toContain('**Extraction method:** json_fence');
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

// ─── Golden Baseline Tests ──────────────────────────────────────────────────────

describe('implementation review golden fixtures', () => {
  it('review-impl-accepted matches golden output', async () => {
    const card = buildReviewReportCard({
      phase: 'IMPL_REVIEW',
      phaseLabel: 'Implementation review in progress',
      overallStatus: 'clean',
      findings: [],
      completeness: {
        overallComplete: true,
        fourEyes: true,
        summary: '6/6 complete, 0 missing',
      },
      inputOrigin: 'pr',
    });
    expect(card).toBe(await readGolden('review-impl-accepted.md'));
  });

  it('review-impl-changes-requested matches golden output', async () => {
    const card = buildReviewReportCard({
      phase: 'IMPL_REVIEW',
      phaseLabel: 'Implementation review in progress',
      overallStatus: 'issues',
      findings: [
        {
          severity: 'critical',
          category: 'correctness',
          message: 'Missing null check',
          location: 'src/payments/validate.ts',
        },
        {
          severity: 'major',
          category: 'quality',
          message: 'Missing test coverage',
          location: 'src/payments/routes.ts',
        },
      ],
      completeness: {
        overallComplete: false,
        fourEyes: false,
        summary: '4/6 complete, 2 missing',
      },
      inputOrigin: 'pr',
    });
    expect(card).toBe(await readGolden('review-impl-changes-requested.md'));
  });
});

describe('compliance review golden fixtures', () => {
  it('review-compliance-clean matches golden output', async () => {
    const card = buildReviewReportCard({
      phase: 'REVIEW_COMPLETE',
      phaseLabel: 'Review complete',
      overallStatus: 'clean',
      findings: [],
      completeness: {
        overallComplete: true,
        fourEyes: true,
        summary: '3/3 complete, 0 missing',
      },
      inputOrigin: 'manual_text',
      obligationId: 'oblig-001',
      invocationSource: 'host-orchestrated',
    });
    expect(card).toBe(await readGolden('review-compliance-clean.md'));
  });

  it('review-compliance-issues-found matches golden output', async () => {
    const card = buildReviewReportCard({
      phase: 'REVIEW_COMPLETE',
      phaseLabel: 'Review complete',
      overallStatus: 'issues',
      findings: [
        {
          severity: 'critical',
          category: 'completeness',
          message: 'Missing evidence',
        },
        {
          severity: 'major',
          category: 'risk',
          message: 'Untracked dependency',
          location: 'package.json',
        },
        {
          severity: 'warning',
          category: 'quality',
          message: 'Missing changelog entry',
        },
      ],
      completeness: {
        overallComplete: false,
        fourEyes: false,
        summary: '1/3 complete, 2 missing',
      },
      inputOrigin: 'branch',
      invocationSource: 'agent-submitted-attested',
      obligationId: 'oblig-002',
    });
    expect(card).toBe(await readGolden('review-compliance-issues-found.md'));
  });
});
