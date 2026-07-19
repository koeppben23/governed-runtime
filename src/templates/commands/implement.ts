import { GOVERNANCE_RULES } from './shared-rules.js';
import {
  SHARED_REVIEW_LOOP,
  DISCOVERY_REVIEW_CAPTURE,
  DISCOVERY_REVIEW_DONE_WHEN,
} from './shared-review-loop.js';

export const IMPLEMENT_COMMAND = `
---
description: Implement the approved plan and review the implementation.
agent: build
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Implement the approved plan and obtain mandatory independent implementation review.

## Steps

### Phase 1: Check State

1. Call \`flowguard_status\` to verify the session is in IMPLEMENTATION phase with a ticket, approved plan, and passed validation.
   - If any precondition is not met: report it and stop.
${DISCOVERY_REVIEW_CAPTURE}

### Phase 2: Implement

2. Use the approved plan authored in the /plan step as the source of truth. Identify the numbered
   steps and files to modify. (The plan body is NOT included in the flowguard_status response —
   status only confirms \`hasPlan\`/\`planVersion\` and the phase. If the plan text is no longer
   available in this conversation context, run \`/help\` first to verify the session state and
   artifact digest, then call \`flowguard_help({ view: "context", includeArtifactContent: true })\`
   to retrieve the complete canonical plan content. Use ONLY the returned content — do not
   reconstruct or infer plan details from metadata alone.)
3. Execute each step in order:
   - Use \`read\` to examine existing files before modifying.
   - Use \`write\` or \`edit\` to create or modify files.
   - Use \`bash\` for commands (install dependencies, run formatters, etc.).
   - Follow the plan steps exactly — add nothing beyond what the plan specifies.
 4. After completing ALL plan steps, call \`flowguard_implement({})\` with no arguments.
    - The tool auto-detects changed files via git and records evidence.
    - The session advances to IMPL_VALIDATION.

### Phase 3: Post-Implementation Validation

 5. Call \`flowguard_status\` again with NO focused flags (no whyBlocked/evidence/context/readiness)
    to get the full projection, then read \`activeChecks\` (equivalently \`remainingChecks\` in
    IMPL_VALIDATION) and \`verificationCandidates\`. The session is now in IMPL_VALIDATION after
    recording evidence.
    - If both \`activeChecks\`/\`remainingChecks\` and \`verificationCandidates\` are empty:
      report no active checks and stop — the IMPL_REVIEW gate cannot be reached without
      canonical check execution. Surface the current \`nextAction\` from status.
    - If \`activeChecks\`/\`remainingChecks\` is non-empty: for each kind, call
      \`flowguard_run_check({ kind: "<kind>" })\`.
    - If \`activeChecks\`/\`remainingChecks\` is empty but \`verificationCandidates\` is non-empty:
      for each kind in \`verificationCandidates\`, call
      \`flowguard_run_check({ kind: "<kind>" })\` — it validates the kind against canonical
      state, not against the status output.
    - After running all checks, check the FINAL \`flowguard_run_check\` response: only proceed
      to Phase 5 if the response phase is \`IMPL_REVIEW\`. Never assume IMPL_REVIEW without
      a confirming runtime response.
    - Any check fails → routes back to IMPLEMENTATION. Fix the code, then call
      \`flowguard_implement({})\` again to re-record evidence (return to Phase 2 step 4).
    - Executor timeout/error on a single check → retry that \`flowguard_run_check({ kind })\`
      exactly once. If it fails again, stop and report the error — do not retry unbounded.

### Phase 4: Record Verification Evidence

 6. Write a \`## Verification Evidence\` section distinguishing:
    - **Planned checks**: Each check from the plan's Verification Plan.
    - **Executed checks**: Only checks actually run. Mark unexecuted checks as NOT_VERIFIED.

### Phase 5: Implementation Review Loop

 7. Read the \`next\` field from the tool response and follow its instructions exactly:
${SHARED_REVIEW_LOOP({
  toolName: 'flowguard_implement',
  verdictToolName: 'flowguard_review_implementation',
  artifactName: 'implementation',
  reviseParams: '',
  changesRequestedExtra:
    '\n       Then make the code changes based on blockingIssues, then call flowguard_implement({}) again to re-record.',
  strictRecoveryCall: 'flowguard_implement({})',
  strictRecoveryVerb: 'Re-record',
  strictRecoveryNoun: 're-recordings',
  iterationNote: '(max 3 iterations)',
  repeatStep: 7,
  subagentExtra: '',
  fallbackExtra: '',
  unableDescription:
    'e.g., contradictory plan vs. code, missing prerequisites, or scope ambiguity that prevents critique',
  unableRecoveryA: 'revise the plan via /plan first',
  unableRecoveryB:
    'record substantially-new implementation evidence (new flowguard_implement({}) call after additional code changes, which starts a fresh review obligation)',
})}

## Rules

- Follow the approved plan exactly — no deviations or additions.
- Record evidence with \`flowguard_implement({})\` (no arguments) BEFORE starting the review loop.
- After \`flowguard_implement({})\`, auto-run \`flowguard_run_check\` — do not skip IMPL_VALIDATION.
- When changes are requested in the review loop: make the actual code changes, then re-record
  with \`flowguard_implement({})\` (which advances to IMPL_VALIDATION and triggers the auto-chain
  again).
- In Verification Evidence, list only checks that were actually executed. Mark all others as NOT_VERIFIED.
- Follow profile rules from \`flowguard_status\` when implementing.
- Do not call flowguard_plan during /implement — planning is complete.
- Do not auto-chain into /review-decision after implementation — the user decides.

## Example (correct tool sequences)

Happy path:
1. \`flowguard_status\` → phase: IMPLEMENTATION, plan approved
2. (execute plan steps: read/write/edit/bash)
3. \`flowguard_implement({})\` → records evidence, session advances to IMPL_VALIDATION
4. \`flowguard_status\` (unfocused) → read \`activeChecks\`
5. \`flowguard_run_check({ kind: "<kind>" })\` for each active check → passes, advances to IMPL_REVIEW
6. (review loop) \`flowguard_review_implementation({ reviewVerdict: "accept" })\` → EVIDENCE_REVIEW (user gate — the USER approves via /review-decision; this call does NOT approve the implementation)

Revision path (when review returns changes_requested):
1. \`flowguard_review_implementation({ reviewVerdict: "changes_requested" })\` → routes back to IMPLEMENTATION
2. (fix code based on blockingIssues)
3. \`flowguard_implement({})\` → re-records evidence, advances to IMPL_VALIDATION
4. \`flowguard_status\` (unfocused) → read \`activeChecks\`
5. \`flowguard_run_check({ kind: "<kind>" })\` for each active check → passes, advances to IMPL_REVIEW
6. (review loop) \`flowguard_review_implementation({ reviewVerdict: "accept" })\` → EVIDENCE_REVIEW (user gate)

${GOVERNANCE_RULES}
## Presentation

- If the response contains a \`reviewCard\` field, display its markdown verbatim — never summarize, truncate, or omit it.
- The reviewCard contains the formatted implementation review with findings, verdict, and next actions.
- This is mandatory output: the user relies on it to make their review decision.

## Done-when

- All plan steps are implemented as code changes.
- Verification Evidence distinguishes Planned from Executed checks.
- Implementation evidence is recorded via flowguard_implement.
- Independent review loop has converged.
${DISCOVERY_REVIEW_DONE_WHEN}
- If \`reviewCard\` is present in the tool response, it is displayed verbatim in the output.
- On the converged path: phase has advanced to EVIDENCE_REVIEW and the response ends with \`Next action: run /review-decision approve, /review-decision changes_requested, or /review-decision reject.\`
- On a blocked path (review not converged, reviewer unavailable, or a FlowGuard error code): no \`/review-decision\` next action is emitted; the response surfaces the FlowGuard blocker and its recovery instead.
`;
