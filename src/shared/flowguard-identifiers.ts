/**
 * @module shared/flowguard-identifiers
 * @description Canonical FlowGuard identifier constants and runtime reason codes.
 *
 * The evidence-level discriminator constants (FINGERPRINT_PATTERN,
 * REVIEW_REPORT_SCHEMA_ID, REVIEWER_SUBAGENT_TYPE) are owned by
 * state/evidence-identifiers.ts and re-exported here for backward
 * compatibility with non-state callers.
 *
 * Reason codes and diagnostic fields remain owned by this module.
 *
 * @version v1
 */

import {
  FINGERPRINT_PATTERN,
  REVIEW_REPORT_SCHEMA_ID,
  REVIEWER_SUBAGENT_TYPE,
} from '../state/evidence-identifiers.js';

export { FINGERPRINT_PATTERN, REVIEW_REPORT_SCHEMA_ID, REVIEWER_SUBAGENT_TYPE };

/** Block code when host-visible subagent Task invocation is required by policy. */
export const REASON_HOST_SUBAGENT_TASK_REQUIRED = 'HOST_SUBAGENT_TASK_REQUIRED';

/**
 * Block code when OpenCode cannot prove reviewer-child identity before tool execution.
 * Without that host provenance, FlowGuard cannot safely deny workflow tools to a reviewer.
 */
export const REASON_REVIEWER_CHILD_ISOLATION_UNAVAILABLE = 'REVIEWER_CHILD_ISOLATION_UNAVAILABLE';

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
 * Block code when session write lock retries are exhausted during check result
 * persistence (#504). Run-check-tool maps a PersistenceError(LOCK_TIMEOUT_EXHAUSTED)
 * to this registered reason so exhaustion fails closed as an explicit BLOCKED
 * rather than the UNREGISTERED_REASON fallback.
 */
export const REASON_LOCK_TIMEOUT_EXHAUSTED = 'LOCK_TIMEOUT_EXHAUSTED';

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
 * Structured review identity rejection field on BLOCKED tool results (#425).
 * The plugin boundary reads this marker to log reviewer-author denials without
 * parsing human-readable messages or duplicating identity comparison logic.
 */
export const REVIEW_IDENTITY_REJECTION_FIELD = 'reviewIdentityRejection';

/**
 * Structured native-attestation non-upgrade field on successful review outputs (#427).
 * The plugin boundary reads this marker to log skipped/unbound native capture
 * denials without parsing human-readable messages or re-running attestation logic.
 */
export const NATIVE_ATTESTATION_REJECTION_FIELD = 'nativeAttestationRejection';

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
