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

export function assuranceSchema() {
  return z.enum(['best_effort', 'claim_validated', 'idp_verified']);
}
