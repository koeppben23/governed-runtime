/**
 * Reason codes: precondition (fail-closed gates).
 * P10c: extracted from reasons.ts by category.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { ENVELOPE_PRECONDITION_REASONS } from './reasons-envelope.js';
import { PRECONDITION_CHALLENGE_REASONS } from './reasons-precondition-challenges.js';

export const PRECONDITION_REASONS: readonly BlockedReason[] = [
  {
    code: 'CONFIG_MISSING',
    category: 'precondition',
    messageTemplate: 'Config file is missing: {message}',
    recoverySteps: [
      'Run flowguard install to create the default config',
      'If it still fails, run flowguard install --force and retry',
    ],
  },

  {
    code: 'PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED',
    category: 'precondition',
    messageTemplate:
      "No implementation validation attempt for check '{checkId}' at the current revision; a ProofGraph claim cannot be declared without resolvable, revision-bound evidence.",
    recoverySteps: [
      'Run /check (flowguard_run_check) so the check executes against the current implementation',
      'Declare the claim only after the referenced check has an attempt at the current implementation digest',
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
      'Ensure discovery finds verificationCandidates with commands (e.g., package.json scripts)',
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
      `Invoke the ${REVIEWER_SUBAGENT_TYPE} subagent so its ReviewFindings are captured for this obligation`,
      'Submit only the reviewer verdict; FlowGuard resolves validated evidence automatically',
    ],
  },

  // ─── Review Envelope Validation — re-exported from reasons-envelope.ts ──────
  ...ENVELOPE_PRECONDITION_REASONS,

  {
    code: 'REVIEW_OBLIGATION_UNRESOLVED',
    category: 'precondition',
    messageTemplate: 'Unresolved review obligations block mutating host tool use: {message}',
    recoverySteps: [
      `Invoke the ${REVIEWER_SUBAGENT_TYPE} subagent for each unresolved obligation`,
      'Submit the resulting FlowGuard review findings before continuing mutating tool use',
    ],
  },

  {
    code: 'REVIEW_OBLIGATION_NOT_FOUND',
    category: 'precondition',
    messageTemplate:
      'The review obligation {obligationId} is missing, consumed, blocked, or does not match the supplied review continuation.',
    recoverySteps: [
      'Use reviewObligationId from the original CONTENT_ANALYSIS_REQUIRED response',
      'If the obligation was archived or the session changed, start a new /review and complete its new review lifecycle',
    ],
  },

  {
    code: 'REVIEW_OBLIGATION_ID_REQUIRED',
    category: 'precondition',
    messageTemplate: 'A review verdict requires reviewObligationId. {reason}',
    recoverySteps: [
      'Reuse reviewObligationId from the original CONTENT_ANALYSIS_REQUIRED response',
      'Submit the original content fields, reviewObligationId, and the captured reviewer verdict together',
    ],
  },

  {
    code: 'REVIEW_OBLIGATION_AMBIGUOUS',
    category: 'precondition',
    messageTemplate:
      'More than one active review obligation matches this verdict: {obligationIds}. {reason}',
    recoverySteps: [
      'Select the exact reviewObligationId from the original CONTENT_ANALYSIS_REQUIRED response',
      'Do not submit a verdict-only review while multiple active obligations exist',
    ],
  },

  {
    code: 'REVIEW_OBLIGATION_INPUT_MISMATCH',
    category: 'precondition',
    messageTemplate:
      'The supplied review input does not match the immutable source identity for obligation {obligationId}.',
    recoverySteps: [
      'Reuse the exact content input from the original CONTENT_ANALYSIS_REQUIRED response',
      'Do not combine reviewObligationId with a different branch, PR, URL, text, input origin, or references',
    ],
  },

  {
    code: 'REVIEWER_UNAVAILABLE_STRICT',
    category: 'precondition',
    messageTemplate:
      'Reviewer subagent is unavailable and strict enforcement requires host-visible review. {reason}',
    recoverySteps: [
      '{recovery}',
      `Ensure the ${REVIEWER_SUBAGENT_TYPE} subagent is installed and reachable, then re-run the review. Independent review cannot be replaced by self-review or by disabling strict enforcement`,
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
      'Submit the plan first with flowguard_plan({ planText, claims }) — no verdict inputs',
      'Do not include reviewVerdict or reviewerUnavailable in the plan submission call',
      'Read the tool response next field before constructing the review verdict call',
    ],
    quickFixCommand: '/plan',
  },

  {
    code: 'PLAN_APPROVE_WITH_TEXT',
    category: 'precondition',
    messageTemplate:
      'Plan approval included planText (you sent reviewVerdict="{receivedVerdict}"). Approval and plan submission must be separate calls; planText is for initial submissions and revisions only.',
    recoverySteps: [
      'Call flowguard_plan({ reviewVerdict: "accept" }) after FlowGuard binds the host-observed structured reviewer evidence',
      'Include planText only when reviewVerdict is "changes_requested" (revised plan)',
    ],
    quickFixCommand: '/plan',
  },

  {
    code: 'PLAN_REVIEW_IN_PROGRESS',
    category: 'precondition',
    messageTemplate:
      'The plan review loop is already active. Submit a review verdict to continue it, not a new plan.',
    recoverySteps: [
      'The review loop is active — submit only the bound reviewVerdict to continue it',
      'FlowGuard has already captured and bound the host-observed structured reviewer evidence',
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
      'Then submit only the bound reviewVerdict once FlowGuard captures the structured reviewer evidence',
    ],
    quickFixCommand: '/plan',
  },

  {
    code: 'PLAN_REVIEW_EVIDENCE_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Plan approval requires bindable review evidence: canonical obligation linkage, an explicit captured reviewer verdict, and coherence with the recorded review completion. Review completion: {reviewCompletion}, evidence status: {reviewEvidence}, captured reviewer verdict: {capturedVerdict}.',
    recoverySteps: [
      'Reopen the plan review cycle with /review-decision changes_requested',
      'Complete an independent review of the current plan version so evidence is captured with an explicit verdict',
      'Then re-run /review-decision approve so the certificate can bind the evidence',
    ],
    quickFixCommand: '/review-decision changes_requested',
  },

  {
    code: 'PLAN_REVIEW_EVIDENCE_CONTRADICTS_COMPLETION',
    category: 'precondition',
    messageTemplate:
      'Plan approval is blocked: the bound review evidence contradicts the recorded review completion. Review completion: {reviewCompletion}, captured reviewer verdict: {capturedVerdict}.',
    recoverySteps: [
      'Request plan changes with /review-decision changes_requested',
      'Complete an independent review whose verdict matches the recorded review completion',
      'Then re-run /review-decision approve so the certificate can bind coherent evidence',
    ],
    quickFixCommand: '/review-decision changes_requested',
  },

  {
    code: 'GOVERNANCE_OVERRIDE_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'The independent review exhausted its authorized budget without reviewer acceptance. A plain approval is not legal at this gate; use /override-approve to accept with a recorded governance override, or /request-changes or /reject.',
    recoverySteps: [
      'Choose /override-approve to accept the reviewed subject with an explicit governance override',
      'Choose /request-changes to continue the governed workflow with a new revision',
      'Choose /reject to end the governed workflow',
    ],
  },
  {
    code: 'GOVERNANCE_OVERRIDE_RATIONALE_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'A governance override requires a non-empty, durable rationale: the human takes explicit responsibility for the accepted risk. The rationale may not be empty or whitespace.',
    recoverySteps: [
      'Re-run /override-approve with a rationale that records why the reviewed risk is accepted',
      'Choose /request-changes or /reject if no durable justification exists',
    ],
    quickFixCommand: '/override-approve',
  },
  {
    code: 'GOVERNANCE_OVERRIDE_NOT_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'The independent review accepted the current revision. A governance override is not legal here; use /approve.',
    recoverySteps: [
      'Choose /approve to accept the reviewer-accepted revision',
      'Choose /request-changes or /reject if you disagree with the reviewed work',
    ],
  },
  {
    code: 'ARCHITECTURE_REVIEW_OVERRIDE_SUBJECT_MISMATCH',
    category: 'precondition',
    messageTemplate:
      'Architecture approval is blocked: the review budget exhausted, but the last bound review evidence covered a different ADR than the one being approved. Reviewed subject digest: {reviewedSubjectDigest}, approved subject digest: {approvedSubjectDigest}. An exhaustion override may only release the exact ADR the last review covered.',
    recoverySteps: [
      'Request ADR changes with /request-changes',
      'Run a fresh independent review of the current ADR revision',
      'Then approve or override-approve the reviewed revision',
    ],
    quickFixCommand: '/request-changes',
  },
  {
    code: 'PLAN_REVIEW_OVERRIDE_SUBJECT_MISMATCH',
    category: 'precondition',
    messageTemplate:
      'Plan approval is blocked: the review budget exhausted, but the last bound review evidence covered a different plan subject than the one being approved. Reviewed subject digest: {reviewedSubjectDigest}, approved subject digest: {approvedSubjectDigest}. An exhaustion override may only release the exact plan the last review covered.',
    recoverySteps: [
      'Request plan changes with /review-decision changes_requested',
      'Run a fresh independent review of the current plan revision',
      'Then re-run /review-decision approve',
    ],
    quickFixCommand: '/review-decision changes_requested',
  },

  {
    code: 'NO_PLAN',
    category: 'precondition',
    messageTemplate: 'No plan exists to review.',
    recoverySteps: ['Submit a plan via flowguard_plan with planText first'],
    quickFixCommand: '/plan',
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
      'Invalid implementation review call: recording evidence and submitting the verdict are separate single-purpose tools.',
    recoverySteps: [
      'Record implementation evidence first with flowguard_implement({}) only',
      'Submit the reviewer verdict separately with flowguard_review_implementation({ reviewVerdict })',
    ],
    quickFixCommand: '/implement',
  },

  {
    code: 'IMPLEMENTATION_EVIDENCE_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'An implementation review verdict (reviewVerdict="{receivedVerdict}") was submitted before implementation evidence exists. Remove it and record evidence first.',
    recoverySteps: [
      'Make the implementation changes first',
      'Call flowguard_implement({}) with NO reviewVerdict to record implementation evidence',
      'Only after evidence is recorded, submit the verdict in a separate call',
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
    code: 'IMPLEMENTATION_REWORK_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Implementation review requested changes, but the re-recorded implementation has the same rejected digest.',
    recoverySteps: [
      'Make a substantive implementation change that addresses the review feedback',
      'Call flowguard_implement again after the changed worktree produces a new digest',
    ],
    quickFixCommand: '/implement',
  },
  {
    code: 'IMPLEMENT_REVIEW_LOOP_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'An implementation review verdict requires an active implementation review loop, but the current phase is {phase}.',
    recoverySteps: [
      'Run the required post-implementation validation with flowguard_run_check({ kind }) for every active check',
      'After all checks pass and phase becomes IMPL_REVIEW, submit the bound verdict with flowguard_review_implementation({ reviewVerdict })',
    ],
    quickFixCommand: '/check',
  },

  ...PRECONDITION_CHALLENGE_REASONS,

  {
    code: 'SUBAGENT_REVIEW_NOT_INVOKED',
    category: 'precondition',
    messageTemplate: `FlowGuard signaled that independent review is required but no host-observed structured ${REVIEWER_SUBAGENT_TYPE} invocation was recorded. The structured reviewer invocation must complete before a verdict is submitted.`,
    recoverySteps: [
      `Re-run the originating FlowGuard command so the host can create the reviewer child session`,
      'Submit only the reviewVerdict; the host resolves the bound structured reviewer evidence automatically',
      'Do NOT submit, copy, or reconstruct reviewer findings — only the bound verdict is accepted',
    ],
  },

  {
    code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    category: 'precondition',
    messageTemplate:
      'FlowGuard plugin enforcement hooks are not active. Tools run but mandatory review orchestration is unavailable.',
    recoverySteps: [
      'Verify ~/.config/opencode/plugins/flowguard-audit.ts exists',
      'Run npm install in ~/.config/opencode',
      'Restart OpenCode after installing FlowGuard',
      'Run flowguard doctor to verify plugin importability and handshake',
      'Check session state for pluginHandshakeAt timestamp',
    ],
  },

  {
    code: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
    category: 'precondition',
    messageTemplate: 'Internal review orchestration failed while processing FlowGuard tool output.',
    recoverySteps: [
      'Re-run the command to create a fresh review obligation and retry orchestration',
      'If repeated failures: run flowguard doctor to verify plugin installation',
      'Check network connectivity to the OpenCode SDK (session.create/prompt)',
      'Ensure the FlowGuard tool output format matches the expected contract',
    ],
  },

  {
    code: 'ORCHESTRATION_PERMANENTLY_FAILED',
    category: 'precondition',
    messageTemplate:
      'Review orchestration failed on {attempts} consecutive attempts. Manual intervention required.',
    recoverySteps: [
      'Run flowguard doctor to verify plugin installation and reviewer agent availability',
      'Check network connectivity and OpenCode SDK health',
      'Use /abort to terminate this session and start fresh if infrastructure cannot be repaired',
    ],
  },

  {
    code: 'SUBAGENT_TYPE_UNAUTHORIZED',
    category: 'precondition',
    messageTemplate: `Subagent type '{subagentType}' is not authorized by FlowGuard governance. Only ${REVIEWER_SUBAGENT_TYPE} is allowed.`,
    recoverySteps: [
      `Use the ${REVIEWER_SUBAGENT_TYPE} subagent type for reviewer invocations`,
      'Do not spawn unauthorized subagents — FlowGuard governance restricts subagent types',
    ],
  },

  {
    code: 'SESSION_DIR_NOT_FOUND',
    category: 'precondition',
    messageTemplate:
      'FlowGuard session directory expected at {sessDir} but not found on disk. Run /hydrate to initialize the session in this workspace.',
    recoverySteps: [
      'Run /hydrate to recreate or bind a valid FlowGuard session.',
      'Verify the workspace/session directory still exists and is writable.',
      'Restart OpenCode if the sidecar session points to stale workspace state.',
    ],
  },
];
