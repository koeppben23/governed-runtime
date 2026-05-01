/**
 * @module config/reasons
 * @description Blocked reason registry — structured error catalog for FlowGuard rails.
 *
 * Every blocked/error state in the FlowGuard system has a registered reason code.
 * The registry provides:
 * - Human-readable message templates with {variable} interpolation
 * - Recovery steps (actionable guidance for the user)
 * - Optional quick-fix commands
 * - Categorization for reporting and analytics
 *
 * Design:
 * - All rails use `blocked(code, vars)` instead of inline error strings.
 *   This ensures consistent messaging and structured recovery guidance.
 * - New codes can be registered at runtime (extension point for profiles/addons).
 * - Unknown codes fall back to a generic message (fail-open for messaging;
 *   the block itself is already enforced by the rail logic, not by the registry).
 *
 * Categories:
 * - admissibility: Command not allowed in current phase
 * - precondition:  Required evidence or state is missing
 * - input:         User input validation failed
 * - identity:      Four-eyes or authorization check failed
 * - adapter:       External system (git, filesystem) error
 * - state:         Session state error
 *
 * Dependency: leaf module — no imports from other FlowGuard modules.
 *
 * @version v1
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Category for blocked reason classification. */
export type BlockedCategory =
  | 'admissibility'
  | 'precondition'
  | 'input'
  | 'identity'
  | 'adapter'
  | 'state'
  | 'config';

/** A registered blocked reason with metadata. */
export interface BlockedReason {
  /** Unique reason code (e.g., "COMMAND_NOT_ALLOWED"). */
  readonly code: string;
  /** Category for reporting. */
  readonly category: BlockedCategory;
  /**
   * Message template with {variable} placeholders.
   * Example: "{command} is not allowed in phase {phase}"
   */
  readonly messageTemplate: string;
  /** Ordered recovery steps for the user. */
  readonly recoverySteps: readonly string[];
  /** Optional command that fixes the issue. */
  readonly quickFixCommand?: string;
}

/** Formatted blocked result (structured, ready for RailBlocked construction). */
export interface FormattedBlock {
  readonly code: string;
  readonly reason: string;
  readonly recovery: readonly string[];
  readonly quickFix?: string;
}

// ─── Interpolation ────────────────────────────────────────────────────────────

/**
 * Replace {variable} placeholders in a template string.
 * Unknown variables are left as-is (visible in output for debugging).
 */
