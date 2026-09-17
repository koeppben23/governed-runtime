/**
 * @module integration/review/findings-hash.test
 * @description Contract tests for the canonical findings hash: identity is
 *              content-derived, order-independent for anchors and evidence
 *              locations, and excludes the volatile findingId.
 */

import { describe, expect, it } from 'vitest';
import { hashFindings } from './findings-hash.js';

function findings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'changes_requested',
    blockingIssues: [
      {
        findingId: 'finding-1',
        severity: 'high',
        relation: {
          subjectAnchors: ['src/b.ts::second', 'src/a.ts::first'],
          evidenceLocations: ['line:20', 'line:10'],
        },
      },
    ],
    majorRisks: [{ findingId: 'finding-2', text: 'risk' }],
    ...overrides,
  };
}

describe('hashFindings', () => {
  it('is stable for identical content', () => {
    expect(hashFindings(findings())).toBe(hashFindings(findings()));
  });

  it('ignores the volatile findingId', () => {
    const first = findings();
    const second = findings({
      blockingIssues: [
        {
          findingId: 'different-id',
          severity: 'high',
          relation: {
            subjectAnchors: ['src/b.ts::second', 'src/a.ts::first'],
            evidenceLocations: ['line:20', 'line:10'],
          },
        },
      ],
    });

    expect(hashFindings(first)).toBe(hashFindings(second));
  });

  it('is independent of subjectAnchor and evidenceLocation order', () => {
    const reordered = findings({
      blockingIssues: [
        {
          findingId: 'finding-1',
          severity: 'high',
          relation: {
            subjectAnchors: ['src/a.ts::first', 'src/b.ts::second'],
            evidenceLocations: ['line:10', 'line:20'],
          },
        },
      ],
    });

    expect(hashFindings(findings())).toBe(hashFindings(reordered));
  });

  it('changes when finding content changes', () => {
    const changed = findings({
      blockingIssues: [
        {
          findingId: 'finding-1',
          severity: 'low',
          relation: { subjectAnchors: ['src/a.ts::first'], evidenceLocations: [] },
        },
      ],
    });

    expect(hashFindings(findings())).not.toBe(hashFindings(changed));
  });

  it('passes through findings without a relation object', () => {
    expect(() =>
      hashFindings(findings({ blockingIssues: ['plain string', 42, null] })),
    ).not.toThrow();
    expect(hashFindings(findings({ blockingIssues: ['plain string'] }))).not.toBe(
      hashFindings(findings({ blockingIssues: ['other string'] })),
    );
  });

  it('passes through absent finding arrays', () => {
    const withoutArrays: Record<string, unknown> = { verdict: 'approved' };
    expect(hashFindings(withoutArrays)).toBe(hashFindings({ verdict: 'approved' }));
  });
});
