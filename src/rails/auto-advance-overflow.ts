/**
 * @module rails/auto-advance-overflow
 * @description Single mapper from an auto-advance overflow to a fail-closed block.
 *
 * autoAdvance() (rails/types.ts) returns an {@link AutoAdvanceOverflow} when the
 * topology loop exhausts its step budget while still wanting to transition
 * (#428). That outcome carries no state, so callers cannot persist a partially
 * advanced session. Rails surface it as an explicit `AUTO_ADVANCE_OVERFLOW`
 * block via this one mapper — never with eight local `blocked(...)` variants —
 * keeping a single authority for the overflow → block decision.
 *
 * This lives in its own module (not types.ts) so the broadly-imported rail type
 * module does not pull in the reason-registry dependency.
 *
 * @version v1
 */

import type { AutoAdvanceOverflow, RailBlocked } from './types.js';
import { blocked, defaultReasonRegistry } from '../config/reasons.js';

/** Canonical block code for an auto-advance step-limit overflow. */
export const AUTO_ADVANCE_OVERFLOW_CODE = 'AUTO_ADVANCE_OVERFLOW';

/**
 * Map an auto-advance overflow to a fail-closed {@link RailBlocked}.
 *
 * The structured `overflow` context is attached as typed data so the plugin
 * boundary can log `{ phase, limit }` without parsing the human-readable reason.
 */
export function blockedFromOverflow(overflow: AutoAdvanceOverflow): RailBlocked {
  const formatted = blocked(AUTO_ADVANCE_OVERFLOW_CODE, {
    phase: overflow.phase,
    limit: String(overflow.limit),
  });
  return {
    ...formatted,
    overflow: { phase: overflow.phase, limit: overflow.limit },
  };
}

/**
 * Format an auto-advance overflow (#428) as a fail-closed blocked tool result.
 *
 * Used by boundary tools that call autoAdvance directly. MUST be returned
 * BEFORE any state persistence: an overflow carries no advanced state, so the
 * tool must stop completely rather than write a partially-advanced session.
 *
 * Emits a structured `autoAdvanceOverflow: { phase, limit }` field so the
 * plugin boundary can detect and log the overflow without message parsing.
 */
export function formatAutoAdvanceOverflow(overflow: AutoAdvanceOverflow): string {
  const info = defaultReasonRegistry.format(AUTO_ADVANCE_OVERFLOW_CODE, {
    phase: overflow.phase,
    limit: String(overflow.limit),
  });
  return JSON.stringify({
    error: true,
    code: info.code,
    message: info.reason,
    recovery: info.recovery,
    quickFix: info.quickFix,
    autoAdvanceOverflow: { phase: overflow.phase, limit: overflow.limit },
  });
}
