/**
 * @module integration/tools/auto-validation
 * @description Automatic validation execution on entry to a validation phase.
 *
 * The canonical workflow runs the active verification checks without a
 * user-typed `/check` step:
 * - after a human approval enters VALIDATION (PLAN_REVIEW → VALIDATION), and
 * - after `/implement` records evidence and enters IMPL_VALIDATION.
 *
 * Both phases are WAIT states whose exit is normally driven by explicit
 * `/run_check` calls. This module closes that gap: it executes every active
 * check in order through the production run-check path (candidate resolution,
 * execution-subject attestation, evidence persistence, phase-aware
 * auto-advance), so the phase exits on the same evidence the explicit surface
 * would have produced. The explicit `/run_check` compatibility surface remains
 * available and unchanged.
 *
 * Behavior:
 * - Reads the session read-only and returns `null` unless the phase is
 *   VALIDATION or IMPL_VALIDATION with at least one active check.
 * - Iterates the initial `activeChecks` kinds in order.
 * - After each check: a JSON `error === true` response or a phase change
 *   (fresh read) stops the loop and returns that check's response.
 * - Returns the last check response, or `null` when nothing ran.
 *
 * Reentrancy: a module-level guard prevents the runner from being entered
 * recursively (e.g. from inside the run_check tool path when a check errors and
 * leaves the phase unchanged). A re-entrant call is a no-op returning `null`.
 *
 * @version v1
 */

import type { ToolContext, ToolResult } from './helpers.js';
import { withReadOnlySession } from './helpers.js';
import { executeRunCheckPhased } from './run-check-tool.js';
import { formatError } from './error-format.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import type { VerificationCandidateKind } from '../../state/discovery-schemas.js';

type ValidationPhase = 'VALIDATION' | 'IMPL_VALIDATION';

let autoValidationActive = false;

function responseText(result: ToolResult): string {
  return typeof result === 'string' ? result : result.output;
}

/**
 * A check response is a fail-closed stop signal when its JSON payload reports
 * `error === true`. Unparseable payloads are treated the same way: the runner
 * must not keep executing checks against an unexpected tool response.
 *
 * Hook sites also use this to skip automatic validation when the primary call
 * was blocked without entering the phase (e.g. a rejected `/plan` at an
 * existing VALIDATION) — only a call that actually landed in a validation
 * phase may trigger the runner.
 */
export function responseReportsError(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { error?: unknown }).error === true
    );
  } catch {
    return true;
  }
}

/**
 * Execute all active checks for the current validation phase.
 *
 * Additive to the primary mutation that entered the phase: callers return the
 * primary tool output when this runner returns `null`, and the runner's
 * response when it returns a string. The phase state, evidence, and audit trail
 * are all persisted by the run-check path, not here.
 */
export async function runActiveChecksAutomatically(context: ToolContext): Promise<string | null> {
  if (autoValidationActive) return null;
  autoValidationActive = true;
  try {
    const initial = await readSession(context);
    if (initial === null) return null;
    const initialPhase = initial.phase;
    const kinds = [...initial.activeChecks];
    if (kinds.length === 0) return null;

    getAdapterLogger().info('tool', 'auto_validation', {
      sessionId: context.sessionID,
      phase: initialPhase,
      checks: kinds.join(','),
      ...getLogTraceFields(),
    });

    let lastResponse: string | null = null;
    for (const kind of kinds) {
      const text = await executeCheckResponse(kind as VerificationCandidateKind, context);
      lastResponse = text;
      if (responseReportsError(text)) return lastResponse;
      const fresh = await readSession(context);
      if (!fresh || fresh.phase !== initialPhase) return lastResponse;
    }
    return lastResponse;
  } finally {
    autoValidationActive = false;
  }
}

async function executeCheckResponse(
  kind: VerificationCandidateKind,
  context: ToolContext,
): Promise<string> {
  try {
    return responseText(await executeRunCheckPhased(kind, undefined, context));
  } catch (err) {
    return formatError(err);
  }
}

/**
 * Read the session without throwing: the runner is additive to an already
 * persisted primary mutation, so an unreadable session means "do not run"
 * (`null`) rather than a failure that would mask the primary response.
 */
async function readSession(
  context: ToolContext,
): Promise<{ phase: ValidationPhase; activeChecks: string[] } | null> {
  try {
    const { state } = await withReadOnlySession(context);
    if (!state) return null;
    if (state.phase !== 'VALIDATION' && state.phase !== 'IMPL_VALIDATION') return null;
    return { phase: state.phase, activeChecks: [...state.activeChecks] };
  } catch {
    return null;
  }
}
