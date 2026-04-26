/**
 * @module integration/plugin-enforcement-tracking
 * @description Enforcement tracking helpers extracted from plugin.ts.
 *
 * Extracts the repeated hook-input-parsing + enforcement invocation
 * patterns from the tool.execute.after handler. The try/catch wrapper
 * remains in plugin.ts because logError is closure-captured.
 *
 * @version v1
 */

import {
  onFlowGuardToolAfter,
  onTaskToolAfter,
  type SessionEnforcementState,
} from './review-enforcement.js';
import { getToolArgs, getToolOutput } from './plugin-helpers.js';

/**
 * Track FlowGuard tool responses for INDEPENDENT_REVIEW_REQUIRED signals.
 *
 * Extracts args and raw output from the plugin hook input/output,
 * then delegates to review enforcement tracking.
 */
export function trackFlowGuardEnforcement(
  eState: SessionEnforcementState,
  toolName: string,
  input: unknown,
  output: unknown,
  now: string,
): void {
  const args = getToolArgs(input);
  const rawOutput = getToolOutput(output);
  onFlowGuardToolAfter(eState, toolName, args, rawOutput, now);
}

/**
 * Track Task calls to the flowguard-reviewer subagent.
 *
 * Extracts args and raw output from the plugin hook input/output,
 * then delegates to review enforcement tracking for 1:1 obligation matching.
 */
export function trackTaskEnforcement(
  eState: SessionEnforcementState,
  input: unknown,
  output: unknown,
  now: string,
): void {
  const args = getToolArgs(input);
  const rawOutput = getToolOutput(output);
  onTaskToolAfter(eState, args, rawOutput, now);
}
