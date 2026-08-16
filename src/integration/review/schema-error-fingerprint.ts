/**
 * @module integration/review/schema-error-fingerprint
 * @description Canonical fingerprint of a schema-error issue set.
 *
 * Repair DIAGNOSTICS only — never authority. The output-repair gate compares
 * the fingerprint of a targeted repair attempt against its predecessor to
 * detect a repair that reproduced the IDENTICAL error set
 * (`REVIEWER_OUTPUT_REPAIR_STALLED`). The fingerprint is a sha256 over the
 * SORTED canonical issue keys (path + zod code + message), so issue ordering
 * or display cosmetics cannot split a logically identical error set.
 *
 * @version v1
 */

import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';

/** Machine-readable schema issue key (path, zod code, message). */
export interface SchemaIssueKey {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/**
 * Canonical fingerprint of a schema-error issue set: sha256 over the sorted
 * canonical issue keys. Returns null for an empty/absent set — no
 * fingerprint, no stall signal.
 */
export function schemaErrorFingerprintOf(
  issueKeys: readonly SchemaIssueKey[] | undefined,
): string | null {
  if (!issueKeys || issueKeys.length === 0) return null;
  // SET semantics: duplicates collapse before sorting — the fingerprint
  // represents the error set, not the issue sequence.
  const canonical = [
    ...new Set(
      issueKeys.map((key) =>
        canonicalJsonStringify({ path: key.path, code: key.code, message: key.message }),
      ),
    ),
  ].sort();
  return createHash('sha256')
    .update(`[${canonical.join(',')}]`, 'utf-8')
    .digest('hex');
}
