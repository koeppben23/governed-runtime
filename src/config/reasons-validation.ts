/**
 * Reason codes: input / state / admissibility.
 * P10c: extracted from reasons.ts by category.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons.js';

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
    code: 'WRONG_PHASE',
    category: 'admissibility',
    messageTemplate: 'Command is not valid in the current phase (current: {phase})',
    recoverySteps: ['Check the current phase with flowguard_status'],
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
      'If unsure, remove flowguard.json and re-run /hydrate to re-materialize defaults',
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

  {
    code: 'CONTENT_ANALYSIS_REQUIRED',
    category: 'input',
    messageTemplate:
      'Content-aware /review requires analysisFindings. Analyze the supplied content before calling flowguard_review.',
    recoverySteps: [
      'Fetch or inspect the referenced text, PR, branch, or URL content',
      'Create concrete findings with severity, category, and message',
      'Re-run flowguard_review with analysisFindings populated',
    ],
  },

  {
    code: 'SUBAGENT_REVIEW_REQUIRED',
    category: 'input',
    messageTemplate:
      'analysisFindings must come from flowguard-reviewer subagent. The findings provided do not contain evidence of subagent origin.',
    recoverySteps: [
      'Call Task tool with subagent_type: "flowguard-reviewer"',
      'Pass the subagent output as analysisFindings',
      'Ensure findings include reviewedBy.sessionId containing "flowguard-reviewer" or attestation.reviewedBy === "flowguard-reviewer"',
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
    code: 'REVIEW_CARD_ARTIFACT_WRITE_FAILED',
    category: 'state',
    messageTemplate: 'Review card materialization failed: {message}',
    recoverySteps: [
      'The review card was shown in the tool response but could not be saved as an artifact file.',
      'Check filesystem permissions and disk space in the session directory.',
      'The runtime transition is not affected — this is a presentation artifact only.',
    ],
  },

  {
    code: 'REVIEW_CARD_ARTIFACT_IMMUTABLE',
    category: 'state',
    messageTemplate: 'Review card artifact immutable: {message}',
    recoverySteps: [
      'Review card artifacts are immutable per content digest.',
      'A revised card (e.g., after /request-changes) should use a new digest-based artifact path.',
      'The original card artifact is preserved.',
    ],
  },

  {
    code: 'CONTINUE_AMBIGUOUS',
    category: 'admissibility',
    messageTemplate:
      'Multiple flows are available from phase {phase}. /continue cannot choose — pick one explicitly.',
    recoverySteps: [
      'Choose a flow: /task (development), /architecture (ADR), /review (compliance/content)',
      'Or use one of the recommended commands in the /status output',
    ],
  },

  {
    code: 'CONTINUE_UNKNOWN_PHASE',
    category: 'admissibility',
    messageTemplate: 'Unknown phase {phase} encountered by /continue.',
    recoverySteps: [
      'Run /status to see the current phase and next recommended action',
      'Use the recommended command directly instead of /continue',
    ],
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

  {
    code: 'MAX_REVIEW_ITERATIONS_REACHED',
    category: 'state',
    messageTemplate:
      'Maximum review iterations ({maxIterations}) reached without convergence (last verdict: {lastVerdict}). The review loop could not converge within the policy limit.',
    recoverySteps: [
      'Submit a fresh /plan or /implement (this resets the iteration counter to 0 and starts a new obligation)',
      'Review the subagent findings — addressing the outstanding issues may allow convergence in the next attempt',
      'If the policy limit is too restrictive, adjust maxSelfReviewIterations in the policy configuration',
    ],
  },

  {
    code: 'SUBAGENT_UNABLE_TO_REVIEW',
    category: 'state',
    messageTemplate:
      'The flowguard-reviewer subagent reported it is unable to review obligation {obligationId} ({reason}). The review loop did NOT converge. This is a tool-failure signal (not a substantive finding) and is reserved for cases where the reviewer cannot honestly evaluate the input — for example malformed plan/implementation text, missing required context references, an unrecoverable structured-output schema violation, or a corrupted/mismatched mandate digest. Substantive concerns must be expressed as changes_requested instead.',
    recoverySteps: [
      'Do NOT retry the same submission — the reviewer has already declared the input unreviewable',
      'Inspect reviewFindings.missingVerification[] and reviewFindings.unknowns[] for the specific tool-failure cause',
      'Submit a fresh /plan or /implement (this resets the iteration counter to 0 and starts a new obligation)',
      'If the cause is a corrupted mandate digest or template hash mismatch, re-hydrate the session before retrying',
    ],
  },
];
