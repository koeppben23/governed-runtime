/**
 * Reason codes: precondition (fail-closed gates).
 * P10c: extracted from reasons.ts by category.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { ENVELOPE_PRECONDITION_REASONS } from './reasons-envelope.js';
import { IMPLEMENT_PRECONDITION_REASONS } from './reasons-precondition-implement.js';

export const PRECONDITION_REASONS: readonly BlockedReason[] = [
  ...IMPLEMENT_PRECONDITION_REASONS,
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
      'host-task mode: submit the verdict ONLY (reviewFindings is resolved from captured evidence and ignored if submitted). SDK mode: submit the verdict together with the reviewer reviewFindings',
    ],
  },

  {
    code: 'HOST_TASK_FINDINGS_UNPARSEABLE',
    category: 'precondition',
    messageTemplate:
      'Host-task review evidence was captured but its findings could not be parsed as valid ReviewFindings: {message}',
    recoverySteps: [
      `Re-run the ${REVIEWER_SUBAGENT_TYPE} subagent and ensure it returns a complete, schema-valid ReviewFindings object`,
      'Do not hand-edit the captured findings; the host-task evidence is the single source of truth and corrupt captures cannot be substituted by submitting reviewFindings',
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
    messageTemplate: 'A host-task review verdict requires reviewObligationId. {reason}',
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
      'Reviewer subagent is unavailable and strict enforcement requires host-visible review. {{reason}}',
    recoverySteps: [
      '{{recovery}}',
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
      'Do not include reviewVerdict, reviewFindings, or reviewerUnavailable in the plan submission call',
      'Read the tool response next field before constructing the review verdict call',
    ],
    quickFixCommand: '/plan',
  },

  {
    code: 'PLAN_SUBMISSION_MIXED_INPUTS',
    category: 'precondition',
    messageTemplate:
      'Plan submission included reviewFindings without a verdict. Findings belong to the verdict call, not the initial submission.',
    recoverySteps: [
      'Submit the plan with flowguard_plan({ planText, claims }) — no verdict inputs',
      'Add reviewFindings in the verdict call: flowguard_plan({ reviewVerdict, reviewFindings })',
    ],
    quickFixCommand: '/plan',
  },

  {
    code: 'PLAN_APPROVE_WITH_TEXT',
    category: 'precondition',
    messageTemplate:
      'Plan approval included planText (you sent reviewVerdict="{receivedVerdict}"). Approval and plan submission must be separate calls; planText is for initial submissions and revisions only.',
    recoverySteps: [
      'For host_task_required approval: call flowguard_plan({ reviewVerdict: "accept" }) after reviewer evidence is captured',
      'For SDK/manual-attested approval: call flowguard_plan({ reviewVerdict: "accept", reviewFindings }) with the exact reviewer output',
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
      'The review loop is active — submit a reviewVerdict to continue it',
      'In host_task_required mode, submit only reviewVerdict after reviewer evidence is captured',
      'In SDK/manual-attested mode, include the exact reviewer output as reviewFindings',
    ],
    quickFixCommand: '/plan',
  },

  {
    code: 'PLAN_FINDINGS_WITHOUT_VERDICT',
    category: 'precondition',
    messageTemplate:
      'Review findings were submitted without a verdict. Include reviewVerdict alongside reviewFindings.',
    recoverySteps: [
      'Include reviewVerdict alongside reviewFindings',
      'Call flowguard_plan({ reviewVerdict: "accept"|"changes_requested", reviewFindings })',
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
      'Then submit reviewVerdict together with reviewFindings',
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
      'Submit the ADR first with flowguard_architecture({ title, adrText, claims }) — no verdict inputs',
      'Do not include reviewVerdict in the ADR submission call',
      'During an active ADR review loop, submit only reviewVerdict and revised adrText when changes are requested',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_SUBMISSION_MIXED_INPUTS',
    category: 'precondition',
    messageTemplate:
      'ADR submission included a review verdict. Submission and verdict are separate calls.',
    recoverySteps: [
      'Submit the ADR with flowguard_architecture({ title, adrText, claims }) — no verdict inputs',
      'Submit the review verdict separately: flowguard_architecture({ reviewVerdict })',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_APPROVE_WITH_TEXT',
    category: 'precondition',
    messageTemplate:
      'ADR approval included adrText (you sent reviewVerdict="{receivedVerdict}"). Approval and ADR submission must be separate calls; adrText is for initial submissions and revisions only.',
    recoverySteps: [
      'For approval: call flowguard_architecture({ reviewVerdict: "accept" }) (host-task mode) or with reviewFindings (SDK mode) — without adrText',
      'Include adrText only when reviewVerdict is "changes_requested" (revised ADR)',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_FINDINGS_WITHOUT_VERDICT',
    category: 'precondition',
    messageTemplate:
      'Review findings were submitted without a verdict. Include reviewVerdict alongside reviewFindings.',
    recoverySteps: [
      'Include reviewVerdict alongside reviewFindings',
      'Call flowguard_architecture({ reviewVerdict: "accept"|"changes_requested", reviewFindings })',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_REVIEW_IN_PROGRESS',
    category: 'precondition',
    messageTemplate:
      'The ADR review loop is already active. Submit a review verdict to continue it, not a new ADR.',
    recoverySteps: [
      'The review loop is active — send reviewVerdict to continue it',
      'Call flowguard_architecture({ reviewVerdict: "accept"|"changes_requested" })',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ARCHITECTURE_REVIEW_LOOP_REQUIRED',
    category: 'precondition',
    messageTemplate: 'An architecture review verdict requires an active ADR review loop.',
    recoverySteps: [
      'Submit the ADR first and wait for the architecture review loop',
      'Then submit reviewVerdict for the active ADR review loop',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ARCHITECTURE_REVIEW_COMPLETION_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Architecture approval requires completed independent review evidence. Current review completion: {reviewCompletion}.',
    recoverySteps: [
      'Request changes to reopen the architecture review cycle',
      'Complete the independent ADR review cycle until it is reviewer_accepted or review_exhausted',
    ],
    quickFixCommand: '/review-decision changes_requested',
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
    code: 'SUBAGENT_CHALLENGE_COUNT_INCOHERENT',
    category: 'precondition',
    messageTemplate:
      'Independent review supplied {actual} challenges but policy requires at least {required}.',
    recoverySteps: ['Submit the required number of evidence-bound challenges.'],
  },
  {
    code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
    category: 'precondition',
    messageTemplate:
      'Independent review challenge of kind {kind} has invalid evidence references ({reason}).',
    recoverySteps: ['Bind each challenge to at least one canonical evidence reference.'],
  },
  {
    code: 'SUBAGENT_CHALLENGE_KIND_INCOHERENT',
    category: 'precondition',
    messageTemplate:
      'Independent review supplied challenge kind {actual}, but policy requires {required}.',
    recoverySteps: ['Submit challenges using the kind required by the frozen review obligation.'],
  },
  {
    code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
    category: 'precondition',
    messageTemplate: 'Implementation challenge {challengeId} remains unresolved.',
    recoverySteps: [
      'Record advisory resolution evidence using a passing post-implementation validation attempt.',
      'Obtain a subsequent independent reviewer verdict of resolved.',
    ],
  },

  {
    code: 'SUBAGENT_CHALLENGE_NOT_DISTINCT',
    category: 'precondition',
    messageTemplate:
      'Independent review supplied duplicate challenges ({reason}); each required challenge must be substantively distinct.',
    recoverySteps: [
      'Submit challenges that falsify different claims, cite different evidence, or target different locations.',
      'Do not repeat a challenge with only a new challengeId.',
    ],
  },
  {
    code: 'SUBAGENT_CHALLENGE_INSUBSTANTIAL',
    category: 'precondition',
    messageTemplate:
      'Independent review challenge has an empty required field ({field}); placeholder challenges are rejected.',
    recoverySteps: ['State a concrete scenario, claim, and locations for each required challenge.'],
  },
  {
    code: 'SUBAGENT_RESOLUTION_VERDICT_UNKNOWN',
    category: 'precondition',
    messageTemplate:
      'Resolution verdict references challenge {challengeId}, which is not an open challenge from the preceding review iteration.',
    recoverySteps: [
      'Return resolution verdicts only for the unresolved challenges of the immediately preceding iteration.',
    ],
  },
  {
    code: 'SUBAGENT_RESOLUTION_VERDICT_DUPLICATE',
    category: 'precondition',
    messageTemplate:
      'Resolution verdict for challenge {challengeId} appears more than once; each challenge takes exactly one verdict.',
    recoverySteps: ['Submit exactly one resolution verdict per open challenge.'],
  },
  {
    code: 'SUBAGENT_RESOLUTION_VERDICT_UNEXPECTED',
    category: 'precondition',
    messageTemplate:
      'Resolution verdicts were supplied ({supplied}) but no prior challenge is open for resolution.',
    recoverySteps: ['Omit challengeResolutionVerdicts when there is no open challenge to resolve.'],
  },
  {
    code: 'SUBAGENT_RESOLUTION_VERDICT_INCOHERENT',
    category: 'precondition',
    messageTemplate:
      'Resolution verdict {verdict} is incoherent with overall review verdict {overallVerdict} for challenge {challengeId}.',
    recoverySteps: [
      'When unable_to_review, omit resolution verdicts or report not_verified for known open challenges.',
    ],
  },
  {
    code: 'SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED',
    category: 'precondition',
    messageTemplate:
      'Acceptance is blocked: {unaddressed} prior failing challenge(s) (e.g. {challengeId}) have no author resolution for the current implementation digest.',
    recoverySteps: [
      'Record a resolution for each prior failing challenge against the current implementation digest and a passing validation attempt.',
      'Then obtain an independent reviewer verdict; author resolutions never close a challenge on their own.',
    ],
  },
  {
    code: 'SUBAGENT_CHALLENGE_CONTRADICTED',
    category: 'precondition',
    messageTemplate:
      'A {kind} falsification succeeded (outcome {outcome}); acceptance is not allowed while the artifact is contradicted.',
    recoverySteps: [
      'Return changes_requested and record the contradiction as a blocking issue.',
      'Do not accept an artifact that a challenge has contradicted.',
    ],
  },

  {
    code: 'SUBAGENT_PROMPT_EMPTY',
    category: 'precondition',
    messageTemplate: `The ${REVIEWER_SUBAGENT_TYPE} prompt is too short. Include the plan/implementation text, ticket text, iteration, and planVersion.`,
    recoverySteps: [
      `Provide a substantive prompt to the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      'Include the full review context: plan or implementation text, ticket text, iteration, and planVersion',
      'Re-invoke the subagent with the complete context',
    ],
  },

  {
    code: 'SUBAGENT_PROMPT_MISSING_CONTEXT',
    category: 'precondition',
    messageTemplate: `The ${REVIEWER_SUBAGENT_TYPE} prompt does not contain the expected review context. Include iteration and planVersion values from the FlowGuard tool response.`,
    recoverySteps: [
      'Read the iteration and planVersion values from the flowguard_plan or flowguard_implement response',
      `Include those exact values in the prompt to the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      'Re-invoke the subagent with the corrected prompt',
    ],
  },

  {
    code: 'SUBAGENT_PROMPT_ARTIFACT_MISSING',
    category: 'precondition',
    messageTemplate: `The ${REVIEWER_SUBAGENT_TYPE} prompt ends at the canonical instruction block with no artifact appended below it. A reviewer cannot review an empty subject.`,
    recoverySteps: [
      'Append the content to review below the final line of the canonical reviewerTaskPrompt',
      'Use the plan text, implementation diff, ADR, or reviewed branch diff as appropriate for the obligation',
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} subagent with the artifact included`,
    ],
  },

  {
    code: 'SUBAGENT_REVIEW_NOT_INVOKED',
    category: 'precondition',
    messageTemplate: `FlowGuard signaled INDEPENDENT_REVIEW_REQUIRED but no Task call to ${REVIEWER_SUBAGENT_TYPE} was detected. Call the subagent before submitting a verdict.`,
    recoverySteps: [
      `Call the ${REVIEWER_SUBAGENT_TYPE} subagent via the Task tool`,
      'Pass the plan/implementation text, ticket text, iteration, and planVersion in the prompt',
      'After the subagent returns, submit only reviewVerdict matching the captured reviewer verdict; do not submit reviewFindings',
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
    code: 'HOST_SUBAGENT_TASK_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Policy requires host-visible subagent invocation via the Task tool for {obligationId}, but no host evidence was found.',
    recoverySteps: [
      `Invoke the ${REVIEWER_SUBAGENT_TYPE} subagent via the OpenCode Task tool (subagent_type: "${REVIEWER_SUBAGENT_TYPE}")`,
      `Ensure the build agent has task permission: { "*": "deny", "${REVIEWER_SUBAGENT_TYPE}": "allow" }`,
      'After the subagent returns ReviewFindings, submit the verdict with reviewFindings',
    ],
  },

  {
    code: 'SUBAGENT_TYPE_UNAUTHORIZED',
    category: 'precondition',
    messageTemplate: `Subagent type '{subagentType}' is not authorized by FlowGuard governance. Only ${REVIEWER_SUBAGENT_TYPE} is allowed.`,
    recoverySteps: [
      `Use the ${REVIEWER_SUBAGENT_TYPE} subagent type for reviewer Task calls`,
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

  {
    code: 'REVIEWER_TASK_REQUIRES_PENDING_OBLIGATION',
    category: 'precondition',
    messageTemplate:
      'A flowguard-reviewer Task may only run when a pending review obligation exists. Run flowguard_plan or flowguard_review first to create a pending review obligation, then start the reviewer Task.',
    recoverySteps: [
      'Run the relevant FlowGuard review tool (flowguard_plan, flowguard_review, or flowguard_review_implementation) first',
      `Wait for the tool response to signal INDEPENDENT_REVIEW_REQUIRED before starting the ${REVIEWER_SUBAGENT_TYPE} Task`,
      'Do not start reviewer Tasks speculatively before a review obligation has been created',
    ],
  },
];
