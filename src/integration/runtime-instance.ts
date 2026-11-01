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

// Native plugin reload can evaluate another bundled copy of this module in the
// SAME process. The identity belongs to that process, not a module generation.
const RUNTIME_INSTANCE = Symbol.for('@flowguard/core/runtime-instance');
const processRuntime = globalThis as typeof globalThis & { [RUNTIME_INSTANCE]?: string };

/** Lazily minted, stable for the lifetime of this process. */
export function getRuntimeInstanceId(): string {
  processRuntime[RUNTIME_INSTANCE] ??= randomUUID();
  return processRuntime[RUNTIME_INSTANCE];
}

/**
 * Test-only seam: simulate a fresh process identity. A real restart mints a
 * new id automatically; this is never called from production code paths.
 */
export function resetRuntimeInstanceIdForTest(next?: string): string {
  processRuntime[RUNTIME_INSTANCE] = next ?? randomUUID();
  return processRuntime[RUNTIME_INSTANCE];
}
