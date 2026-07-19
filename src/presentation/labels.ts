/**
 * @module presentation/labels
 * @description Status label normalisation — single authority for finish-card and
 *              status-readiness label translation.
 *
 * Maps raw canonical status strings to human-readable presentation labels.
 * This is the ONLY place that normalises these labels. No duplicate tables
 * anywhere in the codebase.
 *
 * Scope: {@link FinishOverallStatus} from status.ts.
 * Other domains (Phase, Evidence-Slot, Archive, Actor Assurance) use their
 * own label functions when needed — they are not normalised here.
 *
 * @version v1
 */

import { PresentationContractError } from './model.js';

// ─── Known Status Inputs ───────────────────────────────────────────────────────

/**
 * Canonical status strings from {@link FinishOverallStatus} in status.ts.
 * Exhaustive union — adding a new status without updating STATUS_LABELS
 * causes a compile error.
 */
export type KnownPresentationStatusInput =
  'BLOCKED' | 'READY_WITH_WARNINGS' | 'CHANGES_REQUIRED' | 'NOT_VERIFIED' | 'IN_PROGRESS' | 'READY';

// ─── Presentation Status ───────────────────────────────────────────────────────

/**
 * Presentation-safe labels derived from the canonical status.
 * These are the only values that may appear in user-facing output for
 * finish-card and status-readiness labelling.
 */
export type PresentationStatus = (typeof STATUS_LABELS)[KnownPresentationStatusInput];

// ─── Label Table ───────────────────────────────────────────────────────────────

/**
 * Canonical label normalisation table.
 *
 * Exhaustive via `satisfies Record<KnownPresentationStatusInput, …>`.
 * Compile error if a new KnownPresentationStatusInput is added without a label.
 */
export const STATUS_LABELS = {
  BLOCKED: 'Blocked',
  READY_WITH_WARNINGS: 'Ready with warnings',
  CHANGES_REQUIRED: 'Changes required',
  NOT_VERIFIED: 'Not verified',
  IN_PROGRESS: 'In progress',
  READY: 'Ready',
} as const satisfies Record<KnownPresentationStatusInput, string>;

Object.freeze(STATUS_LABELS);

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up a known canonical status. Compile-time safe — every valid input
 * has a label.
 */
export function lookupStatusLabel(raw: KnownPresentationStatusInput): PresentationStatus {
  return STATUS_LABELS[raw] as PresentationStatus;
}

/**
 * Parse a dynamic status string.
 * Throws for unknown values because the caller should not fabricate labels
 * for unanticipated statuses.
 */
export function parseStatusLabel(raw: string): PresentationStatus {
  if (raw in STATUS_LABELS) {
    return STATUS_LABELS[raw as KnownPresentationStatusInput] as PresentationStatus;
  }
  throw new PresentationContractError(
    `Unknown status label input: "${raw}". ` +
      `Known values: ${Object.keys(STATUS_LABELS).join(', ')}.`,
  );
}
