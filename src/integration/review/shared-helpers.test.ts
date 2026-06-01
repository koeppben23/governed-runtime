import { describe, it, expect, vi, beforeEach } from 'vitest';

// #401: content/PR review must check Discovery drift (not just health) before
// repo-dependent quality claims. This isolates the loader so we can assert the
// pipeline helper requests a bounded drift check.
const buildReviewDiscoveryContext = vi.fn();

vi.mock('./discovery-context-loader.js', () => ({
  buildReviewDiscoveryContext: (input: unknown) => buildReviewDiscoveryContext(input),
}));

import { buildReviewDiscoveryContextForPipeline } from './shared-helpers.js';
import type { PipelineContext } from './pipeline-types.js';

describe('buildReviewDiscoveryContextForPipeline (#401 drift)', () => {
  beforeEach(() => {
    buildReviewDiscoveryContext.mockReset();
    buildReviewDiscoveryContext.mockResolvedValue({ verificationCandidates: [] });
  });

  function makeCtx(): PipelineContext {
    return {
      sessionState: { binding: { worktree: '/tmp/repo' } },
      deps: {
        resolveFingerprint: vi.fn().mockResolvedValue('fp-1'),
        log: { warn: vi.fn(), info: vi.fn() },
        adapter: { getWorktree: () => '/tmp/repo' },
      },
    } as unknown as PipelineContext;
  }

  it('requests a drift check for content/PR review (includeDriftCheck: true)', async () => {
    await buildReviewDiscoveryContextForPipeline(makeCtx());

    expect(buildReviewDiscoveryContext).toHaveBeenCalledTimes(1);
    const input = buildReviewDiscoveryContext.mock.calls[0][0] as { includeDriftCheck?: boolean };
    expect(input.includeDriftCheck).toBe(true);
  });

  it('passes resolved fingerprint and worktree to the loader', async () => {
    await buildReviewDiscoveryContextForPipeline(makeCtx());

    const input = buildReviewDiscoveryContext.mock.calls[0][0] as {
      fingerprint?: string | null;
      worktree?: string;
    };
    expect(input.fingerprint).toBe('fp-1');
    expect(input.worktree).toBe('/tmp/repo');
  });
});
