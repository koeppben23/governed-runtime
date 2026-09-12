/**
 * @module integration/review/prompt-timeout
 * @description Bounded reviewer prompt execution and orphan containment.
 *
 * Extracted from orchestrator.ts to keep the orchestrator within the file-size
 * budget. The timeout resolves to a typed outcome instead of rejecting, so an
 * unresponsive host cannot hang the review loop.
 *
 * @version v1
 */

import type { OrchestratorClient } from './types.js';

export const REVIEWER_PROMPT_TIMEOUT_CODE = 'REVIEWER_PROMPT_TIMEOUT';

/** Generous default so legitimate long reviews are not interrupted. */
export const DEFAULT_REVIEWER_PROMPT_TIMEOUT_MS = 30 * 60_000;

export type TimeoutRaceResult<T> = { kind: 'completed'; value: T } | { kind: 'timed_out' };

/**
 * Bound an in-flight reviewer prompt. `0` or a non-finite timeout disables the
 * bound and awaits the operation directly.
 */
export async function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<TimeoutRaceResult<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { kind: 'completed', value: await operation };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<TimeoutRaceResult<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timed_out' }), timeoutMs);
      timer.unref?.();
    });
    const completed = operation.then((value): TimeoutRaceResult<T> => ({
      kind: 'completed',
      value,
    }));
    return await Promise.race([completed, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Best-effort abort of a timed-out reviewer child to contain orphans. */
export async function abortReviewerSession(
  client: OrchestratorClient,
  sessionId: string,
): Promise<void> {
  if (!client.session.abort) return;
  try {
    await client.session.abort({ path: { id: sessionId } });
  } catch {
    // Best-effort: the timeout classification already fails the attempt closed.
  }
}
