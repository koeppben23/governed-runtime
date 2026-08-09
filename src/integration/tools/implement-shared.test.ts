import { describe, it, expect } from 'vitest';
import { normalizeHostFindings } from './implement-shared.js';
import type { ReviewFindings } from '../../state/evidence.js';

function makeFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { actorId: 'reviewer', reviewedAt: '2025-01-01T00:00:00Z', reviewMode: 'subagent' },
    reviewedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  } as any;
}

describe('normalizeHostFindings', () => {
  it('mints host-assigned findingId on blockingIssues', () => {
    const findings = makeFindings({
      blockingIssues: [
        { severity: 'critical', category: 'correctness', message: 'Missing null check' },
      ],
    } as any);
    const result = normalizeHostFindings(findings);
    expect(result.blockingIssues[0]!.findingId).toBeTruthy();
    expect(result.blockingIssues[0]!.findingId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('mints host-assigned findingId on majorRisks', () => {
    const findings = makeFindings({
      majorRisks: [{ severity: 'major', category: 'risk', message: 'Retry untested' }],
    } as any);
    const result = normalizeHostFindings(findings);
    expect(result.majorRisks[0]!.findingId).toBeTruthy();
    expect(result.majorRisks[0]!.findingId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('overwrites reviewer-supplied findingId', () => {
    const findings = makeFindings({
      blockingIssues: [
        {
          severity: 'critical',
          category: 'correctness',
          message: 'Issue',
          findingId: 'reviewer-supplied-bad-uuid',
        },
      ],
    } as any);
    const result = normalizeHostFindings(findings);
    expect(result.blockingIssues[0]!.findingId).not.toBe('reviewer-supplied-bad-uuid');
    expect(result.blockingIssues[0]!.findingId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('assigns unique findingId per finding', () => {
    const findings = makeFindings({
      blockingIssues: [
        { severity: 'critical', category: 'correctness', message: 'Issue A' },
        { severity: 'major', category: 'completeness', message: 'Issue B' },
      ],
    } as any);
    const result = normalizeHostFindings(findings);
    expect(result.blockingIssues[0]!.findingId).not.toBe(result.blockingIssues[1]!.findingId);
  });

  it('preserves all non-identity finding fields', () => {
    const findings = makeFindings({
      blockingIssues: [
        { severity: 'critical', category: 'correctness', message: 'Issue', location: 'src/foo.ts' },
      ],
    } as any);
    const result = normalizeHostFindings(findings);
    expect(result.blockingIssues[0]!.severity).toBe('critical');
    expect(result.blockingIssues[0]!.category).toBe('correctness');
    expect(result.blockingIssues[0]!.message).toBe('Issue');
    expect(result.blockingIssues[0]!.location).toBe('src/foo.ts');
  });
});
