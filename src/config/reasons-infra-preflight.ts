/**
 * Reason codes: upgrade preflight (workspace-scoped inspect --upgrade-check).
 *
 * Category file for INFRA reason codes — merged into the canonical
 * `INFRA_REASONS` array by reasons-infra.ts (no parallel registry).
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';

export const PREFLIGHT_INFRA_REASONS: readonly BlockedReason[] = [
  // ─── Upgrade preflight findings (`flowguard inspect --upgrade-check`) ──────
  {
    code: 'ACTIVE_SESSION',
    category: 'adapter',
    messageTemplate:
      'Session {sessionId} is active in phase {phase} and must be completed or archived before upgrading',
    recoverySteps: [
      'Complete the session with the currently installed version',
      'Or archive it with the currently installed version',
    ],
  },

  {
    code: 'STATE_INCOMPATIBLE',
    category: 'adapter',
    messageTemplate:
      'Session {sessionId} state is incompatible with the current contract and cannot be read',
    recoverySteps: [
      'Archive or complete the session with the currently installed version',
      'Do not edit persisted state to bridge the contract boundary',
    ],
  },

  {
    code: 'STATE_MISSING_WITH_AUDIT',
    category: 'adapter',
    messageTemplate: 'Session {sessionId} has an audit trail but no readable state',
    recoverySteps: [
      'Archive or complete the session with the currently installed version before upgrading',
    ],
  },

  {
    code: 'EMPTY_SESSION_DIR',
    category: 'adapter',
    messageTemplate: 'Session directory {sessionId} contains neither state nor audit trail',
    recoverySteps: ['Remove the empty session directory if it is no longer needed'],
  },

  {
    code: 'AUDIT_MISSING',
    category: 'adapter',
    messageTemplate: 'Session {sessionId} has no audit trail',
    recoverySteps: ['Verify whether this session must be archived before the upgrade'],
  },

  {
    code: 'AUDIT_INVALID',
    category: 'adapter',
    messageTemplate: 'Session {sessionId} live audit trail is not admissible: {reason}',
    recoverySteps: ['Inspect the audit trail with the currently installed version'],
  },

  {
    code: 'AUDIT_UNREADABLE',
    category: 'adapter',
    messageTemplate: 'Session {sessionId} live audit trail cannot be read: {message}',
    recoverySteps: ['Inspect the audit trail with the currently installed version'],
  },

  {
    code: 'ARCHIVE_UNREADABLE',
    category: 'adapter',
    messageTemplate: 'Archive {file} cannot be inspected as a tar.gz container',
    recoverySteps: [
      'Historical archives do not block the upgrade; keep the file for the previously installed artifact',
      'Verify archive readability with the version that created it',
    ],
  },

  {
    code: 'ARCHIVE_MAPPING_UNKNOWN',
    category: 'adapter',
    messageTemplate: 'Archive {file} cannot be unambiguously mapped to a session root',
    recoverySteps: [
      'Historical archives do not block the upgrade; classify this archive with the version that created it',
    ],
  },

  {
    code: 'INVENTORY_UNREADABLE',
    category: 'adapter',
    messageTemplate: 'Workspace session/archive inventory cannot be determined: {message}',
    recoverySteps: [
      'Check filesystem permissions for the workspace session directories',
      'Re-run the preflight after fixing the underlying read error',
    ],
  },

  {
    code: 'SESSION_DIR_NAME_INVALID',
    category: 'adapter',
    messageTemplate: 'Session directory "{name}" is not a valid FlowGuard session id',
    recoverySteps: [
      'Inspect the directory and rename or remove it if it is not a FlowGuard session',
    ],
  },

  {
    code: 'WORKSPACE_UNRESOLVED',
    category: 'adapter',
    messageTemplate: 'Cannot resolve the workspace for the upgrade preflight: {message}',
    recoverySteps: [
      'Run the preflight from inside the repository worktree',
      'Check that git can resolve the worktree root',
    ],
  },

  {
    code: 'ARCHIVE_CONTRACT_INCOMPATIBLE',
    category: 'adapter',
    messageTemplate: 'Archive {file} uses a superseded archive contract',
    recoverySteps: [
      'Historical archives do not block the upgrade',
      'Use the previously installed artifact when an old archive must be re-verified',
    ],
  },

  {
    code: 'ARCHIVE_CONTRACT_INVALID',
    category: 'adapter',
    messageTemplate: 'Archive {file} is invalid under the current archive contract',
    recoverySteps: [
      'Inspect the archive with the version that created it',
      'Historical archives do not block the upgrade',
    ],
  },

  {
    code: 'ARCHIVE_CONTRACT_UNKNOWN',
    category: 'adapter',
    messageTemplate: 'Archive {file} contract status cannot be determined',
    recoverySteps: [
      'Inspect the archive with the version that created it',
      'Historical archives do not block the upgrade',
    ],
  },
];
