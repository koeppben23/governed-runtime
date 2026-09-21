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

describe('hashFindings relation normalization boundaries', () => {
  function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { findingId: 'finding-1', severity: 'high', ...overrides };
  }

  it('hashes a present relation differently from an absent one', () => {
    const withRelation = findings({
      blockingIssues: [finding({ relation: { subjectAnchors: ['src/a.ts::x'] } })],
    });
    const withoutRelation = findings({ blockingIssues: [finding()] });

    expect(hashFindings(withRelation)).not.toBe(hashFindings(withoutRelation));
  });

  it.each([42, 'text', true])(
    'drops non-object relation %p like an absent relation',
    (relation) => {
      const variant = findings({ blockingIssues: [finding({ relation })] });
      const withoutRelation = findings({ blockingIssues: [finding()] });

      expect(hashFindings(variant)).toBe(hashFindings(withoutRelation));
    },
  );

  it('drops array relations like an absent relation', () => {
    const variant = findings({
      blockingIssues: [finding({ relation: { subjectAnchors: ['a'] } })],
    });
    const arrayRelation = findings({
      blockingIssues: [finding({ relation: [{ subjectAnchors: ['a'] }] })],
    });

    expect(hashFindings(arrayRelation)).not.toBe(hashFindings(variant));
    expect(hashFindings(arrayRelation)).toBe(
      hashFindings(findings({ blockingIssues: [finding()] })),
    );
  });

  it('preserves relation fields beyond the sorted anchors', () => {
    const withNote = findings({
      blockingIssues: [finding({ relation: { subjectAnchors: ['a'], note: 'keep-me' } })],
    });
    const withoutNote = findings({
      blockingIssues: [finding({ relation: { subjectAnchors: ['a'] } })],
    });

    expect(hashFindings(withNote)).not.toBe(hashFindings(withoutNote));
  });

  it('treats primitive findings as content, not as objects', () => {
    expect(hashFindings({ blockingIssues: [42] })).not.toBe(hashFindings({ blockingIssues: [{}] }));
    expect(hashFindings({ blockingIssues: ['42'] })).not.toBe(
      hashFindings({ blockingIssues: [42] }),
    );
  });
});
