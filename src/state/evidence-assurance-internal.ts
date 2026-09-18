/**
 * @module evidence-assurance-internal
 * @description Private/internal helpers that were NOT part of the original evidence.ts public API.
 *              OpenCodeSessionId is imported by focused evidence-* modules but MUST NOT be
 *              re-exported through the evidence.ts facade.
 *
 * @internal
 * @version v2
 */

import { z } from 'zod';

/** Safe opaque OpenCode session ID segment (e.g. `ses_...`). Internal — not in public API. */
export const OpenCodeSessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
