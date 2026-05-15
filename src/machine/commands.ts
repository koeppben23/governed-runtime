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
 * - Terminal phases (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) block all commands.
 *
 * @version v3
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
  REVIEW_DECISION: 'review-decision',
  VALIDATE: 'validate',
  REVIEW: 'review',
  ARCHITECTURE: 'architecture',
  ABORT: 'abort',
} as const;
export type Command = (typeof Command)[keyof typeof Command];

// ─── Admissibility ────────────────────────────────────────────────────────────

/** Allowed-in specification: explicit set of phases, or "*" for all phases. */
type AllowedIn = ReadonlySet<Phase> | '*';

/** Command admissibility map. */
const COMMAND_POLICY: ReadonlyMap<Command, AllowedIn> = new Map<Command, AllowedIn>([
  [Command.HYDRATE, '*'],
  [Command.TICKET, new Set<Phase>(['READY', 'TICKET'])],
  [Command.PLAN, new Set<Phase>(['TICKET', 'PLAN'])],
  [Command.CONTINUE, '*'],
  [Command.IMPLEMENT, new Set<Phase>(['IMPLEMENTATION'])],
  [Command.REVIEW_DECISION, new Set<Phase>(['PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW'])],
  [Command.VALIDATE, new Set<Phase>(['VALIDATION'])],
  [Command.REVIEW, new Set<Phase>(['READY'])],
  [Command.ARCHITECTURE, new Set<Phase>(['READY', 'ARCHITECTURE'])],
  [Command.ABORT, '*'],
]);

// ─── Admissibility Check ──────────────────────────────────────────────────────

/**
 * Check if a command is allowed in the given phase.
 *
 * Rules:
 * 1. Terminal phases block ALL FlowGuard commands.
 * 2. Otherwise, check the COMMAND_POLICY map.
 * 3. Unknown commands → false (fail-closed).
 */
export function isCommandAllowed(phase: Phase, command: Command): boolean {
  // Terminal phases block all current FlowGuard commands.
  // If a future read-only command is introduced (e.g., /status as a
  // first-class Command), model it explicitly instead of reintroducing
  // a catch-all placeholder set.
  if (TERMINAL.has(phase)) {
    return false;
  }

  const allowedIn = COMMAND_POLICY.get(command);
  if (allowedIn === undefined) return false;
  if (allowedIn === '*') return true;
  return allowedIn.has(phase);
}
