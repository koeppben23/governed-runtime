/**
 * Reason codes: input / state / admissibility.
 * P10c: extracted from reasons.ts by category.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';
import { REVIEW_VALIDATION_REASONS } from './reasons-validation-review.js';

export const VALIDATION_REASONS: readonly BlockedReason[] = [
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
    code: 'COMMAND_BLOCKED',
    category: 'input',
    messageTemplate: '{command} blocked: {reason}',
    recoverySteps: ['Fix the blocked command input or dependency and retry the command'],
  },

  {
    code: 'WRONG_PHASE',
    category: 'admissibility',
    messageTemplate: 'Command is not valid in the current phase (current: {phase})',
    recoverySteps: ['Check the current phase with flowguard_status'],
  },

  {
    code: 'HOST_TOOL_PHASE_DENIED',
    category: 'admissibility',
    messageTemplate:
      "'{tool}' is not allowed in phase {phase}. Use read-only tools (read, glob, grep) for investigation.",
    recoverySteps: [
      'Check the current phase with flowguard_status',
      'Use read-only tools (read, glob, grep) during investigation phases',
      'Wait for the implementation phase to use mutating tools',
    ],
  },

  {
    code: 'HOST_TOOL_UNKNOWN_DENIED',
    category: 'admissibility',
    messageTemplate: 'Unknown host tool {tool} denied by default',
    recoverySteps: [
      'Use an explicitly supported host tool',
      'Extend the canonical host-tool allow-list before relying on a new tool',
    ],
  },

  {
    code: 'RISK_CLASSIFICATION_MISMATCH',
    category: 'admissibility',
    messageTemplate:
      'Task classified as {claimedTaskClass} but runtime evidence requires at least {minimumTaskClass} for {touchedSurface}',
    recoverySteps: [
      'Reclassify the task at the required risk level and re-hydrate the session',
      'Do not use text justification to downgrade risk classification',
    ],
  },

  {
    code: 'RISK_CLASSIFICATION_REQUIRED',
    category: 'admissibility',
    messageTemplate: 'Risk classification is required before mutating tools may run',
    recoverySteps: [
      'Run flowguard_hydrate with claimedTaskClass set to HIGH-RISK, STANDARD, or TRIVIAL',
    ],
  },

  {
    code: 'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
    category: 'admissibility',
    messageTemplate: 'Cannot verify risk classification evidence. {reason}',
    recoverySteps: [
      'Restore readable session state and git worktree evidence',
      'Run flowguard_status or flowguard_hydrate before retrying mutating tools',
    ],
  },

  {
    code: 'RISK_GATE_BLOCKED',
    category: 'admissibility',
    messageTemplate: 'Risk gate is already blocked for this session: {reason}',
    recoverySteps: [
      'Reclassify the task at the required risk level or start a fresh governed session',
    ],
  },

  {
    code: 'RISK_DOWNGRADE_OVERRIDE_DENIED',
    category: 'admissibility',
    messageTemplate: 'Risk downgrade overrides are disabled by policy',
    recoverySteps: ['Reclassify the task at the runtime-computed minimum risk level'],
  },

  {
    code: 'DISCOVERY_HEALTH_UNAVAILABLE',
    category: 'admissibility',
    messageTemplate:
      'Discovery evidence is unavailable ({reason}) and policy requires healthy Discovery before mutating tools may run',
    recoverySteps: [
      'Restore Discovery evidence and run flowguard_hydrate to re-establish health',
      'Do not proceed with mutating tools while Discovery is unavailable',
    ],
  },

  {
    code: 'DISCOVERY_HEALTH_DEGRADED',
    category: 'admissibility',
    messageTemplate:
      'Discovery is available but degraded ({reason}); policy onDegraded=block stops mutating tools',
    recoverySteps: [
      'Resolve the degraded Discovery collectors and re-run flowguard_hydrate',
      'Adjust discoveryHealth.onDegraded policy only with explicit governance approval',
    ],
  },

  {
    code: 'DISCOVERY_DRIFT_BLOCKED',
    category: 'admissibility',
    messageTemplate:
      'Discovery drift verdict is {driftStatus}; policy onDrift=block stops mutating tools',
    recoverySteps: [
      'Re-run discovery and flowguard_hydrate to reconcile drift against persisted evidence',
      'Investigate changed collectors before continuing implementation',
    ],
  },

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
    code: 'HUMAN_DECISION_REQUIRED',
    category: 'admissibility',
    messageTemplate:
      'Human-gated policies require an explicit user decision from a host command boundary ({reason}).',
    recoverySteps: [
      'Present the reviewCard verbatim to the user',
      'Ask the user to run /review-decision approve, /request-changes, or /reject',
      "Do not decide on the user's behalf and do not call flowguard_decision from a model-only tool call",
    ],
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
    code: 'CONFIG_INVALID',
    category: 'input',
    messageTemplate: 'Config file is invalid: {message}',
    recoverySteps: [
      'Fix flowguard.json to match FlowGuard schema',
      'If unsure, remove flowguard.json and re-run flowguard install to create defaults',
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
    code: 'INVALID_PROFILE',
    category: 'config',
    messageTemplate: 'Profile "{profile}" from config is not registered.',
    recoverySteps: [
      'Register the profile in the profile registry',
      'Use an explicit profileId with /hydrate',
      'Remove config.profile.defaultId from flowguard.json',
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
      "When reviewVerdict is 'changes_requested', planText with the revised plan is required.",
    recoverySteps: ["Provide revised planText alongside reviewVerdict: 'changes_requested'"],
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

  {
    code: 'CONTENT_ANALYSIS_REQUIRED',
    category: 'input',
    messageTemplate:
      'Content-aware /review requires reviewFindings. Analyze the supplied content before calling flowguard_review.',
    recoverySteps: [
      'Fetch or inspect the referenced text, PR, branch, or URL content',
      'Create concrete findings with severity, category, and message',
      'Re-run flowguard_review with reviewFindings populated',
    ],
  },

  {
    code: 'OPENCODE_INSTRUCTION_SOURCE_UNSUPPORTED',
    category: 'config',
    messageTemplate:
      'OpenCode accepts the FlowGuard instruction entry but the detected runtime ({runtimeLine}, version {version}) does not resolve instruction sources. FlowGuard mandates are not active.',
    recoverySteps: [
      'Use a supported OpenCode runtime (Desktop and every CLI version resolve the instructions[] mechanism per the official docs)',
      'Install FlowGuard through the supported OpenCode instructions[] mechanism',
      'Run `flowguard doctor` after switching runtimes to confirm mandates load',
    ],
  },

  ...REVIEW_VALIDATION_REASONS,
] as const satisfies readonly BlockedReason[];
