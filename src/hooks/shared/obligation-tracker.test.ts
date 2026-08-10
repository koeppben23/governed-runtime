import { describe, it, expect } from 'vitest';
import { unresolvedBlockingObligations, assessObligationEscalation } from './obligation-tracker.js';
import { makeState } from '../../fixtures.js';
import type { ReviewObligation } from '../../state/evidence.js';

const FIXED_UUID = '550e8400-e29b-41d4-a716-446655440000';
const FIXED_DATETIME = '2026-01-01T00:00:00.000Z';

function reviewAssurance(obligations: ReviewObligation[]) {
  return { obligations, invocations: [], attempts: [] };
}

function makeObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
  return {
    obligationId: FIXED_UUID,
    obligationType: 'plan',
    subjectDigest: 'test-subject-digest',
    iteration: 1,
    planVersion: 1,
    criteriaVersion: 'v1',
    mandateDigest: 'abc123',
    createdAt: FIXED_DATETIME,
    pluginHandshakeAt: null,
    status: 'pending',
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    reviewSubjectScope: {
      kind: 'repository_change',
      paths: ['src/foo.ts'],
      revisions: ['base', 'head'],
    },
    ...overrides,
  };
}

describe('unresolvedBlockingObligations', () => {
  it('returns empty array when no obligations exist', () => {
    const state = makeState('READY', { reviewAssurance: reviewAssurance([]) });
    const result = unresolvedBlockingObligations(state);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when reviewAssurance is undefined', () => {
    const state = makeState('READY');
    const result = unresolvedBlockingObligations(state);
    expect(result).toHaveLength(0);
  });

  it('filters out consumed obligations (status consumed)', () => {
    const consumed = makeObligation({ status: 'consumed', consumedAt: null });
    const state = makeState('READY', { reviewAssurance: reviewAssurance([consumed]) });
    const result = unresolvedBlockingObligations(state);
    expect(result).toHaveLength(0);
  });

  it('filters out obligations with consumedAt set', () => {
    const consumed = makeObligation({ status: 'pending', consumedAt: FIXED_DATETIME });
    const state = makeState('READY', { reviewAssurance: reviewAssurance([consumed]) });
    const result = unresolvedBlockingObligations(state);
    expect(result).toHaveLength(0);
  });

  it('returns pending obligations (not consumed, no consumedAt)', () => {
    const pending = makeObligation({ status: 'pending', consumedAt: null });
    const state = makeState('READY', { reviewAssurance: reviewAssurance([pending]) });
    const result = unresolvedBlockingObligations(state);
    expect(result).toHaveLength(1);
    const [obligation] = result;
    if (!obligation) throw new TypeError('expected pending obligation');
    expect(obligation.status).toBe('pending');
  });

  it('returns only non-consumed obligations in mixed list', () => {
    const pending = makeObligation({
      status: 'pending',
      consumedAt: null,
      obligationId: 'a'.repeat(36).replace(/a/, '1'),
    });
    const fulfilled = makeObligation({
      status: 'fulfilled',
      consumedAt: null,
      obligationId: 'b'.repeat(36).replace(/b/, '2'),
    });
    const consumed = makeObligation({
      status: 'consumed',
      consumedAt: null,
      obligationId: 'c'.repeat(36).replace(/c/, '3'),
    });
    const state = makeState('READY', {
      reviewAssurance: reviewAssurance([pending, fulfilled, consumed]),
    });
    const result = unresolvedBlockingObligations(state);
    expect(result).toHaveLength(2);
    expect(result.find((o) => o.status === 'consumed')).toBeUndefined();
  });
});

describe('assessObligationEscalation', () => {
  it('returns none when no pending obligations', () => {
    const state = makeState('READY', { reviewAssurance: reviewAssurance([]) });
    const result = assessObligationEscalation(state, true, '2026-01-01T00:05:00.000Z');
    expect(result.level).toBe('none');
    expect(result.pendingCount).toBe(0);
  });

  it('returns none for non-mutating tools even with pending obligations', () => {
    const pending = makeObligation({
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const state = makeState('READY', { reviewAssurance: reviewAssurance([pending]) });
    const result = assessObligationEscalation(state, false, '2026-01-01T00:05:00.000Z');
    expect(result.level).toBe('none');
  });

  it('returns info for mutating tool with recent pending obligation', () => {
    const pending = makeObligation({
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const state = makeState('READY', { reviewAssurance: reviewAssurance([pending]) });
    const result = assessObligationEscalation(state, true, '2026-01-01T00:00:30.000Z');
    expect(result.level).toBe('info');
    expect(result.pendingCount).toBe(1);
  });

  it('returns warn when oldest obligation age >= 60s', () => {
    const pending = makeObligation({
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const state = makeState('READY', { reviewAssurance: reviewAssurance([pending]) });
    const result = assessObligationEscalation(state, true, '2026-01-01T00:01:00.000Z');
    expect(result.level).toBe('warn');
  });

  it('returns critical when oldest obligation age >= 180s', () => {
    const pending = makeObligation({
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const state = makeState('READY', { reviewAssurance: reviewAssurance([pending]) });
    const result = assessObligationEscalation(state, true, '2026-01-01T00:03:00.000Z');
    expect(result.level).toBe('critical');
  });

  it('returns critical when obligation age exactly equals 180s', () => {
    const pending = makeObligation({
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const state = makeState('READY', { reviewAssurance: reviewAssurance([pending]) });
    const result = assessObligationEscalation(state, true, '2026-01-01T00:03:00.000Z');
    expect(result.level).toBe('critical');
  });

  it('uses oldest pending obligation for age computation', () => {
    const old = makeObligation({
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      obligationId: 'a'.repeat(36).replace(/a/, '1'),
    });
    const recent = makeObligation({
      status: 'pending',
      createdAt: '2026-01-01T00:02:00.000Z',
      obligationId: 'b'.repeat(36).replace(/b/, '2'),
    });
    const state = makeState('READY', {
      reviewAssurance: reviewAssurance([old, recent]),
    });
    const result = assessObligationEscalation(state, true, '2026-01-01T00:03:00.000Z');
    expect(result.level).toBe('critical');
    expect(result.pendingCount).toBe(2);
  });
});
