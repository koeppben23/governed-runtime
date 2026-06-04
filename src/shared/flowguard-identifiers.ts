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
 * Block code when the session write lock could not be acquired before timeout
 * because a concurrent operation held it (#429). Hydrate maps a
 * PersistenceError(LOCK_TIMEOUT) to this registered reason so contention fails
 * closed as an explicit BLOCKED rather than the UNREGISTERED_REASON fallback.
 */
export const REASON_SESSION_LOCK_CONTENDED = 'SESSION_LOCK_CONTENDED';

/**
 * Structured field on a SUCCESSFUL hydrate result, set to `true` only when the
 * session write lock had to wait for a concurrent holder before acquiring (#429).
 *
 * Emitted faithfully (real contention only) so the plugin boundary can warn
 * without parsing human messages. Absent on uncontended acquires.
 */
export const LOCK_CONTENDED_OUTPUT_FIELD = 'lockContended';

/**
 * Diagnostic reason string for the SUCCESSFUL-but-waited hydrate case (#429).
 *
 * This is NOT a registered BLOCKED reason — it never appears as a `code:` on a
 * tool result and is not part of the reason registry. It is emitted only in the
 * plugin boundary's `log.warn` extra so an operator can distinguish a hydrate
 * that succeeded after waiting for a concurrent lock holder from the fail-closed
 * `SESSION_LOCK_CONTENDED` BLOCKED case (which keeps the registered reason).
 */
export const DIAGNOSTIC_SESSION_LOCK_WAITED = 'SESSION_LOCK_WAITED';

/**
 * Structured host-task findings rejection field on BLOCKED tool results (#424).
 * The plugin boundary reads this marker to log host-task-only guard denials
 * without coupling to validation internals or parsing human-readable messages.
 */
export const HOST_TASK_FINDINGS_REJECTION_FIELD = 'hostTaskFindingsRejection';

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
