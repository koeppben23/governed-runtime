import { describe, expect, it } from 'vitest';
import { makeState } from '../fixtures.js';
import { SessionState } from './schema.js';

describe('regulated archive state contract', () => {
  it('requires regulatedArchiveStatus in the current session-state epoch', () => {
    const current = makeState('TICKET');
    const persisted = { ...current } as Record<string, unknown>;
    delete persisted.regulatedArchiveStatus;

    expect(SessionState.safeParse(persisted).success).toBe(false);
  });

  it('uses explicit null before the regulated archive lifecycle starts', () => {
    const current = makeState('TICKET');

    expect(current.regulatedArchiveStatus).toBeNull();
    expect(SessionState.safeParse(current).success).toBe(true);
  });
});
