/**
 * @module shared/flowguard-identifiers
 * @description Canonical FlowGuard identifier constants.
 *
 * Neutral module with zero dependencies — importable by any layer
 * (state, integration, adapters, CLI) without creating cycles.
 *
 * @version v1
 */

/** Canonical regex for a 24-hex-char repository fingerprint. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{24}$/;

/** Subagent type identifier for the FlowGuard reviewer subagent. */
export const REVIEWER_SUBAGENT_TYPE = 'flowguard-reviewer';

/** Schema identifier for the FlowGuard review report artifact. */
export const REVIEW_REPORT_SCHEMA_ID = 'flowguard-review-report.v1' as const;

/** Block code when host-visible subagent Task invocation is required by policy. */
export const REASON_HOST_SUBAGENT_TASK_REQUIRED = 'HOST_SUBAGENT_TASK_REQUIRED';

/** Block code when first-party plugin enforcement is unavailable for review acceptance. */
export const REASON_PLUGIN_ENFORCEMENT_UNAVAILABLE = 'PLUGIN_ENFORCEMENT_UNAVAILABLE';

/**
 * Review-acceptance path discriminator for the native_subagent_attested tier.
 *
 * Surfaced in blocked-result diagnostics so the plugin boundary can log a
 * fail-closed denial without re-deriving the path or parsing human messages (#419).
 */
export const REVIEW_ACCEPTANCE_PATH_NATIVE = 'native';

/** Recovery guidance for HOST_SUBAGENT_TASK_REQUIRED blocks. */
export const RECOVERY_HOST_SUBAGENT_TASK =
  'This policy mode requires host-visible subagent invocation via the OpenCode Task tool. ' +
  `Ensure ${REVIEWER_SUBAGENT_TYPE} agent is installed and the build agent has ` +
  `task permission: { "*": "deny", "${REVIEWER_SUBAGENT_TYPE}": "allow" }.`;
