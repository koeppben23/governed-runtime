import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../state/schema.js';
import { makeState } from '../../fixtures.js';
import { CHALLENGE_POLICY_V1 } from '../../config/policy-types.js';

const mocks = vi.hoisted(() => ({
  loadBranchChangedFiles:
    vi.fn<(branch: string, base: string | undefined, worktree: string) => string[]>(),
  loadPrChangedFiles: vi.fn<(prNumber: number) => string[]>(),
}));

vi.mock('../../adapters/gh-cli.js', () => ({
  loadBranchChangedFiles: mocks.loadBranchChangedFiles,
  loadPrChangedFiles: mocks.loadPrChangedFiles,
}));

const { resolveChallengeClassificationEvidence } =
  await import('./review-obligation-classification.js');

function stateWithChallengePolicy() {
  const base = makeState('REVIEW');
  return {
    ...base,
    policySnapshot: { ...base.policySnapshot!, challengePolicy: CHALLENGE_POLICY_V1 },
  } as typeof base;
}

describe('resolveChallengeClassificationEvidence', () => {
  beforeEach(() => {
    mocks.loadBranchChangedFiles.mockReset();
    mocks.loadPrChangedFiles.mockReset();
  });

  it('returns not_required when the session carries no policy snapshot', async () => {
    const state = makeState('REVIEW');
    const result = await resolveChallengeClassificationEvidence(
      { ...state, policySnapshot: undefined as unknown as SessionState['policySnapshot'] },
      '/repo',
      {
        targetPaths: ['docs/x.md'],
      },
    );
    expect(result).toEqual({ kind: 'not_required' });
  });

  it('uses author-declared targetPaths as the review scope', async () => {
    const result = await resolveChallengeClassificationEvidence(
      stateWithChallengePolicy(),
      '/repo',
      {
        targetPaths: ['docs/x.md'],
      },
    );
    expect(result).toEqual({ kind: 'available', changedFiles: ['docs/x.md'] });
  });

  it('falls back to branch-diff evidence when no targetPaths are given', async () => {
    mocks.loadBranchChangedFiles.mockReturnValue(['src/security/auth.ts']);
    const result = await resolveChallengeClassificationEvidence(
      stateWithChallengePolicy(),
      '/repo',
      {
        branch: 'feat/x',
      },
    );
    expect(result).toEqual({ kind: 'available', changedFiles: ['src/security/auth.ts'] });
  });

  it('falls back to PR-diff evidence when no targetPaths are given', async () => {
    mocks.loadPrChangedFiles.mockReturnValue(['src/state/schema.ts']);
    const result = await resolveChallengeClassificationEvidence(
      stateWithChallengePolicy(),
      '/repo',
      {
        prNumber: 42,
      },
    );
    expect(result).toEqual({ kind: 'available', changedFiles: ['src/state/schema.ts'] });
  });

  it('returns unavailable when neither targetPaths nor VCS evidence exist', async () => {
    mocks.loadBranchChangedFiles.mockReturnValue([]);
    const result = await resolveChallengeClassificationEvidence(
      stateWithChallengePolicy(),
      '/repo',
      {},
    );
    expect(result.kind).toBe('unavailable');
  });
});
