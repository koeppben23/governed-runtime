/**
 * @module context
 * @description Production RailContext factory.
 *
 * RailContext provides two determinism-critical utilities to rails:
 * - now(): current ISO-8601 timestamp
 * - digest(): SHA-256 hex digest of a string
 *
 * These are injected (not imported) so that tests can substitute
 * deterministic implementations:
 *   - Fixed timestamps for reproducible state assertions
 *   - Known digests for snapshot testing
 *
 * Production implementation:
 * - now() returns new Date().toISOString() (UTC, millisecond precision)
 * - digest() returns crypto.createHash("sha256").update(text).digest("hex")
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import type { RailContext } from '../rails/types.js';

// -- Factory ------------------------------------------------------------------

/**
 * Create a production RailContext.
 *
 * This is the factory used by the OpenCode integration layer.
 * Every rail call gets a fresh context (no shared mutable state).
 */
export function createRailContext(): RailContext {
  return {
    now: () => new Date().toISOString(),
    digest: (text: string) => crypto.createHash('sha256').update(text, 'utf-8').digest('hex'),
  };
}
