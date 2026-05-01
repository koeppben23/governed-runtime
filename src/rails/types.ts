/**
 * @module types
 * @description Common types and helpers shared by all rail orchestrators.
 *
 * Design:
 * - Rails are thin orchestrators: validate → work → mutate state → evaluate → return.
 * - Rails do NOT persist state or emit audit events — that's the adapter's job.
 * - Rails receive state and return new state. Pure state transformation.
 * - Side effects (LLM calls, validation checks) are injected via executor interfaces.
 * - autoAdvance() collects all intermediate transitions for audit trail.
 *
 * @version v1
 */

import type { SessionState, Phase, Event } from '../state/schema.js';
import type { LoopVerdict, RevisionDelta, SelfReviewLoop } from '../state/evidence.js';
import { evaluate } from '../machine/evaluate.js';
import type { EvalResult } from '../machine/evaluate.js';
import type { FlowGuardPolicy } from '../config/policy.js';

// ─── Transition Record ────────────────────────────────────────────────────────

/**
 * A recorded state transition from autoAdvance().
 * These are collected for audit: every phase change must be traceable
 * in regulated environments, even when multiple transitions happen
 * within a single tool call.
 */
export interface TransitionRecord {
  readonly from: Phase;
  readonly to: Phase;
  readonly event: Event;
  readonly at: string;
}

/** Return type for autoAdvance(). */
export interface AutoAdvanceResult {
  /** Final session state after all transitions. */
  readonly state: SessionState;
  /** Evaluation result at the final phase. */
  readonly evalResult: EvalResult;
  /**
   * All transitions that occurred during auto-advance (in order).
   * Empty if no transitions happened (eval returned non-transition immediately).
   * For audit: one audit event per entry.
   */
  readonly transitions: readonly TransitionRecord[];
}

// ─── Rail Result ──────────────────────────────────────────────────────────────

/** Rail succeeded — state was mutated, evaluation was performed. */
export interface RailOk {
  readonly kind: 'ok';
  /** The new session state (caller MUST persist atomically). */
  readonly state: SessionState;
  /** The evaluation result at the final phase. */
  readonly evalResult: EvalResult;
  /**
   * All transitions that occurred during this rail execution (in order).
   * Empty array if no transitions happened (e.g., idempotent reload).
   * The audit plugin reads this to emit per-transition audit events.
   */
  readonly transitions: readonly TransitionRecord[];
}

/** Rail was blocked — precondition failed, state is UNCHANGED. */
export interface RailBlocked {
  readonly kind: 'blocked';
  /** Machine-readable block code (e.g., "COMMAND_NOT_ALLOWED", "TICKET_REQUIRED"). */
  readonly code: string;
  /** Human-readable explanation. */
  readonly reason: string;
  /** Ordered recovery steps for the user (from reason registry). */
  readonly recovery?: readonly string[];
  /** Optional command that fixes the issue (from reason registry). */
  readonly quickFix?: string;
}

/** Union of all rail outcomes. */
export type RailResult = RailOk | RailBlocked;

// ─── Rail Context ─────────────────────────────────────────────────────────────

/**
 * Utilities injected into every rail.
 * These are pure helpers — no business logic, no persistence.
 */
