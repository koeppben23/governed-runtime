/**
 * @module documentation/demo-review-latency
 * @description End-to-end review latency includes every discarded attempt and
 * re-arm of one obligation; invalid and NOT_VERIFIED reviews are never counted
 * as fast valid reviews.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeReviewObligations,
  analyzeRoot,
  summarize,
} from '../../../demos/lib/review-latency.mjs';

const T0 = '2026-10-18T10:00:00.000Z';
const T1 = '2026-10-18T10:00:10.000Z';
const T2 = '2026-10-18T10:00:20.000Z';
const T3 = '2026-10-18T10:00:50.000Z';

function state(overrides: Record<string, unknown> = {}) {
  return {
    reviewAssurance: {
      obligations: [
        { obligationId: 'plan-1', obligationType: 'plan', status: 'consumed' },
        { obligationId: 'impl-1', obligationType: 'implement', status: 'consumed' },
        { obligationId: 'arch-1', obligationType: 'architecture', status: 'blocked' },
        { obligationId: 'review-1', obligationType: 'review', status: 'pending' },
      ],
      attempts: [
        {
          attemptId: 'plan-a1',
          obligationId: 'plan-1',
          status: 'stale',
          ordinal: 0,
          origin: { kind: 'initial' },
          createdAt: T0,
          completedAt: T1,
        },
        {
          attemptId: 'plan-a2',
          obligationId: 'plan-1',
          status: 'bound',
          ordinal: 1,
          origin: { kind: 'dispatch_rearm' },
          createdAt: T2,
          completedAt: T3,
        },
        {
          attemptId: 'impl-a1',
          obligationId: 'impl-1',
          status: 'bound',
          ordinal: 0,
          origin: { kind: 'initial' },
          createdAt: T0,
          completedAt: T1,
        },
        {
          attemptId: 'arch-a1',
          obligationId: 'arch-1',
          status: 'stale',
          ordinal: 0,
          origin: { kind: 'initial' },
          createdAt: T0,
          completedAt: T1,
        },
        {
          attemptId: 'review-a1',
          obligationId: 'review-1',
          status: 'created',
          ordinal: 0,
          origin: { kind: 'initial' },
          createdAt: T0,
          completedAt: null,
        },
      ],
      invocations: [
        {
          invocationId: 'plan-i1',
          obligationId: 'plan-1',
          attemptId: 'plan-a2',
          invokedAt: T2,
          fulfilledAt: T3,
          capturedVerdict: 'accept',
        },
        {
          invocationId: 'impl-i1',
          obligationId: 'impl-1',
          attemptId: 'impl-a1',
          invokedAt: T0,
          fulfilledAt: T1,
          capturedVerdict: 'unable_to_review',
        },
      ],
      ...overrides,
    },
  };
}

interface LatencyReview {
  obligationId: string;
  type: string;
  terminal: string;
  valid: boolean;
  verdict: string | null;
  attemptCount: number;
  rearmAttemptIds: string[];
  timeToTerminalMs: number | null;
}

interface LatencySummaryRow {
  type: string;
  valid: number;
  invalid: number;
  blocked: number;
  pending: number;
  medianTimeToValidMs: number | string;
  medianInvalidElapsedMs: number | string;
  rearmCount: number;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('review latency', () => {
  it('measures one obligation end-to-end including its discarded attempt and re-arm', () => {
    const reviews = analyzeReviewObligations(state()) as LatencyReview[];
    const plan = reviews.find((review) => review.obligationId === 'plan-1');
    expect(plan).toMatchObject({
      type: 'plan',
      terminal: 'valid',
      valid: true,
      verdict: 'accept',
      attemptCount: 2,
      rearmAttemptIds: ['plan-a2'],
    });
    expect(plan?.timeToTerminalMs).toBe(Date.parse(T3) - Date.parse(T0));
  });

  it('keeps a bound unable_to_review out of the valid median and reports its elapsed time', () => {
    const summary = summarize(analyzeReviewObligations(state())) as LatencySummaryRow[];
    const plan = summary.find((row) => row.type === 'plan');
    const impl = summary.find((row) => row.type === 'implement');
    expect(plan).toMatchObject({ valid: 1, medianTimeToValidMs: 50000 });
    expect(impl).toMatchObject({ valid: 0, invalid: 1, medianTimeToValidMs: 'NOT_VERIFIED' });
    expect(impl?.medianInvalidElapsedMs).toBe(10000);
  });

  it('classifies blocked and pending obligations without inventing a valid review', () => {
    const summary = summarize(analyzeReviewObligations(state())) as LatencySummaryRow[];
    expect(summary.find((row) => row.type === 'architecture')).toMatchObject({
      blocked: 1,
      valid: 0,
    });
    expect(summary.find((row) => row.type === 'review')).toMatchObject({
      pending: 1,
      valid: 0,
    });
  });

  it('counts a re-arm once per obligation', () => {
    const reviews = analyzeReviewObligations(
      state({
        attempts: [
          {
            attemptId: 'plan-a1',
            obligationId: 'plan-1',
            status: 'stale',
            ordinal: 0,
            origin: { kind: 'initial' },
            createdAt: T0,
            completedAt: T1,
          },
          {
            attemptId: 'plan-a2',
            obligationId: 'plan-1',
            status: 'stale',
            ordinal: 1,
            origin: { kind: 'dispatch_rearm' },
            createdAt: T2,
            completedAt: T2,
          },
          {
            attemptId: 'plan-a3',
            obligationId: 'plan-1',
            status: 'bound',
            ordinal: 2,
            origin: { kind: 'dispatch_rearm' },
            createdAt: T3,
            completedAt: T3,
          },
        ],
        invocations: [
          {
            invocationId: 'plan-i1',
            obligationId: 'plan-1',
            attemptId: 'plan-a3',
            invokedAt: T3,
            fulfilledAt: T3,
            capturedVerdict: 'accept',
          },
        ],
      }),
    );
    const plan = (reviews as LatencyReview[]).find((review) => review.obligationId === 'plan-1');
    expect(plan?.rearmAttemptIds).toEqual(['plan-a2', 'plan-a3']);
    expect(
      (summarize(reviews) as LatencySummaryRow[]).find((row) => row.type === 'plan')?.rearmCount,
    ).toBe(2);
  });

  it('reads a run root through the parent flow sessions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-review-latency-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
    await fs.mkdir(path.join(root, 'config', 'workspaces', 'fp', 'sessions', 'ses_parent'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, 'evidence', 'flows.json'),
      JSON.stringify([{ name: 'development', hostSessionId: 'ses_parent' }]),
    );
    await fs.writeFile(
      path.join(root, 'config', 'workspaces', 'fp', 'sessions', 'ses_parent', 'session-state.json'),
      JSON.stringify(state()),
    );
    const analyzed = analyzeRoot(root);
    expect(analyzed.notVerified).toEqual([]);
    expect(analyzed.reviews.length).toBe(4);
  });

  it('reports missing state as NOT_VERIFIED instead of a zero-duration review', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-review-latency-missing-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'evidence', 'flows.json'),
      JSON.stringify([{ name: 'development', hostSessionId: 'ses_parent' }]),
    );
    const analyzed = analyzeRoot(root);
    expect(analyzed.notVerified).toEqual([
      { root, sessionId: 'ses_parent', reason: 'session_state_missing' },
    ]);
  });
});
