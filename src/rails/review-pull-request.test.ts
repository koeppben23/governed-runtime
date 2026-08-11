import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolvePullRequestReviewSource: vi.fn(),
  loadResolvedPullRequestDiff: vi.fn(),
}));

vi.mock('../adapters/gh-cli.js', () => ({
  loadResolvedBranchDiff: vi.fn(),
  resolvePullRequestReviewSource: mocks.resolvePullRequestReviewSource,
  loadResolvedPullRequestDiff: mocks.loadResolvedPullRequestDiff,
}));

import { loadExternalContent } from './review.js';

describe('immutable pull-request review materialization', () => {
  beforeEach(() => {
    mocks.resolvePullRequestReviewSource.mockReset();
    mocks.loadResolvedPullRequestDiff.mockReset();
  });

  it('builds a frozen repository subject from resolved PR identities and SHAs', async () => {
    const resolved = {
      pullRequestNumber: 42,
      baseRepository: { host: 'github.com', owner: 'upstream', name: 'project' },
      headRepository: { host: 'github.com', owner: 'contributor', name: 'project-fork' },
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    };
    mocks.resolvePullRequestReviewSource.mockReturnValue(resolved);
    mocks.loadResolvedPullRequestDiff.mockReturnValue(
      'diff --git a/src/a.ts b/src/a.ts\n+new line\n',
    );

    const result = await loadExternalContent({ prNumber: 42 });

    expect(mocks.loadResolvedPullRequestDiff).toHaveBeenCalledWith(resolved);
    expect(result).toMatchObject({
      content: 'diff --git a/src/a.ts b/src/a.ts\n+new line\n',
      reviewSubject: {
        kind: 'repository_change',
        source: { kind: 'pull_request', pullRequestNumber: 42 },
        baseRepository: resolved.baseRepository,
        headRepository: resolved.headRepository,
        baseSha: resolved.baseSha,
        headSha: resolved.headSha,
        changedPaths: ['src/a.ts'],
      },
    });
    if (result && 'reviewSubject' in result) {
      expect(result.reviewSubject.materialDigest).toMatch(/^(?:sha256:)?[a-f0-9]{64}$/);
      expect(result.reviewSubject.subjectDigest).toMatch(/^(?:sha256:)?[a-f0-9]{64}$/);
    }
  });

  it('fails closed when immutable PR resolution fails', async () => {
    mocks.resolvePullRequestReviewSource.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = await loadExternalContent({ prNumber: 42 });

    expect(result).toMatchObject({ kind: 'blocked', code: 'COMMAND_BLOCKED' });
    expect(mocks.loadResolvedPullRequestDiff).not.toHaveBeenCalled();
  });
});
