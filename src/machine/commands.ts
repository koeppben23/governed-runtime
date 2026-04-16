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
 * - Terminal phases (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) block all mutating commands.
 *
 * @version v2
 */

import type { Phase } from "../state/schema";

// ─── Command Enum ─────────────────────────────────────────────────────────────

/** All FlowGuard commands (user-facing). */
export const Command = {
  HYDRATE:         "hydrate",
  TICKET:          "ticket",
  PLAN:            "plan",
  CONTINUE:        "continue",
  IMPLEMENT:       "implement",
  REVIEW_DECISION: "review-decision",
  VALIDATE:        "validate",
  REVIEW:          "review",
  ARCHITECTURE:    "architecture",
  ABORT:           "abort",
} as const;
export type Command = (typeof Command)[keyof typeof Command];

// ─── Admissibility ────────────────────────────────────────────────────────────

/** Allowed-in specification: explicit set of phases, or "*" for all phases. */
type AllowedIn = ReadonlySet<Phase> | "*";

/**
 * Command admissibility map.
 *
 * | Command          | Allowed In                                    | Mutating | Notes                                    |
 * |------------------|-----------------------------------------------|----------|------------------------------------------|
 * | /hydrate         | * (all)                                       | Yes      | Bootstrap — creates or loads state       |
 * | /ticket          | READY, TICKET                                 | Yes      | Starts ticket flow or updates ticket     |
 * | /plan            | READY, TICKET, PLAN                           | Yes      | Generates plan + self-review loop        |
 * | /continue        | * (all)                                       | Yes      | Routing — guards decide event            |
 * | /implement       | IMPLEMENTATION                                | Yes      | Executes implementation + review loop    |
 * | /review-decision | PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW     | Yes      | Human verdict at User Gate               |
 * | /validate        | VALIDATION                                    | Yes      | Runs active validation checks            |
 * | /review          | READY                                         | Yes      | Starts review flow                       |
 * | /architecture    | READY, ARCHITECTURE                           | Yes      | Starts or revises architecture flow   |
 * | /abort           | * (all, except terminals)                     | Yes      | Emergency termination                    |
 */
const COMMAND_POLICY: ReadonlyMap<Command, AllowedIn> = new Map<Command, AllowedIn>([
  [Command.HYDRATE,         "*"],
  [Command.TICKET,          new Set<Phase>(["READY", "TICKET"])],
  [Command.PLAN,            new Set<Phase>(["READY", "TICKET", "PLAN"])],
  [Command.CONTINUE,        "*"],
  [Command.IMPLEMENT,       new Set<Phase>(["IMPLEMENTATION"])],
  [Command.REVIEW_DECISION, new Set<Phase>(["PLAN_REVIEW", "EVIDENCE_REVIEW", "ARCH_REVIEW"])],
  [Command.VALIDATE,        new Set<Phase>(["VALIDATION"])],
  [Command.REVIEW,          new Set<Phase>(["READY"])],
  [Command.ARCHITECTURE,    new Set<Phase>(["READY", "ARCHITECTURE"])],
  [Command.ABORT,           "*"],
]);

/** Set of commands that mutate state (all commands are mutating now). */
const MUTATING: ReadonlySet<Command> = new Set<Command>([
  Command.HYDRATE,
  Command.TICKET,
  Command.PLAN,
  Command.CONTINUE,
  Command.IMPLEMENT,
  Command.REVIEW_DECISION,
  Command.VALIDATE,
  Command.REVIEW,
  Command.ARCHITECTURE,
  Command.ABORT,
]);

/** Terminal phases that block all mutating commands. */
const TERMINALS: ReadonlySet<Phase> = new Set<Phase>([
  "COMPLETE",
  "ARCH_COMPLETE",
  "REVIEW_COMPLETE",
]);

// ─── Admissibility Check ──────────────────────────────────────────────────────

/**
 * Check if a command is allowed in the given phase.
 *
 * Rules:
 * 1. Terminal phases block ALL mutating commands.
 * 2. Otherwise, check the COMMAND_POLICY map.
 * 3. Unknown commands → false (fail-closed).
 */
export function isCommandAllowed(phase: Phase, command: Command): boolean {
  // Rule 1: Terminal — only non-mutating commands (none currently)
  if (TERMINALS.has(phase) && MUTATING.has(command)) {
    return false;
  }

  // Rule 2: Check policy
  const allowedIn = COMMAND_POLICY.get(command);
  if (allowedIn === undefined) return false;
  if (allowedIn === "*") return true;
  return allowedIn.has(phase);
}
