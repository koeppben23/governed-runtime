/**
 * @module persistence-lock-owner
 * @description Owner identity and staleness classification for FlowGuard write locks.
 *
 * A PID alone is not an owner identity. PIDs are unique only while the process
 * lives; after a crash the operating system reuses them, so a stale lockfile can
 * name a live, unrelated process and block every writer of that session forever.
 *
 * The record therefore carries two independent facts that let a reclaimer prove
 * the recorded owner cannot still be running:
 *
 * - `boot`: wall-clock estimate of the current boot (`Date.now() - os.uptime()`).
 *   A lock written under a different boot can never be held by a live process,
 *   regardless of PID reuse.
 * - `start`: the owner's start identity as exposed by the platform
 *   (`/proc/<pid>/stat` field 22 on Linux). A live PID whose start identity
 *   differs belongs to a different process.
 *
 * Both facts are optional in the on-disk record. A record without them can only
 * be classified as alive/unknown: the boundary never derives staleness from
 * missing data, and an unknown owner is always treated as alive.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';

/** Current on-disk owner record format. */
const LOCK_OWNER_FORMAT = 'flowguard-lock-owner.v1' as const;

/** Boot references drift by clock-adjustment and uptime granularity. */
const BOOT_REF_TOLERANCE_MS = 60_000;

export interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly host: string | null;
  /** Wall-clock estimate of the owner's boot, when the writer recorded one. */
  readonly bootRefMs: number | null;
  /** Platform start identity of the owner process, when recorded and derivable. */
  readonly startIdentity: string | null;
}

/** Result of asking whether a recorded owner can still be running. */
export type OwnerLiveness =
  | { readonly verdict: 'alive'; readonly reason: string }
  | { readonly verdict: 'stale'; readonly reason: string };

export interface LivenessProbe {
  readonly host: string;
  readonly bootRefMs: number;
  isProcessAlive(pid: number): boolean;
  /** Platform start identity for a live PID, or null when not derivable. */
  processStartIdentity(pid: number): Promise<string | null>;
}

/** Wall-clock estimate (ms) of this boot, stable within the tolerance above. */
export function bootRefMs(now: number = Date.now()): number {
  return now - Math.round(os.uptime() * 1000);
}

/** Whether two boot references describe the same boot. */
function isSameBoot(recorded: number, current: number): boolean {
  return Math.abs(recorded - current) <= BOOT_REF_TOLERANCE_MS;
}

const PID_LINE = /^pid=(\d+)$/m;
const TOKEN_LINE = /^token=(.+)$/m;
const HOST_LINE = /^host=(.*)$/m;
const BOOT_LINE = /^boot=(\d+)$/m;
const START_LINE = /^start=(.+)$/m;

/**
 * Parse a lock record. Returns null when the record does not carry the two
 * fields that have always defined a lock identity (`pid` and `token`); such a
 * record is unreadable and must be treated as alive by every caller.
 */
export function parseLockOwner(raw: string): LockOwner | null {
  const pidMatch = PID_LINE.exec(raw);
  const tokenMatch = TOKEN_LINE.exec(raw);
  if (!pidMatch || !tokenMatch) return null;
  const pid = Number(pidMatch[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const bootMatch = BOOT_LINE.exec(raw);
  const bootValue = bootMatch ? Number(bootMatch[1]) : Number.NaN;
  const startMatch = START_LINE.exec(raw);
  const hostMatch = HOST_LINE.exec(raw);
  return {
    token: tokenMatch[1] ?? '',
    pid,
    host: hostMatch ? (hostMatch[1] ?? '') : null,
    bootRefMs: Number.isFinite(bootValue) ? bootValue : null,
    startIdentity: startMatch ? (startMatch[1] ?? null) : null,
  };
}

/** Serialize a lock record. `pid` and `token` stay the first two lines. */
export function formatLockOwner(owner: LockOwner): string {
  const lines = [`pid=${owner.pid}`, `token=${owner.token}`, `format=${LOCK_OWNER_FORMAT}`];
  if (owner.host !== null) lines.push(`host=${owner.host}`);
  if (owner.bootRefMs !== null) lines.push(`boot=${owner.bootRefMs}`);
  if (owner.startIdentity !== null) lines.push(`start=${owner.startIdentity}`);
  return `${lines.join('\n')}\n`;
}

/** Default liveness probe backed by the running process and the platform. */
export function defaultLivenessProbe(): LivenessProbe {
  return {
    host: os.hostname(),
    bootRefMs: bootRefMs(),
    isProcessAlive: isProcessAlive,
    processStartIdentity: readProcessStartIdentity,
  };
}

/**
 * `process.kill(pid, 0)` liveness. Only `ESRCH` proves the process is gone;
 * `EPERM` and every unknown error keep the fail-closed "alive" classification.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

/**
 * Read `/proc/<pid>/stat` field 22 (starttime in clock ticks since boot).
 *
 * The `comm` field may contain spaces and parentheses, so parsing starts after
 * the LAST `)`. Fields after the command are 1-based from field 3; `starttime`
 * is field 22, therefore index 19 of the post-`)` split. Returns null when the
 * platform has no `/proc` or the process disappeared mid-read.
 */
export async function readProcessStartIdentity(pid: number): Promise<string | null> {
  let stat: string;
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const starttime = fields[19];
  if (starttime === undefined || !/^\d+$/.test(starttime)) return null;
  return `proc-starttime:${starttime}`;
}

/**
 * Classify a recorded owner.
 *
 * Order matters: boot mismatch, then PID death, then start identity. Every
 * branch that cannot positively prove the owner gone returns `alive`.
 */
export async function classifyLockOwner(
  owner: LockOwner,
  probe: LivenessProbe,
): Promise<OwnerLiveness> {
  if (owner.host !== null && owner.host !== probe.host) {
    return {
      verdict: 'alive',
      reason: `lock is owned by host "${owner.host}", which cannot be verified from "${probe.host}"`,
    };
  }
  if (owner.bootRefMs !== null && !isSameBoot(owner.bootRefMs, probe.bootRefMs)) {
    return { verdict: 'stale', reason: 'lock was written during a previous boot' };
  }
  if (!probe.isProcessAlive(owner.pid)) {
    return { verdict: 'stale', reason: 'owning process is not running' };
  }
  if (owner.startIdentity !== null) {
    const current = await probe.processStartIdentity(owner.pid);
    if (current === null) {
      return {
        verdict: 'alive',
        reason: 'owning PID is alive but its start identity cannot be derived',
      };
    }
    if (current !== owner.startIdentity) {
      return { verdict: 'stale', reason: 'owning PID was reused by a different process' };
    }
  }
  return { verdict: 'alive', reason: 'owning process is running' };
}
