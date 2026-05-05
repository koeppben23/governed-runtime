/**
 * Reason codes: adapter / identity.
 * P10c: extracted from reasons.ts by category.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons.js';

export const INFRA_REASONS: readonly BlockedReason[] = [
  {
    code: 'DISCOVERY_RESULT_MISSING',
    category: 'adapter',
    messageTemplate: 'Discovery did not produce a valid result: {message}',
    recoverySteps: [
      'Fix repository/discovery adapter errors and run /hydrate again',
      'Verify repository is readable and collectors can complete',
    ],
  },

  {
    code: 'DISCOVERY_PERSIST_FAILED',
    category: 'adapter',
    messageTemplate: 'Failed to persist discovery artifacts: {message}',
    recoverySteps: [
      'Ensure workspace directory is writable',
      'Re-run /hydrate after fixing filesystem permissions or disk issues',
    ],
  },

  {
    code: 'PROFILE_RESOLUTION_PERSIST_FAILED',
    category: 'adapter',
    messageTemplate: 'Failed to persist profile-resolution artifacts: {message}',
    recoverySteps: [
      'Ensure the target directory is writable',
      'Re-run flowguard install after fixing filesystem permissions or disk issues',
    ],
  },

   {
     code: 'CONFIG_WRITE_FAILED',
     category: 'adapter',
     messageTemplate: 'Config file could not be written: {message}',
     recoverySteps: [
       'Ensure the target directory is writable',
       'Re-run flowguard install after fixing filesystem permissions or disk issues',
     ],
   },

  {
    code: 'CENTRAL_POLICY_UNREADABLE',
    category: 'adapter',
    messageTemplate: 'Central policy file is unreadable: {message}',
    recoverySteps: [
      'Ensure the policy file exists and is readable by the current user',
      'Fix permissions and re-run /hydrate',
    ],
  },

  {
    code: 'DECISION_IDENTITY_REQUIRED',
    category: 'identity',
    messageTemplate:
      'Regulated approval requires explicit initiator and reviewer identities. Unable to verify decision identity.',
    recoverySteps: [
      'Set FLOWGUARD_ACTOR_ID before running /hydrate and /review-decision',
      'Ensure both session initiator and reviewer identities are non-empty',
      'Re-run /review-decision with verdict=approve after identity is available',
    ],
  },

  {
    code: 'REGULATED_ACTOR_UNKNOWN',
    category: 'identity',
    messageTemplate:
      'Regulated approval blocked: {role} identity is unknown. A known actor identity is required.',
    recoverySteps: [
      'Provide a stable reviewer identity via FLOWGUARD_ACTOR_ID',
      'Ensure git user.name is configured when env identity is not set',
      'Retry /review-decision after identity resolution succeeds',
    ],
  },

  {
    code: 'FOUR_EYES_ACTOR_MATCH',
    category: 'identity',
    messageTemplate:
      'Four-eyes principle: session initiator ({initiator}) cannot approve their own work. A different reviewer is required.',
    recoverySteps: [
      'A different person must provide the review decision',
      'The session was initiated by {initiator}',
      'Ask a colleague with reviewer permissions to run /review-decision',
    ],
  },

  {
    code: 'ACTOR_CLAIM_MISSING',
    category: 'identity',
    messageTemplate:
      'Actor claim file not found at configured path. A valid verified identity is required.',
    recoverySteps: [
      'Ensure FLOWGUARD_ACTOR_CLAIMS_PATH points to an existing JSON file',
      'Create a valid actor claim file with schema v1',
      'If verified actors are not required, unset FLOWGUARD_ACTOR_CLAIMS_PATH',
    ],
  },

  {
    code: 'ACTOR_CLAIM_UNREADABLE',
    category: 'identity',
    messageTemplate: 'Actor claim file exists but cannot be read. Check file permissions.',
    recoverySteps: [
      'Verify the file at FLOWGUARD_ACTOR_CLAIMS_PATH is readable',
      'Check file system permissions for the process',
      'If verified actors are not required, unset FLOWGUARD_ACTOR_CLAIMS_PATH',
    ],
  },

  {
    code: 'ACTOR_CLAIM_INVALID',
    category: 'identity',
    messageTemplate:
      'Actor claim file contains invalid data. Expected valid v1 claim with non-empty actorId and issuer, issuedAt <= now.',
    recoverySteps: [
      'Ensure the claim file matches schema v1 with required fields',
      'actorId and issuer must be non-empty strings',
      'issuedAt must be a valid datetime not in the future',
      'Check the claim file content is valid JSON',
    ],
  },

  {
    code: 'ACTOR_CLAIM_EXPIRED',
    category: 'identity',
    messageTemplate: 'Actor claim has expired. A current verified identity is required.',
    recoverySteps: [
      'Obtain a fresh actor claim with a future expiresAt',
      'Regenerate the claim file with a valid time window',
      'If verified actors are not required, unset FLOWGUARD_ACTOR_CLAIMS_PATH',
    ],
  },

  {
    code: 'ACTOR_CLAIM_PATH_EMPTY',
    category: 'identity',
    messageTemplate: 'Actor claim path is configured but empty or whitespace only.',
    recoverySteps: [
      'Provide a valid path to a verified actor claim file',
      'If verified actors are not required, unset FLOWGUARD_ACTOR_CLAIMS_PATH',
    ],
  },

  {
    code: 'ACTOR_IDP_MODE_REQUIRED',
    category: 'identity',
    messageTemplate:
      'IdP verification is required for this decision, but no verified IdP actor could be resolved.',
    recoverySteps: [
      'Configure identityProvider in FlowGuard policy',
      'Set FLOWGUARD_ACTOR_TOKEN_PATH to a valid JWT token file',
      'Check that the token is valid and not expired',
      'If idp_verified is not required for this session, set identityProviderMode to optional',
    ],
  },

  {
    code: 'ACTOR_IDP_CONFIG_REQUIRED',
    category: 'identity',
    messageTemplate:
      'identityProviderMode is required but no identityProvider is configured in the policy.',
    recoverySteps: [
      'Add identityProvider configuration to FlowGuardConfig',
      'Configure signing keys or JWKS authority',
      'If IdP verification is not needed, set identityProviderMode to optional',
    ],
  },

  {
    code: 'ACTOR_ASSURANCE_INSUFFICIENT',
    category: 'identity',
    messageTemplate:
      'Regulated approval requires minimum actor assurance "{minimum}". Current actor has "{current}" assurance.',
    recoverySteps: [
      'Ensure the actor identity meets the minimum assurance requirement for this policy mode',
      'For claim_validated requirement: configure FLOWGUARD_ACTOR_CLAIMS_PATH with a valid claim file',
      'For idp_verified requirement: configure FLOWGUARD_ACTOR_IDP_CONFIG with a valid IdP token (P35)',
      'Adjust minimumActorAssuranceForApproval in the policy if a lower assurance level is acceptable',
    ],
  },

  {
    code: 'VERIFIED_ACTOR_REQUIRED',
    category: 'identity',
    messageTemplate:
      'Regulated approval requires verified actor identity. Current actor has best_effort assurance.',
    recoverySteps: [
      'Configure FLOWGUARD_ACTOR_CLAIMS_PATH with a valid verified claim',
      'Ensure the policy does not require verified actors if not available',
      'A verified actor with assurance=claim_validated is required for this approval',
    ],
  },

  {
    code: 'GIT_NOT_FOUND',
    category: 'adapter',
    messageTemplate: 'git executable not found on PATH',
    recoverySteps: [
      'Install git: https://git-scm.com/downloads',
      'Ensure git is on the system PATH',
    ],
  },

  {
    code: 'GIT_COMMAND_FAILED',
    category: 'adapter',
    messageTemplate: 'git command failed: {message}',
    recoverySteps: [
      'Check if the directory is a valid git repository',
      'Ensure there are no git lock files (.git/index.lock)',
    ],
  },

  {
    code: 'READ_FAILED',
    category: 'adapter',
    messageTemplate: 'Failed to read FlowGuard state: {message}',
    recoverySteps: [
      'Check if the session state file exists and is readable',
      'Verify file permissions',
    ],
  },

  {
    code: 'PARSE_FAILED',
    category: 'adapter',
    messageTemplate: 'Failed to parse FlowGuard state: {message}',
    recoverySteps: [
      'The state file may be corrupted',
      'Check the session state file for valid JSON',
      'Consider starting a new session with /hydrate',
    ],
  },

  {
    code: 'SCHEMA_VALIDATION_FAILED',
    category: 'adapter',
    messageTemplate: 'State schema validation failed: {message}',
    recoverySteps: [
      'The state file does not match the expected schema',
      'This may indicate a version mismatch',
      'Consider starting a new session with /hydrate',
    ],
  },

  {
    code: 'WRITE_FAILED',
    category: 'adapter',
    messageTemplate: 'Failed to write FlowGuard state: {message}',
    recoverySteps: [
      'Check file system permissions for the workspace directory',
      'Ensure sufficient disk space',
    ],
  },

  {
    code: 'NOT_GIT_REPO',
    category: 'adapter',
    messageTemplate: 'Directory is not a git repository: {path}',
    recoverySteps: [
      'Initialize a git repository: git init',
      'Or navigate to an existing git repository',
    ],
  },

  {
    code: 'WORKTREE_MISMATCH',
    category: 'adapter',
    messageTemplate: 'Worktree mismatch: expected {expected}, got {actual}',
    recoverySteps: [
      'The session was created for a different worktree',
      'Start a new session with /hydrate in the correct directory',
    ],
  },

  {
    code: 'AUDIT_PERSISTENCE_FAILED',
    category: 'adapter',
    messageTemplate: 'Audit event persistence failed: {message}',
    recoverySteps: [
      'Check workspace audit directory permissions and disk space',
      'In regulated mode, the operation is blocked until audit can be persisted',
      'Re-run the command after fixing the underlying I/O issue',
    ],
  },

  {
    code: 'DECISION_RECEIPT_ACTOR_MISSING',
    category: 'identity',
    messageTemplate:
      'Decision receipt skipped because decidedBy is missing on the review-decision output.',
    recoverySteps: [
      'Ensure /review-decision output includes reviewDecision.decidedBy',
      'Set FLOWGUARD_ACTOR_ID before running /review-decision',
      'Re-run /review-decision with a verified actor identity',
    ],
  },
];
