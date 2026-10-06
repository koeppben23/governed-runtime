/**
 * @module commands
 * @description Command admissibility — which commands are allowed in which phases.
 *              Static map, pure function, no runtime state dependency.
 *
 * Design:
 * - Commands are user inputs. Events are machine-internal signals.
 * - Command → Rail → State mutation → evaluate() → Event → Transition.
 * - /continue is the routing command (deterministic, guard-determined event).
 * - READY is the entry phase where users select a flow (/ticket, /architecture, /review).
 * - The policy map is the single authority for terminal handling: flow commands
 *   are explicit non-terminal sets, `/continue` is `'non-terminal'`, and the
 *   recovery escapes are `'all-phases'`:
 *   - `/abort` is a strict idempotent no-op on terminal phases
 *     (rails/abort.ts, #421).
 *   - `/hydrate` is the bootstrap/reload/recovery entrypoint; it performs no
 *     terminal transition, and its explicit `claimedTaskClass` recovery remains
 *     subject to the separately tracked G22 surface.
 *
 * @version v4
 */

import type { Phase } from '../state/schema.js';
import { TERMINAL } from './topology.js';

// ─── Command Enum ─────────────────────────────────────────────────────────────

/** All FlowGuard commands (user-facing). */
export const Command = {
  HYDRATE: 'hydrate',
  TICKET: 'ticket',
  PLAN: 'plan',
  CONTINUE: 'continue',
  IMPLEMENT: 'implement',
  RESOLVE_IMPLEMENTATION_CHALLENGE: 'resolve-implementation-challenge',
  REVIEW_DECISION: 'review-decision',
  OVERRIDE_APPROVE: 'override-approve',
  VALIDATE: 'validate',
  REVIEW: 'review',
  ARCHITECTURE: 'architecture',
  EXPORT: 'export',
  ABORT: 'abort',
} as const;
export type Command = (typeof Command)[keyof typeof Command];

// ─── Admissibility ────────────────────────────────────────────────────────────

/**
 * Allowed-in specification:
 * - explicit set of phases,
 * - `'all-phases'` for recovery escapes that are valid everywhere (idempotent
 *   no-ops on terminal phases),
 * - `'non-terminal'` for routing commands that require a live session.
 */
type AllowedIn = ReadonlySet<Phase> | 'all-phases' | 'non-terminal';

/** Command admissibility map — the single authority for terminal handling. */
const COMMAND_POLICY: ReadonlyMap<Command, AllowedIn> = new Map<Command, AllowedIn>([
  [Command.HYDRATE, 'all-phases'],
  [Command.TICKET, new Set<Phase>(['READY', 'TICKET'])],
  [Command.PLAN, new Set<Phase>(['TICKET', 'PLAN'])],
  [Command.CONTINUE, 'non-terminal'],
  [Command.IMPLEMENT, new Set<Phase>(['IMPLEMENTATION'])],
  [Command.RESOLVE_IMPLEMENTATION_CHALLENGE, new Set<Phase>(['IMPL_REVIEW'])],
  [Command.REVIEW_DECISION, new Set<Phase>(['PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW'])],
  [Command.OVERRIDE_APPROVE, new Set<Phase>(['PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW'])],
  [Command.VALIDATE, new Set<Phase>(['VALIDATION', 'IMPL_VALIDATION'])],
  [Command.REVIEW, new Set<Phase>(['READY'])],
  [Command.ARCHITECTURE, new Set<Phase>(['READY', 'ARCHITECTURE'])],
  [Command.EXPORT, new Set<Phase>(['EXPORT_READY'])],
  [Command.ABORT, 'all-phases'],
]);

// ─── Admissibility Check ──────────────────────────────────────────────────────

/**
 * Check if a command is allowed in the given phase.
 *
 * Rules:
 * 1. The policy map is authoritative; terminal handling is expressed there
 *    (`'non-terminal'` and explicit sets exclude terminal phases, while
 *    `'all-phases'` recovery escapes remain available).
 * 2. Unknown commands → false (fail-closed).
 */
export function isCommandAllowed(phase: Phase, command: Command): boolean {
  const allowedIn = COMMAND_POLICY.get(command);
  if (allowedIn === undefined) return false;
  if (allowedIn === 'all-phases') return true;
  if (allowedIn === 'non-terminal') return !TERMINAL.has(phase);
  return allowedIn.has(phase);
}
