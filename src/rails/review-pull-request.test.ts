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
import { hashText } from '../shared/hashing.js';

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

  it('scopes reviewer material, subject paths, and digests to validated target paths', async () => {
    const resolved = {
      pullRequestNumber: 42,
      baseRepository: { host: 'github.com', owner: 'upstream', name: 'project' },
      headRepository: { host: 'github.com', owner: 'contributor', name: 'project-fork' },
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    };
    mocks.resolvePullRequestReviewSource.mockReturnValue(resolved);
    mocks.loadResolvedPullRequestDiff.mockReturnValue(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/other.ts b/other.ts
@@ -1 +1 @@
-old
+new
`);

    const scoped = await loadExternalContent({ prNumber: 42, targetPaths: ['old.ts'] });
    expect(scoped).toMatchObject({
      content: expect.stringContaining('rename to new.ts'),
      reviewSubject: { changedPaths: ['new.ts', 'old.ts'] },
    });
    if (!scoped || !('content' in scoped)) return;
    expect(scoped.content).not.toContain('other.ts');
    expect(hashText(scoped.content)).toBe(scoped.reviewSubject.materialDigest);
    expect(await loadExternalContent({ prNumber: 42, targetPaths: ['missing.ts'] })).toMatchObject({
      kind: 'blocked',
      code: 'COMMAND_BLOCKED',
    });
  });
});
