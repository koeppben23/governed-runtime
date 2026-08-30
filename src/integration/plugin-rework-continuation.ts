/**
 * @module integration/plugin-rework-continuation
 * @description Command-scope-local latch and gate that keep the /check
 *              repair-recheck loop autonomous across re-records.
 *
 * The persisted `implementationRework` marker is RETAINED across re-records and
 * a failing fresh revalidation (so restoring an earlier rejected revision stays
 * blocked) and is closed only when the fresh validation FULLY passes and the
 * machine advances to IMPL_REVIEW. The latch flips on when a /check
 * session's committed state shows an ACTIVE non-exhausted rework marker (the
 * reviewer's changes_requested verdict) and stays set while the loop is inside
 * IMPLEMENTATION / IMPL_VALIDATION / IMPL_REVIEW. It is dropped once the loop
 * reaches a terminal phase (accept → EVIDENCE_REVIEW/PLAN_REVIEW).
 *
 * Diagnostic only: if the committed state cannot be read the latch is left
 * unchanged — the marker-based entry path still covers the first repair and the
 * gate denies without the latch or marker.
 *
 * The marker and the latch are complementary: the marker carries the rejected
 * digest (blocking restoration of that exact revision), the latch carries the
 * "this /check already entered the loop" provenance across the marker's close.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import { readState } from '../adapters/persistence.js';
import { isMutatingHostTool } from './phase-tool-gate.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_RUN_CHECK,
} from './tool-names.js';

export function isReviewableFlowGuardTool(toolName: string): boolean {
  // Stryker disable next-line ConditionalExpression
  return [
    TOOL_FLOWGUARD_PLAN,
    TOOL_FLOWGUARD_IMPLEMENT,
    TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
    TOOL_FLOWGUARD_ARCHITECTURE,
    TOOL_FLOWGUARD_REVIEW,
    TOOL_FLOWGUARD_RUN_CHECK,
  ].includes(toolName);
}

/** Read-only repository investigation tools a repair loop needs to inspect code. */
export const CHECK_REWORK_READ_TOOLS: ReadonlySet<string> = new Set(['read', 'glob', 'grep']);

function hasActiveRework(state: SessionState | null): boolean {
  return state?.implementationRework != null && state.implementationRework.exhausted === false;
}

function isCheckReworkLoopPhase(phase: SessionState['phase'] | undefined): boolean {
  return phase === 'IMPLEMENTATION' || phase === 'IMPL_VALIDATION' || phase === 'IMPL_REVIEW';
}

export async function updateCheckReworkContinuation(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<void> {
  if (runtime.activeCommandScopes.get(sessionId) !== 'check') return;
  if (!isReviewableFlowGuardTool(toolName)) return;
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) return;
  let state: SessionState | null;
  try {
    state = await readState(sessDir);
  } catch {
    return;
  }
  if (hasActiveRework(state) && state?.phase === 'IMPLEMENTATION') {
    runtime.checkReworkContinuations.add(sessionId);
    return;
  }
  if (!isCheckReworkLoopPhase(state?.phase)) {
    runtime.checkReworkContinuations.delete(sessionId);
  }
}

/**
 * Automatic repair continuation (Patch E parity + current review-fix): a /check
 * that drove the review to `changes_requested` must continue without a manual
 * /implement hand-off. The surface is the repair family: mutating host tools,
 * read-only repository tools (read/glob/grep inspection), and
 * flowguard_implement (re-record). It never blanket-opens IMPLEMENTATION to
 * arbitrary tooling under /check.
 */
export async function isAllowedReworkContinuation(
  runtime: FlowGuardPluginRuntime,
  toolName: string,
  sessionId: string,
): Promise<boolean> {
  const repairTool =
    toolName === TOOL_FLOWGUARD_IMPLEMENT ||
    isMutatingHostTool(toolName) ||
    CHECK_REWORK_READ_TOOLS.has(toolName);
  if (!repairTool) return false;
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) return false;
  let state: SessionState | null;
  try {
    state = await readState(sessDir);
  } catch {
    return false;
  }
  if (state?.phase !== 'IMPLEMENTATION') return false;
  // The scope-local latch survives the loop independent of the persisted marker
  // (retained across re-records but closed at IMPL_REVIEW entry), so a failing
  // FRESH check after re-record still permits the next repair. The marker
  // remains the entry evidence; an exhausted budget never unlocks regardless of
  // the latch.
  if (runtime.checkReworkContinuations.has(sessionId)) {
    return state.implementationRework == null || state.implementationRework.exhausted === false;
  }
  return state.implementationRework != null && state.implementationRework.exhausted === false;
}
