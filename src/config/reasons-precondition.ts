/**
 * Reason codes: precondition (fail-closed gates).
 * P10c: extracted from reasons.ts by category.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons.js';

export const PRECONDITION_REASONS: readonly BlockedReason[] = [
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
    code: 'CENTRAL_POLICY_MISSING',
    category: 'precondition',
    messageTemplate: 'Central policy file is missing: {message}',
    recoverySteps: [
      'Create the central policy file at FLOWGUARD_POLICY_PATH',
      'Or unset FLOWGUARD_POLICY_PATH if no central policy should apply',
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
    code: 'IMPLEMENTATION_EVIDENCE_EMPTY',
    category: 'precondition',
    messageTemplate:
      'No changed files were detected in the worktree. Implementation cannot proceed without evidence.',
    recoverySteps: [
      'Make implementation changes in the worktree before calling /implement',
      'Verify that git detects your changes (git status shows modified files)',
      'If you have already made changes, ensure the worktree directory is correct',
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
];