export interface RailContext {
  /** Current ISO-8601 timestamp. Injected for deterministic testing. */
  now: () => string;
  /** SHA-256 hex digest of a string. */
  digest: (text: string) => string;
  /**
   * FlowGuard policy for this session.
   * Undefined → TEAM_POLICY behavior (safe default).
   * Set by the tool layer after resolving from state.policySnapshot or config.
   */
  policy?: FlowGuardPolicy;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Default max review iterations (TEAM_POLICY behavior).
 * Used when no policy is provided (safe default: 3 iterations for deep convergence).
 * SOLO overrides to 1 via policy. REGULATED uses 3 (same as default).
 */
export const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

/**
 * Maximum auto-advance steps before forced stop.
 * Paranoia guard against infinite loops in misconfigured topology.
 */
const MAX_AUTO_ADVANCE_STEPS = 10;

/**
 * Create a policy-aware evaluation closure.
 * Eliminates the repeated `const evalFn = (s: SessionState) => evaluate(s, ctx.policy)` pattern.
 */
export function createPolicyEvalFn(ctx: RailContext): (state: SessionState) => EvalResult {
  return (s: SessionState) => evaluate(s, ctx.policy);
}

/**
 * Build a READY → target flow-selection pre-transition.
 *
 * Used by /ticket and /architecture to record the implicit
 * flow-selection step when issued from READY state.
 *
 * @returns The TransitionRecord and the new baseTransition for state.
 */
export function buildFlowSelectionTransition(
  targetPhase: Phase,
  event: Event,
  at: string,
): TransitionRecord {
  return { from: 'READY', to: targetPhase, event, at };
}

/**
 * Apply a transition to state. Returns a new state object (no mutation).
 * Sets phase, records transition, clears error (successful transition = no error).
 */
export function applyTransition(
  state: SessionState,
  from: Phase,
  to: Phase,
  event: Event,
  at: string,
): SessionState {
  return {
    ...state,
    phase: to,
    transition: { from, to, event, at },
    error: null,
  };
}

/**
 * Auto-advance loop: keeps evaluating and transitioning until the machine stops.
 * Stops when: terminal, waiting (user gate), pending (needs work), or max steps reached.
 *
 * This is used by rails that can chain through multiple phases
 * (e.g., /plan at TICKET → PLAN → PLAN_REVIEW in one call).
 *
 * Max steps = 10 (paranoia guard against infinite loops in misconfigured topology).
 *
 * Returns all intermediate transitions as a TransitionRecord array.
 * This is critical for audit: every state transition must be traceable,
 * even when multiple transitions occur within a single tool call.
 */
export function autoAdvance(
  state: SessionState,
  evalFn: (s: SessionState) => EvalResult,
  ctx: RailContext,
): AutoAdvanceResult {
  const transitions: TransitionRecord[] = [];
  let current = state;
  let result = evalFn(current);

  for (let step = 0; step < MAX_AUTO_ADVANCE_STEPS && result.kind === 'transition'; step++) {
    // Self-loop guard: if the transition targets the same phase, the state
    // won't change from the guards' perspective → stop to avoid pointless cycles.
    // Example: PLAN + SELF_REVIEW_PENDING → PLAN (waiting for LLM review).
    if (result.target === current.phase) break;

    const at = ctx.now();
    const from = current.phase;
    const to = result.target;
    const event = result.event;

    // Record transition for audit trail
    transitions.push({ from, to, event, at });

    current = applyTransition(current, from, to, event, at);
    result = evalFn(current);
  }

  return { state: current, evalResult: result, transitions };
}

// ─── Convergence Loop ─────────────────────────────────────────────────────────

/**
 * Result of a single convergence iteration.
 * Returned by the iterate callback passed to runConvergenceLoop / runSingleIteration.
 */
export interface IterationResult<T> {
  readonly verdict: LoopVerdict;
  readonly updated?: T;
}

/**
 * Result of a converged convergence iteration.
 *
 * Returned when the loop reached a terminal state via either:
 *   - digest-stop (revisionDelta === "none" AND verdict === "approve"), or
 *   - force-convergence (iteration >= maxIterations) with a non-blocking
 *     verdict (i.e. NOT 'unable_to_review').
 *
 * Fields map directly to SelfReviewLoop / ImplReviewResult schemas
 * (caller adds executedAt for ImplReviewResult).
 */
export interface ConvergedResult<T> {
  readonly kind: 'converged';
  readonly artifact: T;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly prevDigest: string | null;
  readonly currDigest: string;
  readonly revisionDelta: RevisionDelta;
  readonly verdict: LoopVerdict;
}

/**
 * Result of a convergence iteration that the reviewer subagent declared
 * unreviewable (overallVerdict='unable_to_review', P1.3 slice 1).
 *
 * The loop did NOT converge. The runtime MUST route to BLOCKED and
 * surface SUBAGENT_UNABLE_TO_REVIEW (slice 2) to the caller. The caller
 * MUST NOT extract `artifact` and proceed as if the loop succeeded —
 * there is intentionally no `artifact` field on this variant to make
 * misuse a TypeScript error rather than a runtime fabrication.
 *
 * Diagnostics:
 *   - obligationId: identifies the consumed review obligation (slice 5).
 *   - reason: free-form diagnostic from the reviewer findings (e.g.,
 *     missingVerification[] joined or a representative cause).
 *   - findings: the full ReviewFindings object from the reviewer, for
 *     audit and for the orchestrator to embed in strictBlockedOutput
 *     (slice 4c). Optional because not all callers persist it.
 *
 * The `iteration` and `maxIterations` fields are preserved so that
 * audit-log consumers can record at which iteration the BLOCKED
 * occurred without losing context.
 */
export interface BlockedResult<_T> {
  readonly kind: 'blocked';
  readonly code: 'SUBAGENT_UNABLE_TO_REVIEW';
  readonly iteration: number;
  readonly maxIterations: number;
  readonly verdict: 'unable_to_review';
  readonly obligationId?: string;
  readonly reason?: string;
  readonly findings?: unknown;
  /**
   * Phantom field — preserves _T for caller type-narrowing without
   * exposing an actual artifact. Do NOT read this; if you need the
   * artifact, the loop did not converge and you have a bug.
   *
   * The `_T` generic parameter is intentionally unused at the value level
   * (eslint underscore convention). It exists so that the discriminated
   * union ConvergenceResult<T> can preserve the artifact type information
   * across both branches, which prevents accidental loss of the generic
   * when callers narrow into `BlockedResult<unknown>` by mistake.
   */
  readonly _artifactType?: never;
}

/**
 * Result of a convergence loop (full or single-step).
 *
 * Discriminated union introduced in P1.3 slice 4b. Callers MUST narrow
 * on `result.kind` before reading `artifact` — TypeScript will refuse
 * to access `artifact` on the `BlockedResult<T>` branch.
 *
 * Migration note: prior to slice 4b this was a single-shape interface.
 * All call sites in src/rails/{plan,implement,continue,architecture}.ts
 * have been updated to narrow on `result.kind` and route BLOCKED to
 * the rails' RailBlocked path via blocked('SUBAGENT_UNABLE_TO_REVIEW').
 */
export type ConvergenceResult<T> = ConvergedResult<T> | BlockedResult<T>;

/**
 * Process one iteration result: compute revision delta and resolve artifact.
 * Shared primitive for both full loops and single-step continues.
 */
function processIteration<T extends { readonly digest: string }>(
  current: T,
  result: IterationResult<T>,
): { readonly artifact: T; readonly revisionDelta: RevisionDelta } {
  if (result.verdict === 'changes_requested' && result.updated) {
    const delta: RevisionDelta = result.updated.digest === current.digest ? 'none' : 'minor';
    return { artifact: result.updated, revisionDelta: delta };
  }
  return { artifact: current, revisionDelta: 'none' };
}

/**
 * Generic convergence loop with digest-stop.
 *
 * Iterates until:
 * - verdict === "approve" AND revisionDelta === "none" (converged), OR
 * - iteration >= maxIterations (force-stopped), OR
 * - verdict === "unable_to_review" (BLOCKED — P1.3 slice 4b).
 *
 * The third exit is a tool-failure signal from the reviewer subagent.
 * It returns a BlockedResult<T> with kind='blocked' and no artifact.
 * The caller (rails/{plan,implement}.ts) narrows on result.kind and
 * routes to the rails' RailBlocked path. See src/machine/guards.ts:55
 * (isConverged) for the corresponding state-machine-level gate.
 *
 * Used by /plan (self-review loop) and /implement (impl review loop).
 */
export async function runConvergenceLoop<T extends { readonly digest: string }>(
  initial: T,
  maxIterations: number,
  iterate: (current: T, iteration: number) => Promise<IterationResult<T>>,
): Promise<ConvergenceResult<T>> {
  let current = initial;
  let prevDigest: string | null = null;
  let revisionDelta: RevisionDelta = 'major';
  let verdict: LoopVerdict = 'changes_requested';
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    const result = await iterate(current, iteration);
    verdict = result.verdict;
    prevDigest = current.digest;

    // P1.3 slice 4b: tool-failure verdict short-circuits the loop and
    // returns a BlockedResult. No artifact resolution, no digest update.
    if (verdict === 'unable_to_review') {
      return {
        kind: 'blocked',
        code: 'SUBAGENT_UNABLE_TO_REVIEW',
        iteration,
        maxIterations,
        verdict,
      };
    }

    const processed = processIteration(current, result);
    revisionDelta = processed.revisionDelta;
    current = processed.artifact;

    if (revisionDelta === 'none' && verdict === 'approve') break;
  }

