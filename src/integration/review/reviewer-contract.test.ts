/**
 * @file reviewer-contract.test.ts
 * @description Drift guard: the canonical contract values in reviewer-contract.ts
 * match the Zod schemas. Any divergence is caught at build time.
 */
import { describe, expect, it } from 'vitest';
import { ReviewFindings } from '../../state/evidence.js';
import {
  SEVERITY_VALUES,
  CATEGORY_VALUES,
  ANCHOR_KINDS,
  CHALLENGE_KINDS,
  OVERALL_VERDICT_VALUES,
} from './reviewer-contract.js';

describe('reviewer-contract ↔ canonical Zod drift guard', () => {
  it('severities match Zod Finding.severity', () => {
    // Parse a finding with each severity — canonical Zod must accept all
    for (const severity of SEVERITY_VALUES) {
      const result = ReviewFindings.safeParse(makePayload({ severity }));
      expect(result.success, `${severity} must be valid`).toBe(true);
    }
  });

  it('categories match Zod Finding.category', () => {
    for (const cat of CATEGORY_VALUES) {
      const result = ReviewFindings.safeParse(makePayload({ category: cat }));
      expect(result.success, `${cat} must be valid`).toBe(true);
    }
  });

  it('anchor kinds match Zod ReviewSubjectAnchor', () => {
    // Verify each anchor kind has a valid Zod shape
    const payload = makePayload();
    const repo = {
      ...payload,
      blockingIssues: [
        {
          severity: 'major',
          category: 'completeness',
          message: 'x',
          relation: {
            subjectAnchors: [
              { kind: 'repository_location', location: { path: 'src/file.ts', revision: 'head' } },
            ],
            evidenceLocations: [],
          },
        },
      ],
    };
    expect(ReviewFindings.safeParse(repo).success).toBe(true);

    const artifact = {
      ...payload,
      blockingIssues: [
        {
          severity: 'major',
          category: 'completeness',
          message: 'x',
          relation: {
            subjectAnchors: [
              {
                kind: 'artifact_section',
                artifactKind: 'plan',
                artifactDigest: 'abc',
                sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Test' }],
              },
            ],
            evidenceLocations: [],
          },
        },
      ],
    };
    expect(ReviewFindings.safeParse(artifact).success).toBe(true);

    const content = {
      ...payload,
      blockingIssues: [
        {
          severity: 'major',
          category: 'completeness',
          message: 'x',
          relation: {
            subjectAnchors: [{ kind: 'content', subjectDigest: 'abc' }],
            evidenceLocations: [],
          },
        },
      ],
    };
    expect(ReviewFindings.safeParse(content).success).toBe(true);

    // Verify the contract list matches exactly (order-stable)
    expect([...ANCHOR_KINDS].sort()).toEqual([
      'artifact_section',
      'content',
      'repository_location',
    ]);
  });

  it('challenge kinds match Zod ReviewChallenge', () => {
    const payload = makePayload();
    const designChallenge = {
      ...payload,
      challenges: [
        {
          challengeId: '00000000-0000-4000-8000-000000000000',
          obligationId: '00000000-0000-4000-8000-000000000000',
          scenario: 'x',
          claim: 'x',
          locations: ['x'],
          kind: 'design_challenge',
          evidenceRefs: [
            {
              kind: 'plan_adr_section',
              artifactKind: 'plan',
              artifactDigest: 'abc',
              sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Test' }],
              excerptDigest: 'abc',
            },
          ],
          outcome: 'supported',
        },
      ],
    };
    expect(ReviewFindings.safeParse(designChallenge).success).toBe(true);

    const contentChallenge = {
      ...payload,
      challenges: [
        {
          challengeId: '00000000-0000-4000-8000-000000000000',
          obligationId: '00000000-0000-4000-8000-000000000000',
          scenario: 'x',
          claim: 'x',
          locations: ['x'],
          kind: 'content_challenge',
          evidenceRefs: [{ kind: 'content', digest: 'abc' }],
          outcome: 'supported',
        },
      ],
    };
    expect(ReviewFindings.safeParse(contentChallenge).success).toBe(true);

    expect([...CHALLENGE_KINDS].sort()).toEqual([
      'content_challenge',
      'design_challenge',
      'implementation_challenge',
    ]);
  });

  it('overall verdicts match Zod LoopVerdict', () => {
    for (const verdict of OVERALL_VERDICT_VALUES) {
      const result = ReviewFindings.safeParse({ ...makePayload(), overallVerdict: verdict });
      expect(result.success, `${verdict} must be valid`).toBe(true);
    }
  });

  it('invalid severity "info" is rejected', () => {
    const result = ReviewFindings.safeParse(makePayload({ severity: 'info' }));
    expect(result.success).toBe(false);
  });
});

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'changes_requested' as const,
    blockingIssues: [
      {
        severity: (overrides.severity as string) ?? 'major',
        category: (overrides.category as string) ?? 'completeness',
        message: 'Test',
        relation: {
          subjectAnchors: [
            { kind: 'repository_location', location: { path: 'src/f.ts', revision: 'head' } },
          ],
          evidenceLocations: [],
        },
      },
    ],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 's' },
    reviewedAt: '2026-01-01T00:00:00Z',
    attestation: {
      mandateDigest: 'sha256:test',
      criteriaVersion: 'v1',
      toolObligationId: '00000000-0000-4000-8000-000000000000',
      iteration: 1,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
  };
}
