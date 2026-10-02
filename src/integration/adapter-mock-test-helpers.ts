/**
 * @module integration/adapter-mock-test-helpers
 * @description Dependency-free vi.mock factories for adapter modules.
 *
 * These factories exist so test files do not repeat the same adapter mock
 * bodies. They are loaded through a dynamic `import()` inside the hoisted
 * `vi.mock` factory: a static import of this module in the test file would be
 * in the temporal dead zone when Vitest evaluates the hoisted factory.
 *
 * @version v1
 */

import { vi } from 'vitest';

/**
 * Canonical vi.mock factory for the frozen-repository adapter.
 *
 * Usage:
 *   vi.mock('../adapters/frozen-repository.js', async (importOriginal) => {
 *     const { frozenRepositoryAdapterMock } = await import(
 *       '../adapter-mock-test-helpers.js'
 *     );
 *     return frozenRepositoryAdapterMock(
 *       await importOriginal<typeof import('../adapters/frozen-repository.js')>(),
 *     );
 *   });
 */
export function frozenRepositoryAdapterMock<T extends object>(
  original: T,
  options: { readonly rootCommitDigest?: string; readonly worktreeCandidateSha?: string } = {},
): T {
  const rootCommitDigest = options.rootCommitDigest ?? `sha256:${'b'.repeat(64)}`;
  const worktreeCandidateSha = options.worktreeCandidateSha ?? 'c'.repeat(40);
  return {
    ...original,
    freezeRepositoryIdentity: vi.fn(() => ({ kind: 'local' as const, rootCommitDigest })),
    freezeWorktreeCandidate: vi.fn().mockResolvedValue(worktreeCandidateSha),
  };
}

/**
 * Canonical vi.mock factory for the git control-plane marker computation.
 *
 * Usage:
 *   vi.mock('../git-control-plane.js', async (importOriginal) => {
 *     const { gitControlPlaneAdapterMock } = await import(
 *       '../adapter-mock-test-helpers.js'
 *     );
 *     return gitControlPlaneAdapterMock(
 *       await importOriginal<typeof import('../git-control-plane.js')>(),
 *     );
 *   });
 */
export function gitControlPlaneAdapterMock<T extends object>(
  original: T,
  marker = 'test-control-plane-marker',
): T {
  return {
    ...original,
    computeGitControlPlaneMarker: vi.fn().mockResolvedValue(marker),
  };
}
