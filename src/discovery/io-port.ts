/**
 * @module discovery/io-port
 * @description Structural I/O port for the discovery context.
 *
 * discovery/ must not import adapters; command/composition callers inject the
 * adapter-backed capabilities (`src/integration/discovery/discovery-io.ts`).
 * The port carries capabilities, not whole adapter modules.
 *
 * @version v1
 */

import type { DiscoveryResult } from './types.js';

/** Repository signals needed by discovery planning (structural subset). */
export interface DiscoveryRepoSignals {
  readonly files: readonly string[];
  readonly packageFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly packageFilePaths: readonly string[];
  readonly configFilePaths: readonly string[];
}

/** Injected read-only I/O capabilities for discovery. */
export interface DiscoveryIoPort {
  readPersistedDiscovery(workspaceDir: string): Promise<DiscoveryResult | null>;
  listRepoSignals(worktree: string): Promise<DiscoveryRepoSignals>;
  defaultBranch(worktree: string): Promise<string | null>;
  headCommit(worktree: string): Promise<string | null>;
  isClean(worktree: string): Promise<boolean>;
  remoteOriginUrl(worktree: string): Promise<string | null>;
}
