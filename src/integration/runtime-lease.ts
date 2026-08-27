/**
 * @module integration/runtime-lease
 * @description Per-session runtime lease with generation fencing.
 *
 * The Recovery Authority contract: at most ONE runtime instance governs a
 * FlowGuard session at any time. The lease is a fencing token — a live
 * holder cannot be superseded by a concurrent instance; a dead or stale
 * holder can only be superseded by a LATER generation. A MutationEpisode
 * binds the generation of its authorizing lease, and an unknown-outcome
 * resolution is only admissible when the resolving instance holds a lease
 * with a LATER generation than the episode's bound generation: the
 * authorizing epoch is provably over.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

export const RuntimeLease = z
  .object({
    schemaVersion: z.literal('runtime-lease.v1'),
    holderRuntimeInstanceId: z.string().uuid(),
    /** Fencing generation — monotonically increasing across supersessions. */
    generation: z.number().int().positive(),
    holderPid: z.number().int().positive(),
    acquiredAt: z.string().datetime(),
    lastHeartbeatAt: z.string().datetime(),
  })
  .strict()
  .readonly();
export type RuntimeLease = z.infer<typeof RuntimeLease>;

export const RUNTIME_LEASE_FILE = 'runtime-lease.json';

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
 * Acquire (or refresh) the runtime lease for this session.
 *
 * Callers MUST hold the session write lock for the session directory so the
 * read-modify-write is serialized against other instances.
 *
 * - No lease: mint generation 1 for the calling instance.
 * - Held by the calling instance: refresh the heartbeat.
 * - Held by another instance: blocked while the holder's PID is alive.
 *   Heartbeat staleness NEVER fences a provably live holder — a live process
 *   may still be executing its host mutation. Only a provably dead holder
 *   (ESRCH) is superseded with a LATER generation, the fencing token that
 *   ends the previous epoch. (PID reuse on a dead holder fails closed: the
 *   reused PID reads as alive and recovery stays blocked — an explicit
 *   recovery authority for hung-but-live holders is out of scope.)
 */
export async function acquireRuntimeLease(input: {
  readonly sessDir: string;
  readonly runtimeInstanceId: string;
  readonly pid: number;
  readonly now: string;
}): Promise<RuntimeLeaseAcquisition> {
  const filePath = path.join(input.sessDir, RUNTIME_LEASE_FILE);

  let existing: RuntimeLease | null = null;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = RuntimeLease.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Unreadable/corrupt lease is not authority — fail closed.
      throw new Error(`Runtime lease file is invalid: ${parsed.error.message}`);
    }
    existing = parsed.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (!existing) {
    const lease: RuntimeLease = {
      schemaVersion: 'runtime-lease.v1',
      holderRuntimeInstanceId: input.runtimeInstanceId,
      generation: 1,
      holderPid: input.pid,
      acquiredAt: input.now,
      lastHeartbeatAt: input.now,
    };
    await writeLease(filePath, lease);
    return { kind: 'held', lease };
  }

  if (existing.holderRuntimeInstanceId === input.runtimeInstanceId) {
    const lease: RuntimeLease = {
      ...existing,
      holderPid: input.pid,
      lastHeartbeatAt: input.now,
    };
    await writeLease(filePath, lease);
    return { kind: 'held', lease };
  }

  // Fencing authority: only a provably dead holder ends an epoch. A live PID
  // blocks unconditionally — its host mutation may still be running.
  if (isProcessAlive(existing.holderPid)) {
    return { kind: 'blocked', lease: existing };
  }

  const lease: RuntimeLease = {
    schemaVersion: 'runtime-lease.v1',
    holderRuntimeInstanceId: input.runtimeInstanceId,
    generation: existing.generation + 1,
    holderPid: input.pid,
    acquiredAt: input.now,
    lastHeartbeatAt: input.now,
  };
  await writeLease(filePath, lease);
  return { kind: 'held', lease };
}

async function writeLease(filePath: string, lease: RuntimeLease): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(lease, null, 2)}\n`, 'utf-8');
}
