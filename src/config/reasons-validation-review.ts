import type { BlockedReason } from './reasons-types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

export const REVIEW_VALIDATION_REASONS = [
  {
    code: 'IMPLEMENTATION_REVIEW_EVIDENCE_REQUIRED',
    category: 'state',
    messageTemplate:
      'A governance override for the implementation requires the bound independent review result, but no implementation review result is recorded.',
    recoverySteps: [
      'Record the implementation and run the independent implementation review before deciding',
      'Do not approve an implementation that has no bound review evidence',
    ],
  },
  {
    code: 'IMPLEMENTATION_REVIEW_SUBJECT_MISMATCH',
    category: 'state',
    messageTemplate:
      'The recorded implementation review covers a different revision (reviewed {reviewedDigest}, current {currentDigest}). A review can never authorize a different revision.',
    recoverySteps: [
      'Re-record the current implementation and run a fresh independent review for it',
      'Never approve a revision that was not the reviewed subject',
    ],
  },
  {
    code: 'REVIEW_STATE_INCOMPLETE',
    category: 'state',
    messageTemplate:
      'Review state has neither a pending reviewer obligation nor a persisted report and cannot be completed.',
    recoverySteps: [
      'Inspect the session state and audit trail before further workflow actions',
      'Abort the session if the missing review state cannot be recovered from trusted evidence',
    ],
  },
  {
    code: 'REVIEW_BRANCH_PROVENANCE_MISSING',
    category: 'input',
    messageTemplate: 'Branch review requires resolved immutable base and head commit provenance.',
    recoverySteps: [
      'Provide a branch and base that both resolve to commits in the current worktree',
      'For local repositories, ensure the branch and base refs exist; no remote is required',
    ],
  },
  {
    code: 'REVIEW_REPOSITORY_IDENTITY_MISSING',
    category: 'state',
    messageTemplate:
      'Branch review cannot freeze a reviewed subject without a repository identity: {reason}.',
    recoverySteps: [
      'Re-run the review from its original content input so the repository identity is resolved again',
      'Ensure the worktree is a git repository; a repository without a parseable remote resolves to a local identity',
      'Do not submit a verdict to recover this state',
    ],
  },
  {
    code: 'REVIEW_SUBJECT_DIGEST_MISMATCH',
    category: 'state',
    messageTemplate:
      'Re-derived review subject does not match the frozen obligation subject ({reason}). The reviewed subject is immutable once frozen.',
    recoverySteps: [
      'Do not submit a verdict for a subject that differs from the reviewed one',
      'Start a new review for the changed content instead of continuing this obligation',
    ],
  },
  {
    code: 'REVIEW_URL_CONTENT_ENCODING_INVALID',
    category: 'input',
    messageTemplate: 'URL review content could not be materialized as strict UTF-8: {reason}.',
    recoverySteps: [
      'Serve the reviewed URL as valid UTF-8, with charset=utf-8 when a charset is declared',
      'Provide the content directly as review text if the source uses another encoding',
    ],
  },
  {
    code: 'REVIEW_GENERATION_MISMATCH',
    category: 'state',
    messageTemplate:
      'Review obligation generation does not match the current reviewer criteria or mandate generation. The stale obligation was not executed.',
    recoverySteps: [
      'Re-hydrate the session or start a fresh review cycle so FlowGuard creates an obligation with current reviewer semantics',
      'Do not execute, attest, or submit findings for the stale obligation',
    ],
  },
  {
    code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
    category: 'state',
    messageTemplate:
      'Frozen review material integrity verification failed: {reason}. The reviewer was not invoked.',
    recoverySteps: [
      'Do not re-run the reviewer: the persisted material no longer matches its frozen digest binding',
      'Restore the persisted review obligation and material from a trusted source',
      'Abort the session if the frozen material cannot be restored from trusted evidence',
    ],
  },
  {
    code: 'REVIEW_ATTEMPT_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'No bindable review attempt exists for obligation {obligationId}: {reason}. The frozen review material itself was not invalidated.',
    recoverySteps: [
      'Re-run the originating FlowGuard command for the same frozen subject so an available bindable attempt can be re-emitted',
      'An obligation with no bindable attempt is deterministically closed; submit the artifact again to mint a fresh review obligation',
      'Do NOT submit a verdict to recover this state',
    ],
  },
  {
    code: 'REVIEWER_CONTEXT_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'The canonical reviewer context could not be materialized for obligation {obligationId}: {reason}. No review attempt was created.',
    recoverySteps: [
      'Restore the persisted Discovery basis or resolve the workspace fingerprint, then re-run the review',
      'A degraded or unchecked Discovery snapshot does NOT block: only a structurally unbuildable reviewer context does',
      'Do NOT free-compose a reviewer prompt without the canonical context, and do NOT fabricate findings',
    ],
  },
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
    messageTemplate: `Independent review evidence must come from a host-observed structured ${REVIEWER_SUBAGENT_TYPE} reviewer child session. The supplied evidence does not establish that origin.`,
    recoverySteps: [
      'Re-run the originating FlowGuard command so the host can create the reviewer child session',
      'Submit only the bound reviewVerdict; FlowGuard resolves the host-observed structured reviewer evidence automatically',
      'Do not submit, copy, or reconstruct reviewer findings',
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
      'Choose your workflow: /task (development), /architecture (ADR), /review (compliance/content)',
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
    messageTemplate:
      'Review evidence could not be established from a host-observed structured reviewer invocation: {reason}',
    recoverySteps: [
      'Re-run the originating FlowGuard command so the host can create a fresh reviewer child session',
      'Do not treat reviewer-evidence file presence or reconstructed findings as review approval',
      'Do not submit, copy, or reconstruct reviewer findings',
    ],
  },

  {
    code: 'REVIEW_FINDINGS_HASH_MISMATCH',
    category: 'state',
    messageTemplate:
      'Captured reviewer findings do not match the persisted reviewer invocation evidence for obligation {obligationId}.',
    recoverySteps: [
      'Do not submit a verdict from the mismatched capture',
      'Re-run the originating FlowGuard command to authorize a fresh reviewer child session',
      'If the evidence is stale, re-run the review for the current obligation',
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
      'Re-run the FlowGuard tool that produced the review obligation (flowguard_plan, flowguard_implement, flowguard_architecture, or flowguard_review)',
      'Verify the response contains the reviewObligation field with iteration and planVersion',
      'If the issue persists in regulated mode, re-hydrate the session',
    ],
    quickFixCommand: '/continue',
  },

  {
    code: 'SUBAGENT_SESSION_MISMATCH',
    category: 'state',
    messageTemplate: `Captured reviewer session id ({provided}) does not match the invoked ${REVIEWER_SUBAGENT_TYPE} child session ({expected}). Findings must come from the host-observed reviewer invocation.`,
    recoverySteps: [
      'Do not modify or reconstruct reviewer output',
      'Re-run the originating FlowGuard command if the captured findings came from a different session',
    ],
  },

  {
    code: 'REVIEW_ITERATION_MISMATCH',
    category: 'state',
    messageTemplate:
      'Captured reviewer findings target iteration {provided}, but the active review obligation expects iteration {expected}.',
    recoverySteps: [
      `Re-run the originating FlowGuard command so the host creates a fresh ${REVIEWER_SUBAGENT_TYPE} reviewer child session for the active obligation`,
      'Do not submit a verdict while the captured reviewer evidence targets a different iteration',
      'Do not reuse captured findings from a previous iteration',
    ],
  },

  {
    code: 'REVIEW_PLAN_VERSION_MISMATCH',
    category: 'state',
    messageTemplate:
      'Captured reviewer findings target plan version {provided}, but the active review obligation expects plan version {expected}.',
    recoverySteps: [
      `Re-run the originating FlowGuard command so the host creates a fresh ${REVIEWER_SUBAGENT_TYPE} reviewer child session for the active plan version`,
      'Do not submit a verdict while the captured reviewer evidence targets a different plan version',
      'Do not reuse captured findings from an older plan version',
    ],
  },

  {
    code: 'REVIEW_MODE_SELF_NOT_ALLOWED',
    category: 'state',
    messageTemplate:
      'Review findings must come from a host-observed structured independent reviewer subagent invocation; reviewMode=self is not accepted.',
    recoverySteps: [
      'Re-run the originating FlowGuard command so the host can create the reviewer child session',
      'Submit only the bound reviewVerdict; FlowGuard resolves the host-observed structured reviewer evidence automatically',
      'Do not use self-review findings to satisfy an independent review obligation',
    ],
  },

  {
    code: 'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted reviewVerdict ({provided}) does not match the captured reviewer verdict ({expected}). The captured reviewer evidence must not be overridden.',
    recoverySteps: [
      `Submit the verdict exactly as the host-captured ${REVIEWER_SUBAGENT_TYPE} result records it`,
      'Do not override the captured reviewer verdict with a different value',
      'If you disagree with the reviewer verdict, run another review iteration with revised input',
    ],
  },

  {
    code: 'SUBAGENT_FINDINGS_ISSUES_MISMATCH',
    category: 'state',
    messageTemplate:
      'Captured reviewer blockingIssues count ({provided}) does not match the actual subagent count ({expected}).',
    recoverySteps: [
      'Do not add, remove, or modify blockingIssues after the reviewer produces them',
      'Re-run the originating FlowGuard command if the captured findings are stale',
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
      'Review findings must come from a reviewer child session distinct from the governed parent session.',
    recoverySteps: [
      `Re-run the originating FlowGuard command so the host creates an independent ${REVIEWER_SUBAGENT_TYPE} reviewer child session`,
      'Do not submit findings authored by the same session that performed the governed work',
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
      'Submit only the bound reviewVerdict; the host resolves the host-observed structured reviewer evidence automatically',
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
      'Do not submit a verdict for invocation evidence captured for a previous obligation, iteration, or plan version',
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
      'If the policy limit is too restrictive, adjust reviewBudget in the policy configuration',
    ],
  },

  {
    code: 'SUBAGENT_UNABLE_TO_REVIEW',
    category: 'state',
    messageTemplate: `The ${REVIEWER_SUBAGENT_TYPE} subagent reported it is unable to review obligation {obligationId} ({reason}). The review loop did NOT converge. This is a tool-failure signal (not a substantive finding) and is reserved for cases where the reviewer cannot honestly evaluate the input — for example malformed plan/implementation text, missing required context references, an unrecoverable structured-output schema violation, or a corrupted/mismatched mandate digest. Substantive concerns must be expressed as changes_requested instead.`,
    recoverySteps: [
      'Do NOT retry the same submission — the reviewer has already declared the input unreviewable',
      'Inspect the captured reviewer findings (missingVerification[], unknowns[]) for the specific tool-failure cause',
      'Submit a fresh /plan or /implement (this resets the iteration counter to 0 and starts a new obligation)',
      'If the cause is a corrupted mandate digest or template hash mismatch, re-hydrate the session before retrying',
    ],
  },

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
  // ─── Reviewer Evidence Observation ───────────────────────────────────────

  {
    code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
    category: 'state',
    messageTemplate:
      'Reviewer finding evidenceLocations for obligation {obligationId} have no matching authoritative repository observation: {reason}. The location is structurally valid but was not observably obtained by this reviewer attempt.',
    recoverySteps: [
      'A repository evidenceLocation is admissible only when the exact frozen bytes were obtained through flowguard_observe_repository during the binding reviewer attempt',
      'This is a governance rejection (evidence_unavailable) — it is never repairable by resubmitting findings',
      'Start a fresh review attempt and cite only locations the reviewer observes through the sanctioned observation tool',
      'Do NOT substitute worktree reads, recalled content, or citations without a matching observation',
    ],
  },
  {
    code: 'REVIEW_VERDICT_EVIDENCE_MISSING',
    category: 'state',
    messageTemplate:
      'reviewVerdict submitted for obligation {obligationId} has no matching bound ReviewInvocationEvidence. A verdict cannot be accepted without captured reviewer evidence.',
    recoverySteps: [
      'Run the flowguard-reviewer subagent for the active obligation before submitting a verdict',
      'Do NOT submit a verdict without the reviewer having produced independently captured findings',
    ],
  },
  {
    code: 'REVIEW_VERDICT_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted reviewVerdict ({provided}) does not match the captured reviewer overallVerdict ({expected}) for obligation {obligationId}.',
    recoverySteps: [
      'Submit reviewVerdict exactly matching the reviewer subagent overallVerdict',
      'Do NOT override the reviewer verdict — it is the independent reviewer result, not user approval',
      'If you disagree with the verdict, run another review iteration with revised input',
    ],
  },
  {
    code: 'INVALID_REVIEW_TOOL_SEQUENCE',
    category: 'state',
    messageTemplate:
      'Review tool invocation sequence is invalid for obligation {obligationId}: {reason}.',
    recoverySteps: [
      'Follow the review invocation sequence documented in the review instructions',
      'Do NOT submit reviewerUnavailable when a host-observed reviewer invocation already exists',
      'Submit only the reviewVerdict; the host resolves the bound structured reviewer evidence',
    ],
  },
  {
    code: 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'The reviewer child session completed without a host-owned execution provenance record. Its output cannot bind to a review obligation.',
    recoverySteps: [
      'Re-run the originating FlowGuard command to authorize a fresh reviewer dispatch',
      'Do not reuse the prior reviewer output or submit copied findings',
    ],
  },
  {
    code: 'REVIEW_DISPATCH_PERSISTENCE_FAILED',
    category: 'state',
    messageTemplate:
      'The durable reviewer dispatch could not be persisted before the host release. The reviewer was NOT executed and no evidence exists.',
    recoverySteps: [
      'Retry the originating FlowGuard command; the reviewer was not executed and no findings were produced',
      'Ensure the session state is writable and re-hydrate the session if the write lock is contended',
      'Do NOT treat this as a reviewer failure and do NOT submit fabricated findings',
    ],
  },
] as const satisfies readonly BlockedReason[];
