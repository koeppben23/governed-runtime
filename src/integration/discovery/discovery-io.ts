/**
 * @module integration/discovery/discovery-io
 * @description Adapter-backed implementation of the discovery I/O port.
 *
 * discovery/ must not import adapters; this module is the single injection
 * point used by discovery callers in the integration layer.
 *
 * @version v1
 */

import { listRepoSignals } from '../../adapters/git.js';
import { defaultBranch, headCommit, isClean, remoteOriginUrl } from '../../adapters/git-branch.js';
import { readDiscovery } from '../../adapters/persistence-discovery.js';
import type { DiscoveryIoPort } from '../../discovery/io-port.js';

/**
 * Adapter-backed discovery I/O. The capabilities are lazy wrappers so a partial
 * test mock of an adapter module cannot break module import time; the adapter
 * call happens at use time.
 */
export const DISCOVERY_IO: DiscoveryIoPort = {
  readPersistedDiscovery: (workspaceDir) => readDiscovery(workspaceDir),
  listRepoSignals: (worktree) => listRepoSignals(worktree),
  defaultBranch: (worktree) => defaultBranch(worktree),
  headCommit: (worktree) => headCommit(worktree),
  isClean: (worktree) => isClean(worktree),
  remoteOriginUrl: (worktree) => remoteOriginUrl(worktree),
};
