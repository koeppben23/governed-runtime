/**
 * @module integration/test-adapter-helper
 * @description Test utility for creating a HostAdapter from a mock OrchestratorClient.
 *
 * Used by orchestrator pipeline tests that need to satisfy the OrchestratorDeps.adapter field.
 * Delegates spawnReviewer to the real invokeReviewer function with the provided mock client,
 * ensuring identical behavior to production.
 *
 * @internal — test-only module
 */

import type { HostAdapter } from '../adapters/host-adapter.js';
import type { OrchestratorClient } from './review/types.js';
import { OpenCodeHostAdapter } from './opencode-host-adapter.js';

/**
 * Create a HostAdapter wrapping a mock client for test use.
 * The adapter delegates spawnReviewer to the real invokeReviewer,
 * which uses the mock client's session.create/prompt methods.
 */
export function createTestAdapter(client: unknown): HostAdapter {
  return new OpenCodeHostAdapter({
    client: client as OrchestratorClient,
    getSessionId: () => 'test-session',
    directory: '/test/dir',
    worktree: '/test/worktree',
  });
}
