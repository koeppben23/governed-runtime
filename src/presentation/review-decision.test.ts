import { describe, it, expect } from 'vitest';
import { projectReviewDecision, REVIEW_DECISION_COPY } from './review-decision.js';
import type { ReviewDecisionInput } from './review-decision.js';

describe('projectReviewDecision', () => {
  it('includes a compact affected-subject summary without changing readiness', () => {
    const result = projectReviewDecision({
      blockingIssues: [
        {
          message: 'Callback validation is incomplete',
          severity: 'major',
          relation: {
            subjectAnchors: [
              {
                kind: 'repository_location',
                location: { revision: 'head', path: 'src/auth/callback.ts', line: 44, endLine: 61 },
              },
            ],
            evidenceLocations: [],
          },
        },
      ],
    });

    expect(result.readiness).toBe('not_ready');
    expect(result.blockers[0]?.detail).toBe(
      'Severity: major · Affected: HEAD · src/auth/callback.ts:44–61',
    );
  });

  it('empty input produces ready readiness', () => {
    const result = projectReviewDecision({});
    expect(result.readiness).toBe('ready');
    expect(result.blockers).toEqual([]);
    expect(result.risks).toEqual([]);
    expect(result.advisories).toEqual([]);
    expect(result.summary).toContain('No blocking review findings remain');
  });

  it('blockingIssues produce not_ready readiness', () => {
    const input: ReviewDecisionInput = {
      blockingIssues: [{ message: 'Missing null check' }],
    };
    const result = projectReviewDecision(input);
    expect(result.readiness).toBe('not_ready');
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]!.title).toBe('Missing null check');
    expect(result.blockers[0]!.source).toBe('review_finding');
    expect(result.summary).toContain('1 blocking issue');
  });

  it('majorRisks do NOT affect readiness', () => {
    const input: ReviewDecisionInput = {
      majorRisks: [{ message: 'Retry behavior untested' }],
    };
    const result = projectReviewDecision(input);
    expect(result.readiness).toBe('ready');
    expect(result.risks).toHaveLength(1);
    expect(result.blockers).toEqual([]);
  });

  it('blockingIssues override majorRisks for readiness', () => {
    const input: ReviewDecisionInput = {
      blockingIssues: [{ message: 'Missing null check' }],
      majorRisks: [{ message: 'Retry behavior untested' }],
    };
    const result = projectReviewDecision(input);
    expect(result.readiness).toBe('not_ready');
    expect(result.blockers).toHaveLength(1);
    expect(result.risks).toHaveLength(1);
  });

  it('multiple blockingIssues produce plural summary', () => {
    const input: ReviewDecisionInput = {
      blockingIssues: [{ message: 'Issue A' }, { message: 'Issue B' }],
    };
    const result = projectReviewDecision(input);
    expect(result.summary).toContain('2 blocking issues');
  });

  it('maps advisories from missingVerification, scopeCreep, unknowns', () => {
    const input: ReviewDecisionInput = {
      missingVerification: ['Check: test'],
      scopeCreep: ['New feature outside scope'],
      unknowns: ['Deployment impact unknown'],
    };
    const result = projectReviewDecision(input);
    expect(result.advisories).toHaveLength(3);
    expect(result.advisories[0]!.kind).toBe('missing_verification');
    expect(result.advisories[1]!.kind).toBe('scope_creep');
    expect(result.advisories[2]!.kind).toBe('unknown');
  });

  it('advisories do NOT affect readiness', () => {
    const input: ReviewDecisionInput = {
      missingVerification: ['Check: test'],
      scopeCreep: ['New feature'],
      unknowns: ['Impact unknown'],
    };
    const result = projectReviewDecision(input);
    expect(result.readiness).toBe('ready');
    expect(result.blockers).toEqual([]);
  });

  it('preserves findingId when present', () => {
    const input: ReviewDecisionInput = {
      blockingIssues: [{ message: 'Issue', findingId: 'abc-123' }],
    };
    const result = projectReviewDecision(input);
    expect(result.blockers[0]!.findingId).toBe('abc-123');
  });

  it('omits findingId when absent', () => {
    const input: ReviewDecisionInput = {
      blockingIssues: [{ message: 'Issue' }],
    };
    const result = projectReviewDecision(input);
    expect(result.blockers[0]!.findingId).toBeUndefined();
  });

  it('handles all zero-length arrays', () => {
    const input: ReviewDecisionInput = {
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
    };
    const result = projectReviewDecision(input);
    expect(result.readiness).toBe('ready');
    expect(result.blockers).toEqual([]);
    expect(result.risks).toEqual([]);
    expect(result.advisories).toEqual([]);
  });
});

describe('REVIEW_DECISION_COPY', () => {
  it('covers both readiness states', () => {
    const states: Array<'ready' | 'not_ready'> = ['ready', 'not_ready'];
    for (const state of states) {
      expect(REVIEW_DECISION_COPY[state]).toBeTruthy();
      expect(REVIEW_DECISION_COPY[state].headline.length).toBeGreaterThan(0);
      expect(REVIEW_DECISION_COPY[state].explanation.length).toBeGreaterThan(0);
    }
  });

  it('ready copy does NOT imply approval', () => {
    expect(REVIEW_DECISION_COPY.ready.headline).not.toMatch(/approv/i);
    expect(REVIEW_DECISION_COPY.ready.explanation).not.toMatch(/approv/i);
  });

  it('not_ready copy does NOT imply severity', () => {
    expect(REVIEW_DECISION_COPY.not_ready.headline).not.toMatch(/critical/i);
    expect(REVIEW_DECISION_COPY.not_ready.headline).not.toMatch(/severe/i);
  });
});
