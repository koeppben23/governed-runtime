/**
 * @module machine/impl-validation-evidence
 * @description Single canonical authority for post-implementation validation
 * evidence.
 *
 * Problem: the reduced-ceremony decision and the ordinary implementation-review
 * gate must agree on what "all active checks passed against this exact
 * implementation" means. Deriving that rule twice invited drift.
 *
 * Contract:
 * - Evidence for a check is the latest decisive result in `implValidation`
 *   together with the latest implementation-scoped attempt bound to the
 *   CURRENT `implementationId`. Both must be a PASS; an earlier PASS can never
 *   mask a later FAIL.
 * - Attempts recorded before the latest unknown-outcome resolution are stale
 *   and never count.
 * - No active checks is NOT satisfied here: the reduce-ceremony path requires
 *   real coverage. The no-command policy remains the separate authority in
 *   `validation-evidence.ts` and is preserved by the consumers.
 * - Pure over SessionState: no I/O, no policy decisions.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import { latestUnknownOutcomeResolvedAt } from '../state/evidence-mutation-episode.js';

/** One selected check/attempt binding of the current verification cycle. */
export interface ImplValidationBinding {
  readonly checkId: string;
  readonly attemptId: string;
  readonly executedAt: string;
}

/** Result of evaluating post-implementation validation evidence. */
export interface ImplValidationEvidenceDecision {
  readonly activeChecks: readonly string[];
  readonly satisfied: boolean;
  /** Active checks without a latest decisive PASS + bound passing attempt. */
  readonly missing: readonly string[];
  /** Exact basis for each satisfied check, in active-check order. */
  readonly basis: readonly ImplValidationBinding[];
}

function latestBy<T>(items: readonly T[], key: (item: T) => string): T | null {
  let latest: T | null = null;
  for (const item of items) {
    if (latest === null || key(item) >= key(latest)) latest = item;
  }
  return latest;
}

export function evaluateImplValidationEvidence(
  state: SessionState,
): ImplValidationEvidenceDecision {
  const activeChecks = state.activeChecks;
  if (activeChecks.length === 0) {
    return { activeChecks, satisfied: false, missing: [], basis: [] };
  }
  const implementation = state.implementation;
  if (implementation === null) {
    return { activeChecks, satisfied: false, missing: [...activeChecks], basis: [] };
  }

  const resolvedAt = latestUnknownOutcomeResolvedAt(state.mutationEpisodeResolutions);
  const missing: string[] = [];
  const basis: ImplValidationBinding[] = [];

  for (const checkId of activeChecks) {
    const latestResult = latestBy(
      state.implValidation.filter((result) => result.checkId === checkId),
      (result) => result.executedAt,
    );
    const latestAttempt = latestBy(
      state.validationAttempts.filter(
        (attempt) =>
          attempt.scope === 'implementation' &&
          attempt.implementationId === implementation.implementationId &&
          attempt.result.checkId === checkId &&
          (resolvedAt === null || attempt.result.executedAt > resolvedAt),
      ),
      (attempt) => attempt.result.executedAt,
    );

    if (latestResult === null || !latestResult.passed) {
      missing.push(checkId);
      continue;
    }
    if (latestAttempt === null || !latestAttempt.result.passed) {
      missing.push(checkId);
      continue;
    }
    basis.push({
      checkId,
      attemptId: latestAttempt.attemptId,
      executedAt: latestAttempt.result.executedAt,
    });
  }

  return { activeChecks, satisfied: missing.length === 0, missing, basis };
}
