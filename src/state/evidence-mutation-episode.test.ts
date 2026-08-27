import { describe, expect, it } from 'vitest';
import {
  authorizeMutationEpisode,
  completeMutationEpisode,
  hasUnresolvedMutationEpisodes,
  reconcileMutationEpisodes,
} from './evidence-mutation-episode.js';

const ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';
const TIME = '2026-01-01T00:00:00.000Z';

describe('mutation episode evidence', () => {
  it('binds completed success and failure outcomes and stales historical evidence', () => {
    const authorized = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'edit',
      authorizedAt: TIME,
    });
    expect(hasUnresolvedMutationEpisodes(authorized)).toBe(true);

    const secondAuthorized = authorizeMutationEpisode(authorized, {
      episodeId: SECOND_ID,
      hostCallId: 'call-2',
      toolName: 'bash',
      authorizedAt: TIME,
    });
    const completed = completeMutationEpisode(
      completeMutationEpisode(secondAuthorized, 'call-1', TIME, 'failure'),
      'call-2',
      TIME,
      'success',
    );
    const bound = reconcileMutationEpisodes(completed, 'implementation-1');
    expect(bound).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'completed',
          outcome: 'failure',
          implementationDigest: 'implementation-1',
          evidenceStatus: 'eligible',
        }),
        expect.objectContaining({
          status: 'completed',
          outcome: 'success',
          implementationDigest: 'implementation-1',
          evidenceStatus: 'eligible',
        }),
      ]),
    );

    const reconciled = reconcileMutationEpisodes(bound, 'implementation-2');
    expect(reconciled[0]?.evidenceStatus).toBe('stale');
  });
});
