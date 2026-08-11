/**
 * Review and subagent validation reasons.
 *
 * @internal — do not import directly. Part of VALIDATION_REASONS
 *             in reasons-validation.ts.
 */

import type { BlockedReason } from './reasons-types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

export const REVIEW_VALIDATION_REASONS = [
  {
    code: 'IMPL_VALIDATION_EVIDENCE_REQUIRED',
    category: 'state',
    messageTemplate:
      'Implementation review cannot be accepted: active verification checks have no passing execution evidence for the current implementation ({message}). Reviewer acceptance is gated on executed validation, not review verdict alone.',
    recoverySteps: [
      'Run flowguard_run_check for each active check in IMPL_VALIDATION until all pass',
      'Re-record the implementation with flowguard_implement if the code changed, then re-run checks',
      'Only submit reviewVerdict: "accept" after every active check has passing execution evidence',
    ],
  },

  {
    code: 'SUBAGENT_REVIEW_REQUIRED',
    category: 'input',
    messageTemplate: `reviewFindings must come from ${REVIEWER_SUBAGENT_TYPE} subagent. The findings provided do not contain evidence of subagent origin.`,
    recoverySteps: [
      `Call Task tool with subagent_type: "${REVIEWER_SUBAGENT_TYPE}"`,
      'Pass the subagent output as reviewFindings',
      `Ensure findings include reviewedBy.sessionId containing "${REVIEWER_SUBAGENT_TYPE}" or attestation.reviewedBy === "${REVIEWER_SUBAGENT_TYPE}"`,
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
    code: 'REVIEW_TRANSPORT_EVIDENCE_INVALID',
    category: 'state',
    messageTemplate: 'External review evidence transport is invalid: {reason}',
    recoverySteps: [
      'Regenerate ReviewFindings from the flowguard-reviewer agent or subagent',
      'Ensure the transport JSON contains a complete ReviewFindings object with obligation attestation',
      'Do not treat review-evidence file presence as review approval',
    ],
  },

  {
    code: 'REVIEW_FINDINGS_HASH_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted review findings do not match the persisted subagent invocation evidence for obligation {obligationId}.',
    recoverySteps: [
      'Discard the modified review findings',
      `Use the exact ReviewFindings returned by the fulfilled ${REVIEWER_SUBAGENT_TYPE} invocation`,
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
      `Rerun the ${REVIEWER_SUBAGENT_TYPE} subagent if the findings came from a different session`,
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
    messageTemplate: `Submitted reviewFindings.reviewedBy.sessionId ({provided}) does not match the actual subagent session ({expected}). Findings must come from the invoked ${REVIEWER_SUBAGENT_TYPE}.`,
    recoverySteps: [
      `Use the exact reviewFindings object returned by the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      'Do not modify reviewedBy.sessionId after the subagent produces the findings',
      'Re-invoke the subagent if the findings came from a different session',
    ],
  },

  {
    code: 'REVIEW_ITERATION_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted review findings target iteration {provided}, but the active review obligation expects iteration {expected}.',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} reviewer for the active obligation`,
      'Submit findings whose iteration matches the reviewObligationIteration from the current FlowGuard response',
      'Do not reuse review findings from a previous iteration',
    ],
  },

  {
    code: 'REVIEW_PLAN_VERSION_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted review findings target plan version {provided}, but the active review obligation expects plan version {expected}.',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} reviewer for the active plan version`,
      'Submit findings whose planVersion matches the reviewObligationPlanVersion from the current FlowGuard response',
      'Do not reuse review findings from an older plan version',
    ],
  },

  {
    code: 'REVIEW_MODE_SELF_NOT_ALLOWED',
    category: 'state',
    messageTemplate:
      'Review findings must come from the independent reviewer subagent; reviewMode=self is not accepted.',
    recoverySteps: [
      `Invoke the ${REVIEWER_SUBAGENT_TYPE} reviewer subagent`,
      'Submit only reviewFindings with reviewMode=subagent',
      'Do not use self-review findings to satisfy an independent review obligation',
    ],
  },

  {
    code: 'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted reviewFindings.overallVerdict ({provided}) does not match the actual subagent verdict ({expected}). Findings must not be modified.',
    recoverySteps: [
      `Submit the verdict exactly as the ${REVIEWER_SUBAGENT_TYPE} subagent returned it`,
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
      `Submit the exact reviewFindings object returned by the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      'Do not add, remove, or modify blockingIssues entries after the subagent produces them',
      'Re-invoke the subagent if the captured findings are stale',
    ],
  },

  {
    code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
    category: 'state',
    messageTemplate:
      'overallVerdict "accept" is incoherent with {count} blocking issue(s). An accepted review must contain no blocking issues. Return a non-accept verdict or remove/reclassify the findings after resolving the inconsistency.',
    recoverySteps: [
      'Return a non-accept verdict (changes_requested, or unable_to_review where the artifact is genuinely unreviewable) when blocking issues are present',
      'Or resolve the inconsistency and re-run the review so the reviewer emits coherent findings',
      'Do not accept a review whose findings still report blocking issues',
    ],
  },

  {
    code: 'SUBAGENT_EVIDENCE_REUSED',
    category: 'state',
    messageTemplate:
      'Subagent invocation evidence has already been consumed for this obligation. Each obligation requires a fresh invocation.',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} subagent for the current obligation`,
      'Do not reuse findings from a previously consumed invocation',
      'Each plan version and review iteration requires its own subagent invocation',
    ],
  },

  {
    code: 'REVIEW_SELF_APPROVAL_DENIED',
    category: 'state',
    messageTemplate:
      'Manual-attested review findings must come from a different reviewer session than the governed parent session.',
    recoverySteps: [
      `Invoke the ${REVIEWER_SUBAGENT_TYPE} reviewer in a distinct session`,
      'Do not submit reviewFindings authored by the same session that performed the governed work',
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
    code: 'SUBAGENT_EVIDENCE_MISSING',
    category: 'state',
    messageTemplate: `No persisted ${REVIEWER_SUBAGENT_TYPE} invocation evidence was found for review obligation {obligationId}. Strict review cannot approve without a fulfilled reviewer invocation.`,
    recoverySteps: [
      `Invoke the ${REVIEWER_SUBAGENT_TYPE} reviewer subagent for the active obligation before submitting a verdict`,
      'Submit the exact reviewFindings returned by that invocation',
      'Run /continue to restore enforcement state if the invocation evidence is missing after a reload',
    ],
    quickFixCommand: '/continue',
  },

  {
    code: 'SUBAGENT_MANDATE_MISMATCH',
    category: 'state',
    messageTemplate:
      'The persisted subagent invocation evidence is bound to a different obligation than the active review obligation {obligationId}.',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} reviewer for the current obligation`,
      'Do not submit invocation evidence captured for a previous obligation, iteration, or plan version',
      'Run /continue to confirm the active obligation before retrying the verdict',
    ],
    quickFixCommand: '/continue',
  },

  {
    // RETAINED, NO LONGER EMITTED. The plan and architecture review loops used
    // to hard-block here when the iteration budget was exhausted without an
    // approving verdict. That stranded human-gated sessions at the review gate
    // with an inadmissible "/plan" recovery. They now force-converge to the
    // review gate (human decides) or finalize in auto-approve modes — parity
    // with the implementation-review flow. This reason is kept for registry and
    // changelog stability; reintroduce an emitter only with a coherent recovery.
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
    messageTemplate: `The ${REVIEWER_SUBAGENT_TYPE} subagent reported it is unable to review obligation {obligationId} ({reason}). The review loop did NOT converge. This is a tool-failure signal (not a substantive finding) and is reserved for cases where the reviewer cannot honestly evaluate the input — for example malformed plan/implementation text, missing required context references, an unrecoverable structured-output schema violation, or a corrupted/mismatched mandate digest. Substantive concerns must be expressed as changes_requested instead.`,
    recoverySteps: [
      'Do NOT retry the same submission — the reviewer has already declared the input unreviewable',
      'Inspect reviewFindings.missingVerification[] and reviewFindings.unknowns[] for the specific tool-failure cause',
      'Submit a fresh /plan or /implement (this resets the iteration counter to 0 and starts a new obligation)',
      'If the cause is a corrupted mandate digest or template hash mismatch, re-hydrate the session before retrying',
    ],
  },

  // ─── Verification Execution Reasons (flowguard_run_check) ───────────────────

  {
    code: 'CHECK_KIND_NOT_AVAILABLE',
    category: 'input',
    messageTemplate:
      'Verification kind "{kind}" has no discovered command. Only kinds with discovered commands in verificationCandidates can be executed.',
    recoverySteps: [
      'Run flowguard_status to see available verificationCandidates',
      'Only request kinds that have a discovered command',
      'Re-run discovery if the expected kind should be available',
    ],
  },

  {
    code: 'CHECK_NOT_ACTIVE',
    category: 'state',
    messageTemplate:
      'Check "{checkId}" is not in activeChecks for this session. Active checks: {activeChecks}.',
    recoverySteps: [
      'Run flowguard_status to see activeChecks',
      'Only execute checks listed in activeChecks',
      'Re-hydrate if the check list needs updating',
    ],
  },

  // ─── Validation Evidence Enforcement (#400) ─────────────────────────────────

  {
    code: 'VALIDATION_EVIDENCE_REQUIRED',
    category: 'admissibility',
    messageTemplate:
      'Policy requires validation evidence before progressing past VALIDATION, but no Discovery-derived verification commands are active. VALIDATION must not pass vacuously under this policy.',
    recoverySteps: [
      'Re-run discovery and flowguard_hydrate so repo-native verification commands are detected',
      'Execute the discovered checks with flowguard_run_check (the runtime-executed verification tool that records pass/fail evidence)',
      'If this repository genuinely has no verification commands, set validationEvidence.allowNoCommands=true in policy with explicit governance approval (the only sanctioned exception)',
    ],
  },

  {
    code: 'VALIDATION_EVIDENCE_UNVERIFIED',
    category: 'admissibility',
    messageTemplate:
      'Policy requires validation evidence but Discovery is not trustworthy, so the absence of verification commands cannot be verified (NOT_VERIFIED). VALIDATION is blocked fail-closed rather than asserting false certainty.',
    recoverySteps: [
      'Run flowguard_hydrate to restore trustworthy Discovery (clear health gate, clean drift, persisted summary and digest)',
      'Resolve any blocked discoveryHealthGate before retrying VALIDATION',
      'Do not treat an empty active-check list as a verified pass while Discovery health is unverified',
    ],
  },

  {
    code: 'VALIDATION_EVIDENCE_STACK_NO_COMMANDS',
    category: 'admissibility',
    messageTemplate:
      'Discovery detected a technology stack for this repository, but no verification commands were derived, so VALIDATION cannot pass vacuously. A detected stack with zero active checks is treated as a mis-detection hazard, not a verified "no commands" property.',
    recoverySteps: [
      'Re-run flowguard_hydrate so repo-native verification commands (build/test/lint) are detected from the stack',
      'Ensure the stack wrapper/manifest (package.json scripts, mvnw/gradlew, pyproject) is at the resolved worktree root',
      'If this stack genuinely has no verification commands, set validationEvidence.allowNoCommands=true in policy with explicit governance approval (the only sanctioned exception)',
    ],
  },

  // ─── Auto-Advance Safety Guard (#428) ───────────────────────────────────────

  {
    code: 'AUTO_ADVANCE_OVERFLOW',
    category: 'state',
    messageTemplate:
      'Auto-advance exceeded the maximum step limit ({limit}) at phase {phase}; the workflow topology may be non-terminating. No partial state was persisted (fail-closed).',
    recoverySteps: [
      'Run flowguard_status to inspect the current phase and evidence',
      'Report this as a topology defect: a phase chain advanced more than the allowed number of steps without settling',
      'Do not retry the command until the misconfigured transition path is fixed',
    ],
  },
  // ─── Review Finding Subject-Scope Enforcement ───────────────────────────

  {
    code: 'REVIEW_SUBJECT_NOT_MATERIALIZED',
    category: 'state',
    messageTemplate:
      'Standalone review cannot create obligation {obligationId} because the reviewed subject was not materialized and frozen.',
    recoverySteps: [
      'Provide exactly one supported review source and resolve it successfully',
      'Do not create or continue a review obligation until immutable subject material is available',
    ],
  },

  {
    code: 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE',
    category: 'state',
    messageTemplate: 'Review obligation {obligationId} has no verifiable frozen subject scope.',
    recoverySteps: [
      'Re-run the review after subject scope resolution succeeds',
      'Do not bind findings until the reviewed revision or artifact subject is frozen',
    ],
  },

  {
    code: 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} lacks a valid structured subject anchor for obligation {obligationId}.',
    recoverySteps: [
      'Provide at least one structured subject anchor tied to the reviewed subject',
      'Keep supporting repository evidence in evidenceLocations',
    ],
  },
  {
    code: 'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} has an evidence location that escapes the repository for obligation {obligationId}.',
    recoverySteps: [
      'Use evidenceLocations paths that remain below the repository root at the frozen base or head revision',
      'Remove leading or resolving parent-directory segments that escape the repository',
    ],
  },
  {
    code: 'REVIEW_EVIDENCE_LOCATION_INVALID',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} has an invalid repository evidence location for obligation {obligationId}.',
    recoverySteps: [
      'Provide evidenceLocations as repository-relative paths at the frozen base or head revision',
      'Keep the valid subject anchor tied to the reviewed subject',
    ],
  },
  {
    code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} has no subject anchor in the frozen reviewed subject for obligation {obligationId}.',
    recoverySteps: [
      'Anchor the finding to the reviewed change or artifact section',
      'Put unrelated observations in scopeCreep instead of blockingIssues or majorRisks',
    ],
  },
  {
    code: 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} cites a repository revision unavailable for obligation {obligationId}.',
    recoverySteps: [
      'Use only the frozen base or head revision available to the reviewed subject',
      'Re-run the review if the required revision provenance could not be resolved',
    ],
  },
] as const satisfies readonly BlockedReason[];
