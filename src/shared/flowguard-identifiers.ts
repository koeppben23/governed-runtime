/**
 * @module shared/flowguard-identifiers
 * @description Canonical FlowGuard identifier constants and runtime reason codes.
 *
 * Reason codes, diagnostic fields, and cross-layer runtime identifiers are
 * owned by this module. Persisted evidence/schema discriminators are owned by
 * state/evidence-identifiers.ts, except repository fingerprints, which are
 * owned by shared/repository-fingerprint.ts.
 *
 * @version v1
 */

/** Subagent type identifier for the FlowGuard reviewer subagent. */
export const REVIEWER_SUBAGENT_TYPE = 'flowguard-reviewer';

/**
 * Native plugin commands registered by the FlowGuard plugin. They are never
 * installed as command templates; an installed template of the same name would
 * collide with the native registration. This list is a parity-tested projection
 * of the canonical installed-command catalogue.
 */
export const NATIVE_START_COMMAND = 'start';
export const NATIVE_CHECK_COMMAND = 'check';
export const NATIVE_DECISION_COMMANDS = [
  'review-decision',
  'approve',
  'override-approve',
  'request-changes',
  'reject',
] as const;
export const NATIVE_RECOVER_CAPACITY_COMMAND = 'recover-capacity';
export const NATIVE_END_GOVERNANCE_COMMAND = 'end-governance';

/** Native commands represented in the installed-command catalogue. */
export const NATIVE_CATALOGUED_COMMANDS = [
  NATIVE_START_COMMAND,
  NATIVE_CHECK_COMMAND,
  ...NATIVE_DECISION_COMMANDS,
] as const;

/** Every command registered natively by the plugin; installer collision authority. */
export const NATIVE_PLUGIN_COMMANDS = [
  ...NATIVE_CATALOGUED_COMMANDS,
  NATIVE_RECOVER_CAPACITY_COMMAND,
  NATIVE_END_GOVERNANCE_COMMAND,
] as const;

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
