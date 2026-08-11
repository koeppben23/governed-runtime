import { describe, expect, it } from 'vitest';
import { makeProgressedState } from '../../fixtures.js';
import { resolveCurrentReviewReport } from './report-coherence.js';
import type { ReviewReport } from '../../state/evidence.js';
import { evaluateCompleteness } from '../../audit/completeness.js';

function makeReviewReport(
  state: ReturnType<typeof makeProgressedState>,
  overrides?: Partial<Extract<ReviewReport, { readonly reviewKind: 'lifecycle_review' }>>,
): ReviewReport {
  return {
    reviewKind: 'lifecycle_review',
    schemaVersion: 'flowguard-review-report.v1',
    sessionId: state.id,
    generatedAt: '2026-01-01T00:00:00.000Z',
    phase: state.phase,
    planDigest: state.plan?.current.digest ?? null,
    implDigest: state.implementation?.digest ?? null,
    validationSummary: [],
    findings: [],
    overallStatus: 'clean',
    completeness: evaluateCompleteness(state),
    ...overrides,
  };
}

describe('resolveCurrentReviewReport', () => {
  it('session mismatch → foreign / foreign_session', () => {
    const state = makeProgressedState('COMPLETE');
    const report = makeReviewReport(state, { sessionId: 'other-session' });
    const result = resolveCurrentReviewReport(state, report);
    expect(result.status).toBe('foreign');
    if (result.status === 'foreign') {
      expect(result.reasonCode).toBe('foreign_session');
    }
  });

  it('phase mismatch → incoherent / phase_mismatch', () => {
    const state = makeProgressedState('COMPLETE');
    const report = makeReviewReport(state, { phase: 'IMPLEMENTATION' });
    const result = resolveCurrentReviewReport(state, report);
    expect(result.status).toBe('incoherent');
    if (result.status === 'incoherent') {
      expect(result.reasonCode).toBe('phase_mismatch');
    }
  });

  it('plan digest mismatch → stale / stale_plan_digest', () => {
    const state = makeProgressedState('COMPLETE');
    const report = makeReviewReport(state, { planDigest: 'stale-digest' });
    const result = resolveCurrentReviewReport(state, report);
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reasonCode).toBe('stale_plan_digest');
    }
  });

  it('impl digest mismatch → stale / stale_impl_digest', () => {
    const state = makeProgressedState('COMPLETE');
    const report = makeReviewReport(state, { implDigest: 'stale-digest' });
    const result = resolveCurrentReviewReport(state, report);
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reasonCode).toBe('stale_impl_digest');
    }
  });

  it('full match → current', () => {
    const state = makeProgressedState('COMPLETE');
    const report = makeReviewReport(state);
    const result = resolveCurrentReviewReport(state, report);
    expect(result.status).toBe('current');
    if (result.status === 'current') {
      expect(result.report).toBe(report);
    }
  });

  it('null digest matches null state digest', () => {
    const state = makeProgressedState('REVIEW_COMPLETE');
    const report = makeReviewReport(state, { planDigest: null, implDigest: null });
    // review-complete state has no plan/impl
    const result = resolveCurrentReviewReport(state, report);
    expect(result.status).toBe('current');
  });
});
