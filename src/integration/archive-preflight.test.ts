import { describe, expect, it } from 'vitest';
import { makeState } from '../fixtures.js';
import { evaluateArchivePreflight } from './archive-preflight.js';

describe('evaluateArchivePreflight', () => {
  it('requires a session', () => {
    const result = evaluateArchivePreflight(null);
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reasonCode).toBe('SESSION_REQUIRED');
  });

  it('requires a clean terminal state', () => {
    const active = evaluateArchivePreflight(makeState('IMPLEMENTATION'));
    expect(active.status).toBe('blocked');
    if (active.status === 'blocked') expect(active.reasonCode).toBe('TERMINAL_PHASE_REQUIRED');

    const aborted = evaluateArchivePreflight(
      makeState('COMPLETE', {
        error: {
          code: 'ABORTED',
          message: 'Stopped',
          recoveryHint: 'Inspect status',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    expect(aborted.status).toBe('blocked');
    if (aborted.status === 'blocked') expect(aborted.reasonCode).toBe('ABORTED_SESSION');
  });

  it('only guarantees eligibility to attempt archive creation', () => {
    expect(evaluateArchivePreflight(makeState('COMPLETE'))).toEqual({
      status: 'available',
      guarantee: 'eligible_to_attempt',
    });
  });
});
