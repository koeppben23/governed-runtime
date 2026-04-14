/**
 * @module commands
 * @description Command admissibility — which commands are allowed in which phases.
 *              Static map, pure function, no runtime state dependency.
 *
 *              ~55 lines replace 267 lines of command_policy.yaml.
 *
 * Design:
 * - Commands are user inputs. Events are machine-internal signals.
 * - Command → Rail → State mutation → evaluate() → Event → Transition.
 * - /continue is the routing command (deterministic, guard-determined event).
 * - /review is read-only (always allowed, no mutation, standalone report).
 * - COMPLETE blocks all mutating commands.
 *
 * @version v1
 */

import type { Phase } from "../state/schema";

// ─── Command Enum ─────────────────────────────────────────────────────────────

/** All governance commands (user-facing). */
export const Command = {
  HYDRATE:         "hydrate",
  TICKET:          "ticket",
  PLAN:            "plan",
  CONTINUE:        "continue",
  IMPLEMENT:       "implement",
  REVIEW_DECISION: "review-decision",
  VALIDATE:        "validate",
  REVIEW:          "review",
  ABORT:           "abort",
} as const;
export type Command = (typeof Command)[keyof typeof Command];

// ─── Admissibility ────────────────────────────────────────────────────────────

/** Allowed-in specification: explicit set of phases, or "*" for all phases. */
type AllowedIn = ReadonlySet<Phase> | "*";

/**
 * Command admissibility map.
 *
 * | Command          | Allowed In                          | Mutating | Notes                            |
 * |------------------|-------------------------------------|----------|----------------------------------|
 * | /hydrate         | * (all)                             | Yes      | Bootstrap — creates or loads state. Idempotent. |
 * | /ticket          | TICKET                              | Yes      | Writes TicketEvidence            |
 * | /plan            | TICKET, PLAN                        | Yes      | Writes PlanEvidence + self-review|
 * | /continue        | * (all)                             | Yes      | Routing — guards decide event    |
 * | /implement       | IMPLEMENTATION                      | Yes      | Executes implementation          |
 * | /review-decision | PLAN_REVIEW, EVIDENCE_REVIEW        | Yes      | Human verdict at User Gate       |
 * | /validate        | VALIDATION                          | Yes      | Runs active validation checks    |
 * | /review          | * (all)                             | No       | Read-only report, own artifact   |
 * | /abort           | * (all, except COMPLETE)            | Yes      | Emergency termination            |
 */
const COMMAND_POLICY: ReadonlyMap<Command, AllowedIn> = new Map<Command, AllowedIn>([
  [Command.HYDRATE,         "*"],
  [Command.TICKET,          new Set<Phase>(["TICKET"])],
  [Command.PLAN,            new Set<Phase>(["TICKET", "PLAN"])],
  [Command.CONTINUE,        "*"],
  [Command.IMPLEMENT,       new Set<Phase>(["IMPLEMENTATION"])],
  [Command.REVIEW_DECISION, new Set<Phase>(["PLAN_REVIEW", "EVIDENCE_REVIEW"])],
  [Command.VALIDATE,        new Set<Phase>(["VALIDATION"])],
  [Command.REVIEW,          "*"],
  [Command.ABORT,           "*"],
]);

/** Set of commands that mutate state (all except /review). */
const MUTATING: ReadonlySet<Command> = new Set<Command>([
  Command.HYDRATE,
  Command.TICKET,
  Command.PLAN,
  Command.CONTINUE,
  Command.IMPLEMENT,
  Command.REVIEW_DECISION,
  Command.VALIDATE,
  Command.ABORT,
]);

// ─── Admissibility Check ──────────────────────────────────────────────────────

/**
 * Check if a command is allowed in the given phase.
 *
 * Rules:
 * 1. COMPLETE phase blocks ALL mutating commands (only /review remains).
 * 2. Otherwise, check the COMMAND_POLICY map.
 * 3. Unknown commands → false (fail-closed).
 */
export function isCommandAllowed(phase: Phase, command: Command): boolean {
  // Rule 1: Terminal — only read-only commands
  if (phase === "COMPLETE" && MUTATING.has(command)) {
    return false;
  }

  // Rule 2: Check policy
  const allowedIn = COMMAND_POLICY.get(command);
  if (allowedIn === undefined) return false;
  if (allowedIn === "*") return true;
  return allowedIn.has(phase);
}
