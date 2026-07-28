import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../state/schema.js';
import type { DiscoveryResult } from '../../discovery/types.js';

const mocks = vi.hoisted(() => ({
  readDiscovery: vi.fn(async () => null as DiscoveryResult | null),
}));

vi.mock('../../adapters/persistence-discovery.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, readDiscovery: mocks.readDiscovery };
});

import { resolveArchitectureChallengeClassification } from './architecture-challenge.js';
import { CHALLENGE_POLICY_V1 } from '../../config/policy-types.js';

const withChallenge = {
  policySnapshot: { challengePolicy: CHALLENGE_POLICY_V1 },
} as unknown as SessionState;
const withoutChallenge = { policySnapshot: {} } as unknown as SessionState;
const noSnapshot = {} as unknown as SessionState;

function persistenceDiscovery(evidence: string[]): DiscoveryResult {
  return {
    surfaces: {
      api: [],
      persistence: [{ id: 'r', label: 'r', classification: 'fact', evidence }],
      cicd: [],
      security: [],
      layers: [],
    },
  } as unknown as DiscoveryResult;
}

describe('resolveArchitectureChallengeClassification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readDiscovery.mockResolvedValue(null);
  });

  it('not_required when subagent review is disabled (no discovery read)', async () => {
    const r = await resolveArchitectureChallengeClassification(withChallenge, '/ws', false, ['a']);
    expect(r).toEqual({ kind: 'not_required' });
    expect(mocks.readDiscovery).not.toHaveBeenCalled();
  });

  it('not_required when no challengePolicy is active (no discovery read)', async () => {
    const r = await resolveArchitectureChallengeClassification(withoutChallenge, '/ws', true, [
      'a',
    ]);
    expect(r).toEqual({ kind: 'not_required' });
    expect(mocks.readDiscovery).not.toHaveBeenCalled();
  });

  it('not_required and never throws when policySnapshot is absent', async () => {
    const r = await resolveArchitectureChallengeClassification(noSnapshot, '/ws', true);
    expect(r).toEqual({ kind: 'not_required' });
    expect(mocks.readDiscovery).not.toHaveBeenCalled();
  });

  it('available: unions caller targetPaths with discovery risk paths, deduped', async () => {
    mocks.readDiscovery.mockResolvedValueOnce(persistenceDiscovery(['src/db.ts']));
    const r = await resolveArchitectureChallengeClassification(withChallenge, '/ws', true, [
      'src/db.ts',
      'src/api.ts',
    ]);
    expect(r).toEqual({ kind: 'available', changedFiles: ['src/db.ts', 'src/api.ts'] });
    expect(mocks.readDiscovery).toHaveBeenCalledWith('/ws');
  });

  it('available with an empty set when no targetPaths and empty discovery (never unavailable)', async () => {
    const r = await resolveArchitectureChallengeClassification(withChallenge, '/ws', true);
    expect(r).toEqual({ kind: 'available', changedFiles: [] });
  });
});
