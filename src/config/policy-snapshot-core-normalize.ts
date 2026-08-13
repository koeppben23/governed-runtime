/**
 * @module config/policy-snapshot-core-normalize
 * @description Core-field normalization for incomplete/legacy policy snapshots.
 *
 * Extracted from policy-snapshot-normalize.ts along the core-fields boundary
 * to keep both modules under the file-size budget. The canonical return type
 * of `modeConsistentDefaults` lives in policy-snapshot-normalize.ts; this
 * module narrows it to the structural `CoreDefaults` slice it consumes, so
 * there is no import edge back to the parent module (the architecture cycle
 * rule treats even type-only edges as cycles).
 *
 * @version v1
 */

/** Structural slice of `modeConsistentDefaults` consumed by core-field normalization. */
export interface CoreDefaults {
  readonly requireHumanGates: boolean;
  readonly maxSelfReviewIterations: number;
  readonly maxImplReviewIterations: number;
  readonly maxIncoherentReviewerCaptureRetries: number;
  readonly maxReviewerOutputRepairAttempts: number;
  readonly allowSelfApproval: boolean;
}

/** Normalize a non-negative integer policy value or fall back to the default. */
function normalizeNonNegativeInt(
  raw: unknown,
  fallback: number,
): { readonly value: number; readonly normalized: boolean } {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return { value: raw, normalized: false };
  }
  return { value: fallback, normalized: true };
}

export function normalizeCoreFields(
  s: Record<string, unknown>,
  defaults: CoreDefaults,
): {
  requireHumanGates: boolean;
  maxSelfReviewIterations: number;
  maxImplReviewIterations: number;
  maxIncoherentReviewerCaptureRetries: number;
  maxReviewerOutputRepairAttempts: number;
  allowSelfApproval: boolean;
  normalized: boolean;
} {
  let norm = false;

  const rawHuman = s.requireHumanGates;
  const requireHumanGates = typeof rawHuman === 'boolean' ? rawHuman : defaults.requireHumanGates;
  if (typeof rawHuman !== 'boolean') norm = true;

  const rawMaxSelf = s.maxSelfReviewIterations;
  const maxSelfReviewIterations =
    typeof rawMaxSelf === 'number' ? rawMaxSelf : defaults.maxSelfReviewIterations;
  if (typeof rawMaxSelf !== 'number') norm = true;

  const rawMaxImpl = s.maxImplReviewIterations;
  const maxImplReviewIterations =
    typeof rawMaxImpl === 'number' ? rawMaxImpl : defaults.maxImplReviewIterations;
  if (typeof rawMaxImpl !== 'number') norm = true;

  const rawApprove = s.allowSelfApproval;
  const allowSelfApproval =
    typeof rawApprove === 'boolean' ? rawApprove : defaults.allowSelfApproval;
  if (typeof rawApprove !== 'boolean') norm = true;

  const captureResolved = normalizeNonNegativeInt(
    s.maxIncoherentReviewerCaptureRetries,
    defaults.maxIncoherentReviewerCaptureRetries,
  );
  if (captureResolved.normalized) norm = true;

  const repairResolved = normalizeNonNegativeInt(
    s.maxReviewerOutputRepairAttempts,
    defaults.maxReviewerOutputRepairAttempts,
  );
  if (repairResolved.normalized) norm = true;

  return {
    requireHumanGates,
    maxSelfReviewIterations,
    maxImplReviewIterations,
    maxIncoherentReviewerCaptureRetries: captureResolved.value,
    maxReviewerOutputRepairAttempts: repairResolved.value,
    allowSelfApproval,
    normalized: norm,
  };
}
