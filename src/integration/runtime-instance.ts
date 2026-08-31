/**
 * @module integration/runtime-instance
 * @description Per-process runtime instance identity.
 *
 * The Recovery Authority boundary: a host mutation episode records the
 * runtime instance that authorized its dispatch. A resolution
 * (`reconciled_after_unknown_outcome`) may only be granted by a SUBSEQUENT
 * runtime instance — a process that cannot be the one still executing the
 * host call. Within the same instance the call may simply still be running,
 * so "outcome unknown" is not yet an authority statement.
 */

import { randomUUID } from 'node:crypto';

let runtimeInstanceId: string | null = null;

/** Lazily minted, stable for the lifetime of this process. */
export function getRuntimeInstanceId(): string {
  runtimeInstanceId ??= randomUUID();
  return runtimeInstanceId;
}

/**
 * Test-only seam: simulate a fresh process identity. A real restart mints a
 * new id automatically; this is never called from production code paths.
 */
export function resetRuntimeInstanceIdForTest(next?: string): string {
  runtimeInstanceId = next ?? randomUUID();
  return runtimeInstanceId;
}
