/**
 * @module integration/review/dispatch-signal
 * @description Typed review-dispatch signal carried on FlowGuard tool responses.
 *
 * This module owns the single structured contract that replaced the overloaded
 * textual `next` prefix signal. A response either requires an independent
 * reviewer dispatch (`required: true`) or reports a host-bound completed review
 * (`completed: true` with the bound `verdict`).
 *
 * Parsing is fail-closed: malformed shapes (non-object signals, non-boolean
 * flags, non-string verdicts) are never interpreted as a review signal, so a
 * corrupt response can never satisfy or clear the enforcement gate.
 *
 * @version v1
 */

/** Structured review-dispatch signal attached to a tool response. */
export interface ReviewDispatchSignal {
  /** The response requires an independent reviewer dispatch. */
  readonly required: boolean;
  /** The host-bound independent review completed. */
  readonly completed?: boolean;
  /** The bound reviewer verdict when the review completed. */
  readonly verdict?: string;
}

/** Build the signal that independent reviewer dispatch is required. */
export function reviewDispatchRequired(): ReviewDispatchSignal {
  return { required: true };
}

/** Build the signal that the host-bound independent review completed. */
export function reviewDispatchCompleted(verdict: string): ReviewDispatchSignal {
  return { required: true, completed: true, verdict };
}

/** True for a plain object (never null or an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the review-dispatch signal from a parsed tool response.
 *
 * Fail-closed: returns null for a non-object response, a missing or
 * non-object `reviewDispatch` field, a non-boolean `required`/`completed`,
 * or a non-string `verdict`.
 */
export function readReviewDispatch(value: unknown): ReviewDispatchSignal | null {
  if (!isRecord(value)) return null;
  const raw = value.reviewDispatch;
  if (!isRecord(raw)) return null;
  if (typeof raw.required !== 'boolean') return null;
  if (raw.completed !== undefined && typeof raw.completed !== 'boolean') return null;
  if (raw.verdict !== undefined && typeof raw.verdict !== 'string') return null;
  return {
    required: raw.required,
    ...(raw.completed !== undefined ? { completed: raw.completed } : {}),
    ...(raw.verdict !== undefined ? { verdict: raw.verdict } : {}),
  };
}

/**
 * True when the response requires an independent reviewer dispatch.
 * A completed dispatch is never reported as still-required.
 */
export function isReviewDispatchRequired(value: unknown): boolean {
  const signal = readReviewDispatch(value);
  return signal?.required === true && signal.completed !== true;
}

/** True when the response reports a completed host-bound independent review. */
export function isReviewDispatchCompleted(value: unknown): boolean {
  const signal = readReviewDispatch(value);
  return signal?.required === true && signal.completed === true;
}
