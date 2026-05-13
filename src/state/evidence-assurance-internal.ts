/**
 * @module evidence-assurance-internal
 * @description Private/internal helpers that were NOT part of the original evidence.ts public API.
 *              These are imported by focused evidence-* modules but MUST NOT be re-exported
 *              through the evidence.ts facade.
 *
 * @internal
 * @version v1
 */

import { z } from 'zod';

/** Safe opaque OpenCode session ID segment (e.g. `ses_...`). Internal — not in public API. */
export const OpenCodeSessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * P34: Coerce P33 v0 'verified' to 'claim_validated'.
 * Any unknown value falls through to 'best_effort' (safe default for backward compat).
 * Internal — not in public API.
 */
export function coerceAssurance(raw: unknown): 'best_effort' | 'claim_validated' | 'idp_verified' {
  if (raw === 'verified' || raw === 'claim_validated' || raw === 'idp_verified') {
    if (raw === 'verified') return 'claim_validated';
    return raw as 'claim_validated' | 'idp_verified';
  }
  return 'best_effort';
}

/**
 * Assurance value parser with P33 v0 backward compat.
 * "verified" passes through the union and is coerced to "claim_validated".
 * Unknown values fall back to "best_effort".
 * Internal — not in public API.
 */
export function assuranceSchema() {
  return z
    .union([
      z.literal('verified'),
      z.literal('best_effort'),
      z.literal('claim_validated'),
      z.literal('idp_verified'),
    ])
    .transform((val) => coerceAssurance(val));
}
