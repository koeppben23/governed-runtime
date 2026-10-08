/**
 * Reason codes: typed governance boundary error codes (workspace, persistence,
 * actor identity). Every code reachable at the tool boundary through
 * `new <Boundary>Error('CODE', ...)` and `formatError()` must have a catalog
 * entry; the completeness guard enforces this for the boundary unions.
 *
 * Category file for INFRA reason codes — merged into the canonical
 * `INFRA_REASONS` array by reasons-infra.ts (no parallel registry).
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';

export const BOUNDARY_INFRA_REASONS: readonly BlockedReason[] = [
  {
    code: 'ARCHIVE_FAILED',
    category: 'adapter',
    messageTemplate: 'Archive operation failed: {message}',
    recoverySteps: [
      'An administrator authorizes raw export in the explicit global flowguard.json (archive.redaction.allowRawExport); the repository config can only restrict the effective policy',
      'Check archive.redaction.allowedModes in the global and repository config for an empty intersection',
      'Archive only terminal sessions and verify the archive integrity with the verifier',
    ],
  },

  {
    code: 'ARCHIVE_POLICY_CONFLICT',
    category: 'adapter',
    messageTemplate:
      'Archive redaction policy conflict: the global administrator policy and the repository config have an empty allowedModes intersection. {message}',
    recoverySteps: [
      'Reconcile archive.redaction.allowedModes between the explicit global flowguard.json and the repository config',
      'Remove a restrictive repository allowedModes entry if the administrator intends to permit a mode; the repository config can only restrict',
    ],
  },

  {
    code: 'INVALID_SESSION_ID',
    category: 'adapter',
    messageTemplate: 'Invalid session id: {message}',
    recoverySteps: [
      'Use the host session id provided by the editor (for example "ses_...")',
      'Avoid path separators, whitespace, and platform-reserved names in session ids',
    ],
  },

  {
    code: 'INIT_FAILED',
    category: 'adapter',
    messageTemplate: 'Workspace initialization failed: {message}',
    recoverySteps: [
      'Ensure the workspace directory is writable and the disk has free space',
      'Re-run flowguard install or /hydrate after fixing filesystem permissions',
    ],
  },

  {
    code: 'WORKSPACE_MISMATCH',
    category: 'adapter',
    messageTemplate: 'Workspace fingerprint does not match the bound worktree: {message}',
    recoverySteps: [
      'Run FlowGuard from inside the bound worktree (no symlinked or moved paths)',
      'Re-hydrate the workspace to re-bind the session to the current worktree',
    ],
  },

  {
    code: 'SESSION_STATE_INCOMPATIBLE',
    category: 'adapter',
    messageTemplate: 'Session state does not satisfy the current executable contract: {message}',
    recoverySteps: [
      'Use the FlowGuard version that wrote this session state',
      'Start a new session with the currently installed version; never hand-edit persisted state',
    ],
  },

  {
    code: 'LOCK_TIMEOUT',
    category: 'adapter',
    messageTemplate: 'Could not acquire the session write lock: {message}',
    recoverySteps: [
      'Wait for the concurrent FlowGuard operation on this session to finish, then retry',
      'If no operation is running, inspect the reported lock file for a stale lock before removing it',
    ],
  },

  {
    code: 'DIRECT_WRITE_REQUIRES_PREPARE',
    category: 'adapter',
    messageTemplate: 'Direct metadata write rejected by the persistence boundary: {message}',
    recoverySteps: [
      'Use the prepare/full-write path (prepareStateWithAuditOperations) for protected authority fields',
      'Do not extend the direct-write mutable field set from a caller',
    ],
  },

  {
    code: 'OUTBOX_ORDER_CONFLICT',
    category: 'adapter',
    messageTemplate: 'Audit outbox order conflict: {message}',
    recoverySteps: [
      'Do not delete or reorder persisted outbox operations',
      'Report this as a defect if it occurs without manual state edits',
    ],
  },

  {
    code: 'ACTOR_IDENTITY_UNAVAILABLE',
    category: 'identity',
    messageTemplate: 'Actor identity is unavailable: {message}',
    recoverySteps: [
      'Configure the actor identity (claims file or IdP) for this workspace',
      'Re-run the command after the identity source is reachable',
    ],
  },

  {
    code: 'ACTOR_IDP_INVALID',
    category: 'identity',
    messageTemplate: 'Actor IdP configuration or token is invalid: {message}',
    recoverySteps: [
      'Fix the IdP configuration (issuer, audience, algorithms) in the actor settings',
      'Re-acquire a valid token from the configured identity provider',
    ],
  },
];
