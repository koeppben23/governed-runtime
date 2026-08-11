/**
 * @module integration/tools/review-tool/completion.test
 * @description Contract: reviewer challenges reach the PR author.
 *
 * Challenges are the most substantive artifact a review produces - an
 * evidence-bound falsification attempt with a scenario and at least one location
 * (ReviewChallenge.locations is `.min(1)`). They were dropped entirely when the
 * findings were mapped into the report, so the author never saw them.
 *
 * @test-policy HAPPY, EDGE - outcome projection plus malformed input.
 */

import { describe, it, expect } from 'vitest';
import { mapReviewFindingsToReport } from './completion.js';
import type { ReviewReportFinding } from '../../../state/evidence.js';

function challengeFinding(findings: ReviewReportFinding[]) {
  const finding = findings[0];
  if (!finding || finding.source !== 'challenge')
    throw new Error('Expected challenge report finding');
  return finding;
}

function challenge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    challengeId: '11111111-1111-4111-8111-111111111111',
    obligationId: '22222222-2222-4222-8222-222222222222',
    kind: 'implementation_challenge',
    scenario: 'Submit a task with a due date in the past',
    claim: 'Due dates are validated before persistence',
    locations: ['src/main/java/com/example/TaskService.java:42'],
    evidenceRefs: [{ kind: 'implementation' }],
    outcome: 'fail',
    ...overrides,
  };
}

describe('mapReviewFindingsToReport: challenges reach the author', () => {
  it('projects a falsified challenge as an error with its location', () => {
    const findings = mapReviewFindingsToReport({ challenges: [challenge()] });

    expect(findings).toHaveLength(1);
    const finding = challengeFinding(findings);
    expect(finding.reportSeverity).toBe('error');
    expect(finding.category).toBe('implementation_challenge');
    expect(finding.message).toContain('Submit a task with a due date in the past');
    expect(finding.message).toContain('Due dates are validated before persistence');
    expect(finding.location).toBe('src/main/java/com/example/TaskService.java:42');
  });

  it.each([
    ['contradicted', 'error'],
    ['fail', 'error'],
    ['not_verified', 'warning'],
    ['supported', 'info'],
    ['pass', 'info'],
  ])('maps outcome %s to severity %s', (outcome, severity) => {
    const findings = mapReviewFindingsToReport({ challenges: [challenge({ outcome })] });

    expect(challengeFinding(findings).reportSeverity).toBe(severity);
  });

  it('joins multiple locations so every cited site is visible', () => {
    const findings = mapReviewFindingsToReport({
      challenges: [challenge({ locations: ['a/File.java:1', 'b/Other.java:9'] })],
    });

    expect(challengeFinding(findings).location).toBe('a/File.java:1, b/Other.java:9');
  });

  it('keeps the existing finding categories alongside challenges', () => {
    const findings = mapReviewFindingsToReport({
      blockingIssues: [
        {
          severity: 'critical',
          category: 'correctness',
          message: 'Null deref',
          relation: {
            subjectAnchors: [
              {
                kind: 'repository_location',
                location: { path: 'src/task.ts', revision: 'head', line: 1 },
              },
            ],
            evidenceLocations: [],
          },
        },
      ],
      unknowns: ['Unclear rollback path'],
      challenges: [challenge()],
    });

    expect(
      findings.map((f) => (f.source === 'material_finding' ? f.finding.category : f.category)),
    ).toEqual(['correctness', 'unknown', 'implementation_challenge']);
  });

  it.each([
    ['no challenges field', {}],
    ['a non-array challenges field', { challenges: 'nope' }],
    ['a null entry', { challenges: [null] }],
    ['an entry without an outcome', { challenges: [challenge({ outcome: undefined })] }],
    ['an entry without a scenario', { challenges: [challenge({ scenario: undefined })] }],
  ])('ignores %s rather than emitting a hollow finding', (_label, input) => {
    expect(mapReviewFindingsToReport(input as Record<string, unknown>)).toEqual([]);
  });

  it('still emits a challenge that carries no usable location', () => {
    // The schema requires locations, but the report must not silently drop a
    // finding just because a reviewer returned a malformed list.
    const findings = mapReviewFindingsToReport({ challenges: [challenge({ locations: [] })] });

    expect(findings).toHaveLength(1);
    expect(challengeFinding(findings).location).toBeUndefined();
  });
});