function interpolate(template: string, vars?: Record<string, string>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Blocked reason registry.
 *
 * Central catalog of all known blocked/error codes.
 * Pre-seeded with built-in codes, extensible at runtime.
 */
export class BlockedReasonRegistry {
  private readonly reasons = new Map<string, BlockedReason>();

  /** Register a blocked reason. Overwrites existing entries with the same code. */
  register(reason: BlockedReason): void {
    this.reasons.set(reason.code, reason);
  }

  /** Register multiple reasons at once. */
  registerAll(reasons: readonly BlockedReason[]): void {
    for (const r of reasons) this.register(r);
  }

  /** Look up a reason by code. Returns undefined if not registered. */
  get(code: string): BlockedReason | undefined {
    return this.reasons.get(code);
  }

  /**
   * Format a blocked reason with variable interpolation.
   *
   * Returns a structured result ready for RailBlocked construction.
   * Falls back to generic message for unknown codes — the block itself
   * is already enforced by the rail logic, not by the registry.
   */
  format(code: string, vars?: Record<string, string>): FormattedBlock {
    const reason = this.reasons.get(code);
    if (!reason) {
      return {
        code,
        reason: vars?.message ?? `Blocked: ${code}`,
        recovery: [],
      };
    }
    return {
      code: reason.code,
      reason: interpolate(reason.messageTemplate, vars),
      recovery: reason.recoverySteps.map((step) => interpolate(step, vars)),
      quickFix: reason.quickFixCommand ? interpolate(reason.quickFixCommand, vars) : undefined,
    };
  }

  /** All registered codes. */
  codes(): string[] {
    return Array.from(this.reasons.keys());
  }

  /** Number of registered reasons. */
  get size(): number {
    return this.reasons.size;
  }
}

// ─── Seed Data ────────────────────────────────────────────────────────────────

/**
 * All built-in blocked reason codes.
 *
 * Exhaustive catalog of every blocked/error state in the FlowGuard system.
 * Organized by category. Each entry provides:
 * - A message template with interpolation variables
 * - Recovery steps (what the user should do)
 * - An optional quick-fix command
 */
const SEED_REASONS: readonly BlockedReason[] = [
  // ── Admissibility ─────────────────────────────────────────────
  {
    code: 'COMMAND_NOT_ALLOWED',
    category: 'admissibility',
    messageTemplate: '{command} is not allowed in phase {phase}',
    recoverySteps: [
      'Check the current phase with flowguard_status',
      'Use a command that is allowed in the current phase',
    ],
  },
  {
    code: 'WRONG_PHASE',
    category: 'admissibility',
    messageTemplate: 'Command is not valid in the current phase (current: {phase})',
    recoverySteps: ['Check the current phase with flowguard_status'],
  },

  // ── Input Validation ──────────────────────────────────────────
  {
    code: 'EMPTY_TICKET',
    category: 'input',
    messageTemplate: 'Ticket text must not be empty',
    recoverySteps: ['Provide a non-empty task description'],
  },
  {
    code: 'EMPTY_PLAN',
    category: 'input',
    messageTemplate: 'Plan body must not be empty',
    recoverySteps: ['Provide plan text via planText parameter'],
  },
  {
    code: 'MISSING_SESSION_ID',
    category: 'input',
    messageTemplate: 'sessionId is required (from OpenCode context.sessionID)',
    recoverySteps: [
      'Ensure OpenCode context provides a valid sessionID',
      'This is usually an integration error — check tool context',
    ],
  },
  {
    code: 'MISSING_WORKTREE',
    category: 'input',
    messageTemplate: 'worktree is required (from OpenCode context.worktree)',
    recoverySteps: [
      'Ensure OpenCode context provides a valid worktree path',
      'This is usually an integration error — check tool context',
    ],
  },
  {
    code: 'INVALID_FINGERPRINT',
    category: 'input',
    messageTemplate: 'fingerprint is missing or malformed (expected 24 hex chars)',
    recoverySteps: [
      'Ensure OpenCode context provides a valid worktree and fingerprint',
      'Fingerprint must be a 24-character lowercase hex string',
    ],
  },
  {
    code: 'INVALID_VERDICT',
    category: 'input',
    messageTemplate: 'Invalid verdict: {verdict}. Must be approve, changes_requested, or reject.',
    recoverySteps: ["Provide a valid verdict: 'approve', 'changes_requested', or 'reject'"],
  },
  {
    code: 'INVALID_TRANSITION',
    category: 'input',
    messageTemplate: 'Event {event} is not valid in phase {phase}',
    recoverySteps: [
      'Check the current phase with flowguard_status',
      'Use a valid event for the current phase',
    ],
  },
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
      'Ensure workspace/session directories are writable',
      'Re-run /hydrate after fixing filesystem permissions or disk issues',
    ],
  },
  {
    code: 'WORKSPACE_CONFIG_MISSING',
    category: 'precondition',
    messageTemplate: 'Workspace config.json is missing: {message}',
    recoverySteps: [
      'Run /hydrate to materialize workspace config defaults',
      'If it still fails, run flowguard install --force and retry',
    ],
  },
  {
    code: 'WORKSPACE_CONFIG_WRITE_FAILED',
    category: 'adapter',
    messageTemplate: 'Workspace config.json could not be written: {message}',
    recoverySteps: [
      'Ensure workspace directory is writable',
      'Re-run /hydrate after fixing filesystem permissions or disk issues',
    ],
  },
  {
    code: 'WORKSPACE_CONFIG_INVALID',
    category: 'input',
    messageTemplate: 'Workspace config.json is invalid: {message}',
    recoverySteps: [
      'Fix config.json to match FlowGuard schema',
      'If unsure, remove config.json and re-run /hydrate to re-materialize defaults',
    ],
  },
  {
    code: 'CENTRAL_POLICY_PATH_EMPTY',
    category: 'input',
    messageTemplate: 'FLOWGUARD_POLICY_PATH is set but empty: {message}',
    recoverySteps: [
      'Set FLOWGUARD_POLICY_PATH to an absolute or relative file path',
      'Or unset FLOWGUARD_POLICY_PATH to disable central policy for this run',
    ],
  },
  {
    code: 'CENTRAL_POLICY_MISSING',
    category: 'precondition',
    messageTemplate: 'Central policy file is missing: {message}',
    recoverySteps: [
      'Create the central policy file at FLOWGUARD_POLICY_PATH',
      'Or unset FLOWGUARD_POLICY_PATH if no central policy should apply',
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
    code: 'CENTRAL_POLICY_INVALID_JSON',
    category: 'input',
    messageTemplate: 'Central policy file is invalid JSON: {message}',
    recoverySteps: [
      'Fix JSON syntax in the central policy file',
      'Validate file structure before re-running /hydrate',
    ],
  },
  {
    code: 'CENTRAL_POLICY_INVALID_SCHEMA',
    category: 'input',
    messageTemplate: 'Central policy file failed schema validation: {message}',
    recoverySteps: [
      'Ensure schemaVersion is "v1" and minimumMode is present',
      'Use only supported fields and data types',
    ],
  },
  {
    code: 'CENTRAL_POLICY_INVALID_MODE',
    category: 'input',
    messageTemplate: 'Central policy minimumMode is invalid: {message}',
    recoverySteps: [
      'Set minimumMode to one of: solo, team, regulated',
      'Re-run /hydrate after updating the central policy file',
    ],
  },
  {
    code: 'EXPLICIT_WEAKER_THAN_CENTRAL',
    category: 'precondition',
    messageTemplate: 'Explicit policy mode violates central minimum: {message}',
    recoverySteps: [
      'Use /hydrate with a policyMode that satisfies the central minimum',
      'Or remove explicit policyMode and allow central minimum to apply',
    ],
  },
  {
    code: 'EXISTING_POLICY_WEAKER_THAN_CENTRAL',
    category: 'precondition',
    messageTemplate: 'Existing session policy violates central minimum: {message}',
    recoverySteps: [
      'Resume the session without FLOWGUARD_POLICY_PATH or with a compatible central minimum',
      'Or start a new session at a compliant policy mode',
    ],
  },
  {
    code: 'INVALID_PROFILE',
    category: 'config',
    messageTemplate: 'Profile "{profile}" from config is not registered.',
    recoverySteps: [
      'Register the profile in the profile registry',
      'Use an explicit profileId with /hydrate',
      'Remove config.profile.defaultId from config.json',
    ],
  },
  {
    code: 'HYDRATE_DISCOVERY_CONTRACT_FAILED',
    category: 'state',
    messageTemplate: 'Hydrate discovery contract failed: {message}',
    recoverySteps: [
      'Re-run /hydrate and verify discovery artifacts are created',
      'Do not proceed until discoveryDigest and discoverySummary are present',
    ],
  },
  {
    code: 'REVISED_PLAN_REQUIRED',
    category: 'input',
    messageTemplate:
      "When selfReviewVerdict is 'changes_requested', planText with the revised plan is required.",
    recoverySteps: ["Provide revised planText alongside selfReviewVerdict: 'changes_requested'"],
  },
  {
    code: 'MISSING_CHECKS',
    category: 'input',
    messageTemplate:
      'Missing results for active checks: {checks}. All active checks must be reported.',
    recoverySteps: [
      'Submit results for all active checks',
      'Check activeChecks in the session state via flowguard_status',
    ],
  },

  // ── Precondition ──────────────────────────────────────────────
  {
    code: 'TICKET_REQUIRED',
    category: 'precondition',
    messageTemplate: 'A ticket must exist before {action}. Use /ticket first.',
    recoverySteps: ['Run /ticket to record the task description first'],
    quickFixCommand: '/ticket',
  },
  {
    code: 'PLAN_REQUIRED',
    category: 'precondition',
    messageTemplate: 'An approved plan is required before {action}',
    recoverySteps: ['Run /plan to create a plan', 'Get the plan approved at PLAN_REVIEW'],
    quickFixCommand: '/plan',
  },
  {
    code: 'VALIDATION_INCOMPLETE',
    category: 'precondition',
    messageTemplate: 'All validation checks must pass before implementation',
    recoverySteps: [
      'Run /validate or /continue at VALIDATION phase',
      'Fix any failing checks and re-validate',
    ],
    quickFixCommand: '/continue',
  },
  {
    code: 'NO_ACTIVE_CHECKS',
    category: 'precondition',
    messageTemplate: 'No validation checks configured. Set activeChecks via /hydrate.',
    recoverySteps: [
      'Configure a profile with activeChecks during /hydrate',
      'The baseline profile includes test_quality and rollback_safety',
    ],
  },
  {
    code: 'NO_SESSION',
    category: 'precondition',
    messageTemplate: 'No FlowGuard session found. Run /hydrate first to bootstrap a session.',
    recoverySteps: ['Run /hydrate to create a new FlowGuard session'],
    quickFixCommand: '/hydrate',
  },
  {
    code: 'EVIDENCE_ARTIFACT_MISSING',
    category: 'precondition',
    messageTemplate:
      'Derived evidence artifacts are missing for the current session state: {message}',
    recoverySteps: [
      'Restore the session artifacts from a trusted archive or recover the full session directory backup',
      'Do not continue governance commands until artifact integrity is restored',
    ],
  },
  {
    code: 'EVIDENCE_ARTIFACT_MISMATCH',
    category: 'state',
    messageTemplate: 'Derived evidence artifacts do not match session-state.json: {message}',
    recoverySteps: [
      'Do not proceed with governance commands while artifacts are inconsistent',
      'Restore session artifacts from a trusted archive or regenerate from trusted state',
    ],
  },
  {
    code: 'EVIDENCE_ARTIFACT_IMMUTABLE',
    category: 'state',
    messageTemplate: 'Evidence artifacts are append-only and cannot be overwritten: {message}',
    recoverySteps: [
      'Create a new artifact version instead of modifying an existing artifact file',
      'Restore immutable artifact files from a trusted archive if they were modified',
    ],
  },
  {
    code: 'REVIEW_FINDINGS_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Review findings are required for all review verdicts in mandatory review mode.',
    recoverySteps: [
      'Obtain structured ReviewFindings from flowguard-reviewer subagent',
      'Submit verdict with reviewFindings parameter',
    ],
  },
  {
    code: 'NO_SELF_REVIEW',
    category: 'precondition',
    messageTemplate: 'No self-review loop is active. Submit a plan first.',
    recoverySteps: ['Submit a plan via flowguard_plan with planText first'],
  },
  {
    code: 'REVIEW_FINDINGS_HASH_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted review findings do not match the persisted subagent invocation evidence for obligation {obligationId}.',
    recoverySteps: [
      'Discard the modified review findings',
      'Use the exact ReviewFindings returned by the fulfilled flowguard-reviewer invocation',
      'If the evidence is stale, rerun the reviewer for the current obligation',
    ],
  },
  {
    code: 'REVIEW_FINDINGS_SESSION_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted review findings session does not match the persisted subagent invocation: provided {provided}, expected {expected}.',
    recoverySteps: [
      'Use ReviewFindings from the child session that fulfilled the active obligation',
      'Rerun the flowguard-reviewer subagent if the findings came from a different session',
    ],
  },
  {
    code: 'INVALID_PLAN_TOOL_SEQUENCE',
    category: 'precondition',
    messageTemplate:
      'Invalid flowguard_plan call sequence: plan submission and review verdict inputs must be separate calls.',
    recoverySteps: [
      'Submit the plan first with flowguard_plan({ planText }) only',
      'Do not include selfReviewVerdict or reviewFindings in the plan submission call',
    ],
    quickFixCommand: '/plan',
  },
  {
    code: 'PLAN_SUBMISSION_MIXED_INPUTS',
    category: 'precondition',
    messageTemplate:
      'Plan submission included reviewFindings without a verdict. Findings belong to the verdict call, not the initial submission.',
    recoverySteps: [
      'Submit the plan with flowguard_plan({ planText }) only',
      'Add reviewFindings in the verdict call: flowguard_plan({ selfReviewVerdict, reviewFindings })',
    ],
    quickFixCommand: '/plan',
  },
  {
    code: 'PLAN_APPROVE_WITH_TEXT',
    category: 'precondition',
    messageTemplate:
      'Plan approval included planText. For approval, send only the verdict and findings — planText is for revisions.',
    recoverySteps: [
      'For approval: call flowguard_plan({ selfReviewVerdict: "approve", reviewFindings })',
      'Include planText only when selfReviewVerdict is "changes_requested" (revised plan)',
    ],
    quickFixCommand: '/plan',
  },
  {
    code: 'PLAN_REVIEW_IN_PROGRESS',
    category: 'precondition',
    messageTemplate:
      'The plan review loop is already active. Submit a review verdict to continue it, not a new plan.',
    recoverySteps: [
      'The review loop is active — send selfReviewVerdict + reviewFindings to continue it',
      'Call flowguard_plan({ selfReviewVerdict: "approve"|"changes_requested", reviewFindings })',
    ],
    quickFixCommand: '/plan',
  },
  {
    code: 'PLAN_FINDINGS_WITHOUT_VERDICT',
    category: 'precondition',
    messageTemplate:
      'Review findings were submitted without a verdict. Include selfReviewVerdict alongside reviewFindings.',
    recoverySteps: [
      'Include selfReviewVerdict alongside reviewFindings',
      'Call flowguard_plan({ selfReviewVerdict: "approve"|"changes_requested", reviewFindings })',
    ],
    quickFixCommand: '/plan',
  },
  {
    code: 'PLAN_SUBMISSION_REQUIRED',
    category: 'precondition',
    messageTemplate: 'A review verdict was submitted before any plan exists.',
    recoverySteps: [
      'Call flowguard_plan with planText first',
      'Do not submit a review verdict before the plan review loop is initialized',
    ],
    quickFixCommand: '/plan',
  },
  {
    code: 'PLAN_REVIEW_LOOP_REQUIRED',
    category: 'precondition',
    messageTemplate: 'A plan review verdict requires an active plan review loop.',
    recoverySteps: [
      'Submit the plan first and wait for the review obligation',
      'Then submit selfReviewVerdict together with reviewFindings',
    ],
    quickFixCommand: '/plan',
  },
  {
    code: 'NO_PLAN',
    category: 'precondition',
    messageTemplate: 'No plan exists to review.',
    recoverySteps: ['Submit a plan via flowguard_plan with planText first'],
    quickFixCommand: '/plan',
  },
  {
    code: 'NO_ARCHITECTURE',
    category: 'precondition',
    messageTemplate: 'No ADR exists to review.',
    recoverySteps: ['Submit an ADR via flowguard_architecture with title and adrText first'],
    quickFixCommand: '/architecture',
  },
  {
    code: 'INVALID_ARCHITECTURE_TOOL_SEQUENCE',
    category: 'precondition',
    messageTemplate:
      'Invalid flowguard_architecture call sequence: ADR submission and review verdict inputs must be separate calls.',
    recoverySteps: [
      'Submit the ADR first with flowguard_architecture({ title, adrText }) only',
      'Do not include selfReviewVerdict in the ADR submission call',
      'During an active ADR review loop, submit only selfReviewVerdict and revised adrText when changes are requested',
    ],
    quickFixCommand: '/architecture',
  },
  {
    code: 'ADR_SUBMISSION_MIXED_INPUTS',
    category: 'precondition',
    messageTemplate:
      'ADR submission included a review verdict. Submission and verdict are separate calls.',
    recoverySteps: [
      'Submit the ADR with flowguard_architecture({ id, title, adrText }) only',
      'Submit the review verdict separately: flowguard_architecture({ selfReviewVerdict })',
    ],
    quickFixCommand: '/architecture',
  },
  {
    code: 'ADR_REVIEW_IN_PROGRESS',
    category: 'precondition',
    messageTemplate:
      'The ADR review loop is already active. Submit a review verdict to continue it, not a new ADR.',
    recoverySteps: [
      'The review loop is active — send selfReviewVerdict to continue it',
      'Call flowguard_architecture({ selfReviewVerdict: "approve"|"changes_requested" })',
    ],
    quickFixCommand: '/architecture',
  },
  {
    code: 'ARCHITECTURE_REVIEW_LOOP_REQUIRED',
    category: 'precondition',
    messageTemplate: 'An architecture review verdict requires an active ADR review loop.',
    recoverySteps: [
      'Submit the ADR first and wait for the architecture review loop',
      'Then submit selfReviewVerdict for the active ADR review loop',
    ],
    quickFixCommand: '/architecture',
  },
  {
    code: 'NO_IMPLEMENTATION',
    category: 'precondition',
    messageTemplate: 'No implementation evidence to review.',
    recoverySteps: ['Record implementation via flowguard_implement first'],
    quickFixCommand: '/implement',
  },
  {
    code: 'INVALID_IMPLEMENT_TOOL_SEQUENCE',
    category: 'precondition',
    messageTemplate:
      'Invalid flowguard_implement call sequence: implementation evidence and review findings must be separate calls.',
    recoverySteps: [
      'Record implementation evidence first with flowguard_implement({}) only',
      'Do not include reviewFindings unless reviewVerdict is also provided',
    ],
    quickFixCommand: '/implement',
  },
  {
    code: 'IMPLEMENTATION_EVIDENCE_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'An implementation review verdict was submitted before implementation evidence exists.',
    recoverySteps: [
      'Make the implementation changes first',
      'Call flowguard_implement({}) to record implementation evidence before submitting reviewVerdict',
    ],
    quickFixCommand: '/implement',
  },
  {
    code: 'IMPLEMENT_REVIEW_LOOP_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'An implementation review verdict requires an active implementation review loop.',
    recoverySteps: [
      'Record implementation evidence first and wait for the implementation review obligation',
      'Then submit reviewVerdict together with reviewFindings',
    ],
    quickFixCommand: '/implement',
  },

  // ── Architecture Input ────────────────────────────────────────
  {
    code: 'EMPTY_ADR_TITLE',
    category: 'input',
    messageTemplate: 'ADR title must not be empty.',
    recoverySteps: ['Provide a short, descriptive title for the architecture decision'],
  },
  {
    code: 'EMPTY_ADR_TEXT',
    category: 'input',
    messageTemplate: 'ADR body text must not be empty.',
    recoverySteps: [
      'Provide the full ADR body in MADR format',
      'Must include ## Context, ## Decision, and ## Consequences sections',
    ],
  },
  {
    code: 'MISSING_ADR_SECTIONS',
    category: 'input',
    messageTemplate: 'ADR is missing required MADR sections: {sections}',
    recoverySteps: [
      'Add the missing sections to the ADR body',
      'Required: ## Context, ## Decision, ## Consequences',
    ],
  },

  // ── Identity / Four-Eyes ──────────────────────────────────────
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
  // P33: Verified Actor Identity
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

  // ── Adapter ───────────────────────────────────────────────────
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

  // ── Binding ───────────────────────────────────────────────────
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

  // ── State ─────────────────────────────────────────────────────
  {
    code: 'ABORTED',
    category: 'state',
    messageTemplate: 'Session aborted: {reason}',
    recoverySteps: [
      'Start a new session with /hydrate',
      'The aborted session is preserved in the audit trail',
    ],
    quickFixCommand: '/hydrate',
  },
  {
    code: 'TOOL_ERROR',
    category: 'state',
    messageTemplate: 'Tool execution error: {message}',
    recoverySteps: ['Check the error details and retry the operation'],
  },
  {
    code: 'INTERNAL_ERROR',
    category: 'state',
    messageTemplate: 'Internal error: {message}',
    recoverySteps: [
      'This is an unexpected error — check logs for details',
      'If the error persists, abort the session with /abort',
    ],
  },
  {
    code: 'POLICY_SNAPSHOT_MISSING',
    category: 'state',
    messageTemplate:
      'Session state is missing policySnapshot. Every hydrated session must have a frozen policy snapshot.',
    recoverySteps: [
      'Re-hydrate the session with /hydrate',
      'If the issue persists, the session state may be corrupted — start a new session',
      'Verify session-state.json contains a non-empty policySnapshot field',
    ],
    quickFixCommand: '/hydrate',
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

  // ── Independent Review (Subagent enforcement) ─────────────────
  {
    code: 'SUBAGENT_PROMPT_EMPTY',
    category: 'precondition',
    messageTemplate:
      'The flowguard-reviewer prompt is too short. Include the plan/implementation text, ticket text, iteration, and planVersion.',
    recoverySteps: [
      'Provide a substantive prompt to the flowguard-reviewer subagent',
      'Include the full review context: plan or implementation text, ticket text, iteration, and planVersion',
      'Re-invoke the subagent with the complete context',
    ],
  },
  {
    code: 'SUBAGENT_PROMPT_MISSING_CONTEXT',
    category: 'precondition',
    messageTemplate:
      'The flowguard-reviewer prompt does not contain the expected review context. Include iteration and planVersion values from the FlowGuard tool response.',
    recoverySteps: [
      'Read the iteration and planVersion values from the flowguard_plan or flowguard_implement response',
      'Include those exact values in the prompt to the flowguard-reviewer subagent',
      'Re-invoke the subagent with the corrected prompt',
    ],
  },
  {
    code: 'SUBAGENT_CONTEXT_UNVERIFIABLE',
    category: 'state',
    messageTemplate:
      'Content meta extraction failed — cannot validate subagent context in strict mode. The FlowGuard tool response must include structured review obligation metadata.',
    recoverySteps: [
      'Re-run the FlowGuard tool that produced the review obligation (flowguard_plan or flowguard_implement)',
      'Verify the response contains the reviewObligation field with iteration and planVersion',
      'If the issue persists in regulated mode, re-hydrate the session',
    ],
    quickFixCommand: '/continue',
  },
  {
    code: 'SUBAGENT_REVIEW_NOT_INVOKED',
    category: 'precondition',
    messageTemplate:
      'FlowGuard signaled INDEPENDENT_REVIEW_REQUIRED but no Task call to flowguard-reviewer was detected. Call the subagent before submitting a verdict.',
    recoverySteps: [
      'Call the flowguard-reviewer subagent via the Task tool',
      'Pass the plan/implementation text, ticket text, iteration, and planVersion in the prompt',
      'After the subagent returns ReviewFindings, submit the verdict with reviewFindings',
    ],
  },
  {
    code: 'SUBAGENT_SESSION_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted reviewFindings.reviewedBy.sessionId ({provided}) does not match the actual subagent session ({expected}). Findings must come from the invoked flowguard-reviewer.',
    recoverySteps: [
      'Use the exact reviewFindings object returned by the flowguard-reviewer subagent',
      'Do not modify reviewedBy.sessionId after the subagent produces the findings',
      'Re-invoke the subagent if the findings came from a different session',
    ],
  },
  {
    code: 'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted reviewFindings.overallVerdict ({provided}) does not match the actual subagent verdict ({expected}). Findings must not be modified.',
    recoverySteps: [
      'Submit the verdict exactly as the flowguard-reviewer subagent returned it',
      'Do not override the subagent verdict with a different value',
      'If you disagree with the subagent verdict, run another review iteration with revised input',
    ],
  },
  {
    code: 'SUBAGENT_FINDINGS_ISSUES_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted reviewFindings.blockingIssues count ({provided}) does not match the actual subagent count ({expected}).',
    recoverySteps: [
      'Submit the exact reviewFindings object returned by the flowguard-reviewer subagent',
      'Do not add, remove, or modify blockingIssues entries after the subagent produces them',
      'Re-invoke the subagent if the captured findings are stale',
    ],
  },
  {
    code: 'SUBAGENT_EVIDENCE_REUSED',
    category: 'state',
    messageTemplate:
      'Subagent invocation evidence has already been consumed for this obligation. Each obligation requires a fresh invocation.',
    recoverySteps: [
      'Re-invoke the flowguard-reviewer subagent for the current obligation',
      'Do not reuse findings from a previously consumed invocation',
      'Each plan version and review iteration requires its own subagent invocation',
    ],
  },
  {
    code: 'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'Cannot verify review obligation fulfillment in strict mode — enforcement state is unavailable and session state cannot be read.',
    recoverySteps: [
      'Re-hydrate the session with /hydrate',
      'Run /continue before submitting a verdict to restore enforcement state',
      'Verify session-state.json is readable and contains a reviewAssurance object',
    ],
    quickFixCommand: '/continue',
  },
];

// ─── Default Registry ─────────────────────────────────────────────────────────

/** The default registry, pre-seeded with all built-in codes (30+). */
export const defaultReasonRegistry = new BlockedReasonRegistry();
defaultReasonRegistry.registerAll(SEED_REASONS);

// ─── Convenience Helper ───────────────────────────────────────────────────────

/**
 * Create a RailBlocked result from a registered reason code.
 *
 * Usage in rails:
 *   return blocked("COMMAND_NOT_ALLOWED", { command: "/plan", phase: state.phase });
 *
 * Replaces inline blocked returns:
 *   return { kind: "blocked", code: "COMMAND_NOT_ALLOWED", reason: `...` };
 *
 * The returned object is structurally compatible with RailBlocked.
 * Recovery steps and quickFix are included for LLM and user guidance.
 */
export function blocked(
  code: string,
  vars?: Record<string, string>,
): {
  readonly kind: 'blocked';
  readonly code: string;
  readonly reason: string;
  readonly recovery: readonly string[];
  readonly quickFix?: string;
} {
  const formatted = defaultReasonRegistry.format(code, vars);
  return {
    kind: 'blocked' as const,
    code: formatted.code,
    reason: formatted.reason,
    recovery: formatted.recovery,
    quickFix: formatted.quickFix,
  };
}
