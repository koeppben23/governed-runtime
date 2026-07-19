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

// ─── Archive Labels ────────────────────────────────────────────────────────────

/**
 * Archive lifecycle states — derived from the state domain union,
 * not a manually-duplicated local union.
 * Adding a new state to SessionState['archiveStatus'] causes a
 * compile error here via {@link KnownArchiveStatus}.
 */
export type KnownArchiveStatus = NonNullable<
  import('../state/schema.js').SessionState['archiveStatus']
>;

const ARCHIVE_LABELS = {
  pending: 'Pending',
  created: 'Created',
  verified: 'Verified',
  failed: 'Failed',
} as const satisfies Record<KnownArchiveStatus, string>;

/**
 * Normalise an archive status string to its presentation label.
 * Throws for unknown values.
 */
export function parseArchiveLabel(raw: string): string {
  if (!(raw in ARCHIVE_LABELS)) {
    throw new PresentationContractError(
      `Unknown archive status: ${JSON.stringify(raw)}. ` +
        `Known values: ${Object.keys(ARCHIVE_LABELS).join(', ')}.`,
    );
  }
  return ARCHIVE_LABELS[raw as KnownArchiveStatus];
}

// ─── Guidance Labels ───────────────────────────────────────────────────────────

import type { GuidanceStatus } from './model.js';

/** Presentation labels for guidance status values. */
export const GUIDANCE_STATUS_LABELS: Record<GuidanceStatus, string> = {
  recommended: 'Recommended',
  not_recommended: 'Not recommended',
  not_verified: 'Not verified',
} as const;
