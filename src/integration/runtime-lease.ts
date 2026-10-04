/**
 * @module integration/runtime-lease
 * @description Per-session runtime lease acquisition with generation fencing.
 *
 * The Recovery Authority contract: at most ONE runtime instance governs a
 * FlowGuard session at any time. The lease is a fencing token — a live
 * holder cannot be superseded by a concurrent instance; ONLY a provably
 * dead holder (ESRCH) can be superseded by a LATER generation. Heartbeat
 * staleness is never fencing authority: a live process may still be
 * executing its host mutation. A MutationEpisode binds the generation of
 * its authorizing lease, and an unknown-outcome resolution is only
 * admissible when the resolving instance holds a lease with a LATER
 * generation than the episode's bound generation: the authorizing epoch is
 * provably over.
 *
 * This module is a PURE decision function over the lease currently recorded
 * in `SessionState`. It performs no I/O: the caller persists the returned
 * lease in the same atomic state write that records whatever the lease
 * authorizes, under the session write lock it already holds. Persisting the
 * fencing token separately from the episode that binds it would make the two
 * independently failable and break generation monotonicity.
 */

import { RuntimeLease } from '../state/runtime-lease.js';

export { RuntimeLease };

export type RuntimeLeaseAcquisition =
  | { readonly kind: 'held'; readonly lease: RuntimeLease }
  | { readonly kind: 'blocked'; readonly lease: RuntimeLease };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // process not found → dead
    return true; // EPERM or unknown → fail-closed: treat as alive
  }
}

/**
 * Decide the runtime lease for this session from the lease currently held in
 * state. The caller MUST already hold the session write lock and MUST persist
 * a `held` result as part of its state write, so the read-modify-write is
 * serialized and the generation advances atomically with what it authorizes.
 *
 * - No lease: mint generation 1 for the calling instance.
 * - Held by the calling instance: refresh the heartbeat.
 * - Held by another instance: blocked while the holder's PID is alive.
 *   Heartbeat staleness NEVER fences a provably live holder — a live process
 *   may still be executing its host mutation. Only a provably dead holder
 *   (ESRCH) is superseded with a LATER generation, the fencing token that
 *   ends the previous epoch.
 *
 * Known limitation (availability, not integrity): if a dead holder's PID has
 * been recycled by an unrelated process, the liveness probe reads it as alive
 * and recovery stays blocked. Node exposes no portable way to read a foreign
 * PID's start time, so the probe cannot distinguish the recycled PID; the
 * failure is closed rather than unsafe. Lifting it requires an explicit,
 * audited operator supersession authority, not a better liveness guess.
 */
export function acquireRuntimeLease(input: {
  readonly current: RuntimeLease | null;
  readonly runtimeInstanceId: string;
  readonly pid: number;
  readonly now: string;
}): RuntimeLeaseAcquisition {
  const existing = input.current;

  if (!existing) {
    return {
      kind: 'held',
      lease: {
        holderRuntimeInstanceId: input.runtimeInstanceId,
        generation: 1,
        holderPid: input.pid,
        acquiredAt: input.now,
        lastHeartbeatAt: input.now,
      },
    };
  }

  if (existing.holderRuntimeInstanceId === input.runtimeInstanceId) {
    return {
      kind: 'held',
      lease: { ...existing, holderPid: input.pid, lastHeartbeatAt: input.now },
    };
  }

  // Fencing authority: only a provably dead holder ends an epoch. A live PID
  // blocks unconditionally — its host mutation may still be running.
  if (isProcessAlive(existing.holderPid)) {
    return { kind: 'blocked', lease: existing };
  }

  return {
    kind: 'held',
    lease: {
      holderRuntimeInstanceId: input.runtimeInstanceId,
      generation: existing.generation + 1,
      holderPid: input.pid,
      acquiredAt: input.now,
      lastHeartbeatAt: input.now,
    },
  };
}
