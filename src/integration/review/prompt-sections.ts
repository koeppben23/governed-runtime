/**
 * Mandatory-baseline marker appended as the final line of every reviewer prompt.
 *
 * This declares that the review runs under the canonical 'core' coverage
 * profile — the non-optional baseline whose criteria are owned by
 * src/templates/mandates-reviewer-criteria.ts (REVIEWER_CRITERIA). It adds NO
 * new criteria (no duplicate review authority); it only names the profile and
 * marks it mandatory.
 *
 * Enforcement safety (verified against promptContainsValue in
 * enforcement/extraction.ts): this string MUST NOT contain the tokens
 * "iteration" or "version" followed within 30 non-digit characters by a number,
 * and it is always appended AFTER the attestation/context block so it can never
 * displace the real iteration=/planVersion= tokens the enforcement matcher
 * requires. It is intentionally digit-free.
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

import type { RepositoryDiscoverySnapshot } from '../../state/evidence.js';
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

export function buildStackProfileSection(
  profileName: string | undefined,
  profileRules: string | undefined,
): string {
  if (!profileName && !profileRules) return '';
  const lines: string[] = [];
  if (profileName) {
    lines.push('## Active Stack Profile', '', profileName, '');
  }
  if (profileRules) {
    lines.push('## Stack Review Rules', '', profileRules, '');
  }
  return lines.join('\n');
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
