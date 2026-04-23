/**
 * @module testing
 * @description Test utilities for the FlowGuard runtime.
 *
 * Separated from production code to ensure test helpers
 * are never accidentally imported in production bundles.
 *
 * Usage in tests:
 *   import { createTestContext } from "@flowguard/core/testing";
 *
 * @version v1
 */

import type { RailContext } from './rails/types.js';

// ─── Test Context Factory ────────────────────────────────────────────────────

/**
 * Create a deterministic RailContext for testing.
 *
 * @param fixedTime - Fixed ISO-8601 timestamp. now() always returns this.
 * @param digestFn - Optional custom digest function. Defaults to "digest-of-{input}".
 *
 * Usage in tests:
 *   const ctx = createTestContext("2026-01-01T00:00:00.000Z");
 *   expect(ctx.now()).toBe("2026-01-01T00:00:00.000Z"); // deterministic
 *   expect(ctx.digest("hello")).toBe("digest-of-hello"); // predictable
 */
export function createTestContext(
  fixedTime: string = '2026-01-01T00:00:00.000Z',
  digestFn?: (text: string) => string,
): RailContext {
  return {
    now: () => fixedTime,
    digest: digestFn ?? ((text: string) => `digest-of-${text}`),
  };
}
