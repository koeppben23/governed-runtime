import { describe, expect, it } from 'vitest';
import type { ReviewFindings } from '../../../state/evidence.js';
import { hashFindings } from '../findings-hash.js';
import { mintHostFindingIds } from './finding-identity.js';

function findings(): ReviewFindings {
  const location = { path: 'src/foo.ts', revision: 'head' as const };
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [
      {
        findingId: 'reviewer-supplied',
        severity: 'critical',
        category: 'correctness',
        message: 'missing evidence',
        relation: {
          subjectAnchors: [{ kind: 'repository_location', location }],
          evidenceLocations: [],
        },
      },
    ],
    majorRisks: [
      {
        severity: 'major',
        category: 'risk',
        message: 'risk',
        relation: {
          subjectAnchors: [{ kind: 'repository_location', location }],
          evidenceLocations: [],
        },
      },
    ],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    reviewedBy: { sessionId: 'reviewer' },
    reviewedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('host finding identity', () => {
  it('mints a UUID and overwrites reviewer-supplied identity', () => {
    const minted = mintHostFindingIds(findings());
    expect(minted.blockingIssues[0]!.findingId).toMatch(/^[a-f0-9-]{36}$/);
    expect(minted.blockingIssues[0]!.findingId).not.toBe('reviewer-supplied');
    expect(minted.majorRisks[0]!.findingId).toMatch(/^[a-f0-9-]{36}$/);
    expect(minted.majorRisks[0]!.message).toBe('risk');
  });

  it('preserves reviewer-owned semantics and the canonical findings hash', () => {
    const original = findings();
    const minted = mintHostFindingIds(original);
    expect(minted.blockingIssues[0]!.message).toBe('missing evidence');
    expect(minted.blockingIssues[0]!.relation).toEqual(original.blockingIssues[0]!.relation);
    expect(hashFindings(minted as unknown as Record<string, unknown>)).toBe(
      hashFindings(original as unknown as Record<string, unknown>),
    );
  });

  it('assigns distinct identities to distinct findings', () => {
    const original = findings();
    const two = {
      ...original,
      blockingIssues: [
        original.blockingIssues[0]!,
        { ...original.blockingIssues[0]!, message: 'second' },
      ],
    };
    const minted = mintHostFindingIds(two);
    expect(minted.blockingIssues[0]!.findingId).not.toBe(minted.blockingIssues[1]!.findingId);
  });
});
