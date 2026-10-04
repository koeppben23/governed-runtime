/**
 * Mandatory-baseline marker rendered in the trusted runtime context of every
 * reviewer prompt, immediately before the frozen untrusted subject boundary.
 *
 * It must never be placed after `CANONICAL_PROMPT_APPEND_MARKER`: the trusted
 * instruction would otherwise sit inside the untrusted data region.
 *
 * This declares that the review runs under the canonical 'core' coverage
 * profile — the non-optional baseline whose criteria are owned by
 * src/templates/mandates-reviewer-criteria.ts (REVIEWER_CRITERIA). It adds NO
 * new criteria (no duplicate review authority); it only names the profile and
 * marks it mandatory.
 *
 * It is intentionally digit-free so it can never interfere with the canonical
 * `iteration=`/`planVersion=` context tokens.
 */
export const CORE_REVIEW_PROFILE_MARKER =
  'Review coverage profile: core (mandatory baseline; not optional). ' +
  'Apply your full reviewer criteria for this review type as the required floor.';

/**
 * @module integration/review/prompt-sections
 * @description Small pure prompt-section builders shared by the reviewer
 *              prompt transports.
 *
 * Extracted from prompt-builders.ts along the prompt-section boundary to keep
 * both modules within the file-size budget. Pure renderers only: no state
 * access, no I/O.
 *
 * @version v1
 */

import type { RepositoryDiscoverySnapshot } from '../../../state/evidence.js';
import { buildRepositoryDiscoverySnapshotSection } from './discovery-context-prompt.js';

/**
 * Render the review context token (`iteration=.., planVersion=..`) in the
 * single canonical form. Both prompt builders MUST use it so the emitted
 * context is byte-identical and always satisfies enforcement on the first
 * attempt. `planVersion` is optional because standalone /review obligations
 * may not carry one.
 */
export function renderReviewContext(input: {
  iteration: number;
  planVersion?: number | null;
}): string {
  const parts = [`iteration=${input.iteration}`];
  if (input.planVersion != null) {
    parts.push(`planVersion=${input.planVersion}`);
  }
  return parts.join(', ');
}

/**
 * The canonical Discovery section for a reviewer prompt. Decided by the frozen
 * subject SCOPE, never by snapshot presence:
 * - `repository_change` → the attempt-bound repository snapshot envelope
 *   (the mint invariant guarantees the snapshot exists; without one, the
 *   section is structurally absent — never a local-Repository fallback).
 * - anything else (content/artifact/lifecycle) → NO Discovery block and NO
 *   Discovery instruction. Local repository Discovery must not confound
 *   external or inline content subjects.
 */
export function resolveReviewerDiscoverySection(
  scope: 'repository_change' | 'other',
  snapshot: RepositoryDiscoverySnapshot | null | undefined,
): string {
  if (scope !== 'repository_change') return '';
  return snapshot ? buildRepositoryDiscoverySnapshotSection(snapshot) : '';
}
