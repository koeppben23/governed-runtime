/**
 * @module runtime-lease
 * @description Canonical persisted shape of the per-session runtime lease.
 *
 * The lease is the fencing authority behind the Recovery Authority contract:
 * at most ONE runtime instance governs a session at a time, and an
 * unknown-outcome resolution is only admissible from a strictly LATER
 * generation than the one that authorized the episode.
 *
 * The lease lives in `SessionState` rather than in a file of its own so that
 * the fencing generation and the `MutationEpisode` that binds it are written
 * in ONE atomic, durable state write under ONE write lock. A separate lease
 * file made the two writes independently failable: a durable episode could
 * end up bound to a generation the lease no longer recorded, which either
 * strands the episode as unresolvable or lets a generation be reissued.
 *
 * The lease carries no `schemaVersion` of its own — `SessionState` is the
 * single version authority for persisted session shape.
 */

import { z } from 'zod';

export const RuntimeLease = z
  .object({
    holderRuntimeInstanceId: z.string().uuid(),
    /** Fencing generation — strictly increasing across supersessions. */
    generation: z.number().int().positive(),
    holderPid: z.number().int().positive(),
    acquiredAt: z.string().datetime(),
    lastHeartbeatAt: z.string().datetime(),
  })
  .strict()
  .readonly();
export type RuntimeLease = z.infer<typeof RuntimeLease>;
