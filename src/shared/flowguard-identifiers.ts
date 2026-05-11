/**
 * @module shared/flowguard-identifiers
 * @description Canonical FlowGuard identifier constants.
 *
 * Neutral module with zero dependencies — importable by any layer
 * (state, integration, adapters, CLI) without creating cycles.
 *
 * @version v1
 */

/** Subagent type identifier for the FlowGuard reviewer subagent. */
export const REVIEWER_SUBAGENT_TYPE = 'flowguard-reviewer';

/** Block code when host-visible subagent Task invocation is required by policy. */
export const REASON_HOST_SUBAGENT_TASK_REQUIRED = 'HOST_SUBAGENT_TASK_REQUIRED';

/** Recovery guidance for HOST_SUBAGENT_TASK_REQUIRED blocks. */
export const RECOVERY_HOST_SUBAGENT_TASK =
  'This policy mode requires host-visible subagent invocation via the OpenCode Task tool. ' +
  'Ensure flowguard-reviewer agent is installed and the build agent has ' +
  'task permission: { "*": "deny", "flowguard-reviewer": "allow" }.';