  return {
    kind: 'converged',
    artifact: current,
    iteration,
    maxIterations,
    prevDigest,
    currDigest: current.digest,
    revisionDelta,
    verdict,
  };
}

/**
 * Run exactly one convergence iteration from a given starting point.
 *
 * Used by /continue for incremental self-review and impl-review.
 * If startIteration >= maxIterations, returns immediately (no iteration runs).
 */
export async function runSingleIteration<T extends { readonly digest: string }>(
  current: T,
  startIteration: number,
  maxIterations: number,
  iterate: (artifact: T, iteration: number) => Promise<IterationResult<T>>,
): Promise<ConvergenceResult<T>> {
  // Already at max — no iteration runs
  if (startIteration >= maxIterations) {
    return {
      kind: 'converged',
      artifact: current,
      iteration: startIteration,
      maxIterations,
      prevDigest: null,
      currDigest: current.digest,
      revisionDelta: 'none',
      verdict: 'approve',
    };
  }

  const nextIteration = startIteration + 1;
  const result = await iterate(current, nextIteration);
  const prevDigest = current.digest;

  // P1.3 slice 4b: tool-failure verdict short-circuits the iteration
  // and returns a BlockedResult. No artifact resolution.
  if (result.verdict === 'unable_to_review') {
    return {
      kind: 'blocked',
      code: 'SUBAGENT_UNABLE_TO_REVIEW',
      iteration: nextIteration,
      maxIterations,
      verdict: 'unable_to_review',
    };
  }

  const processed = processIteration(current, result);

  return {
    kind: 'converged',
    artifact: processed.artifact,
    iteration: nextIteration,
    maxIterations,
    prevDigest,
    currDigest: processed.artifact.digest,
    revisionDelta: processed.revisionDelta,
    verdict: result.verdict,
  };
}

// ─── Loop State Builders ──────────────────────────────────────────────────────

/**
 * Build a self-review loop state object from a SelfReviewLoop result.
 *
 * Eliminates the duplicated 6-field object literal pattern that appears
 * identically at 4 call sites in continue.ts and plan.ts.
 */
export function buildSelfReviewState(loop: SelfReviewLoop) {
  return {
    iteration: loop.iteration,
    maxIterations: loop.maxIterations,
    prevDigest: loop.prevDigest,
    currDigest: loop.currDigest,
    revisionDelta: loop.revisionDelta,
    verdict: loop.verdict,
  };
}

/**
 * Build an implementation review loop state object from a SelfReviewLoop result.
 *
 * Extends buildSelfReviewState with the mandatory executedAt timestamp.
 */
export function buildImplReviewState(loop: SelfReviewLoop, executedAt: string) {
  return {
    ...buildSelfReviewState(loop),
    executedAt,
  };
}
