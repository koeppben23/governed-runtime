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
   - FIRST confirm this is a git repository (e.g. \`git rev-parse --is-inside-work-tree\` in the
     worktree). Implementation evidence is git-derived: the runtime blocks every mutating host tool
     with \`NOT_GIT_REPO\` in a non-Git worktree, and \`flowguard_implement\` cannot record evidence
     there. If this is not a git repository, STOP and report it — the user must initialize git
     OUTSIDE this session and start a fresh \`/hydrate\` (establishing a new implementation baseline)
     before implementation can proceed. Do NOT run \`git init\` inside this session: a session
     hydrated without git has no baseline, and recording afterwards would attribute the entire
     pre-existing project to this implementation.
   - Use \`read\` to examine existing files before modifying.
   - Use \`write\` or \`edit\` to create or modify files.
   - Use \`bash\` for commands (install dependencies, run formatters, etc.).
   - Follow the plan steps exactly — add nothing beyond what the plan specifies.
 4. After completing ALL plan steps, call \`flowguard_implement({})\` with no arguments.
    - The tool records evidence and auto-advances the state machine. It can cross MULTIPLE
      phases in one call — e.g. straight past IMPL_VALIDATION into IMPL_REVIEW (a
      policy-permitted zero-check transition) or into EVIDENCE_REVIEW (reduced ceremony).
    - Dispatch on the RETURNED \`phase\` field of the tool response; the returned phase is
      authoritative, never an assumed sequence:
      - \`EVIDENCE_REVIEW\`: display \`presentation.markdown\` (or the legacy \`reviewCard\`)
        verbatim and STOP. No checks, no reviewer, no further steps — this is the user gate.
      - \`COMPLETE\`: terminal — the workflow reached a policy-permitted final phase
        without a human gate (e.g. automatic approval under reduced ceremony). Display any
        returned presentation verbatim and STOP.
      - \`IMPL_REVIEW\`: validation already passed. Go DIRECTLY to Phase 5 (review loop) and
        continue automatically — do not stop and do not treat the session as IMPL_VALIDATION.
      - \`IMPLEMENTATION\` or \`error\`/\`blocked\`: follow the exact recovery in the tool
        response and STOP; never invent the next phase.
      - \`IMPL_VALIDATION\`: continue to Phase 3.

### Phase 3: Post-Implementation Validation

 5. Only when the returned phase is \`IMPL_VALIDATION\`: call \`flowguard_status\` with NO focused
    flags (no whyBlocked/evidence/context/readiness) to get the full projection, then read
    \`activeChecks\` (equivalently \`remainingChecks\` in IMPL_VALIDATION) and
    \`verificationCandidates\`.
    - If both \`activeChecks\`/\`remainingChecks\` and \`verificationCandidates\` are empty:
      report no active checks and stop without calling \`flowguard_run_check\`. The MACHINE
      itself decides a vacuous transition — read the canonical \`nextAction\` and the actual
      phase from the tool response; never claim the IMPL_REVIEW gate is unreachable and never
      invent a transition path.
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
   - If prior failing implementation challenges are open, before invoking the reviewer Task you MUST
     record each one with \`flowguard_resolve_implementation_challenge({ challengeId, validationAttemptIds })\`.
     Use only post-implementation validation attempt IDs for the current digest. This is advisory
     \`NOT_VERIFIED\` evidence and never changes reviewer acceptance or the user gate.
${SHARED_REVIEW_LOOP({
  toolName: 'flowguard_implement',
  verdictToolName: 'flowguard_review_implementation',
  artifactName: 'implementation',
  reviseParams: '',
  changesRequestedExtra:
    '\n         Then run the repair-recheck cycle: make the code changes based on blockingIssues, call flowguard_implement({}) again to re-record, dispatch on the returned phase again (step 4), run the post-recording checks only while the machine is still in IMPL_VALIDATION, record resolutions for any open implementation challenges (first bullet of step 7), then continue the review loop automatically from step 7.',
  changesRequestedVerdictFirst: true,
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
   - The changes_requested branch is an INTERNAL continuation, not a terminal result: FlowGuard returns no presentation card while the review loop is still active. Never render an intermediate outcome as final, and never stop for user input between iterations. Only the loop's terminal responses — converged acceptance (EVIDENCE_REVIEW), exhausted budget (user extension decision), or a BLOCKED code — end the loop and carry a presentation card to display verbatim.

## Rules

- Follow the approved plan exactly — no deviations or additions.
- Make only changes the plan requires or that are clearly necessary to make it work: no speculative flexibility, no defensive handling for scenarios that cannot occur, no unrequested refactors of untouched code (see AP-B11 Over-Engineering).
- Solve the problem generally; never special-case test inputs or hardcode values to make checks pass (see AP-B12 Test-Fitting). If a test looks wrong, surface it instead of fitting to it.
- Use the standard project tools; do not build helper-script workarounds to shortcut a task. Remove any temporary files or scaffolding created for iteration before finishing.
- Record evidence with \`flowguard_implement({})\` (no arguments) BEFORE starting the review loop.
- After every \`flowguard_implement({})\`, dispatch on the returned phase (step 4) and run
  \`flowguard_run_check\` only while the machine is still in IMPL_VALIDATION with checks to run.
- When changes are requested in the review loop: make the actual code changes, then re-record
  with \`flowguard_implement({})\` and dispatch on the returned phase again.
- In Verification Evidence, list only checks that were actually executed. Mark all others as NOT_VERIFIED.
- Follow profile rules from \`flowguard_status\` when implementing.
- Do not call flowguard_plan during /implement — planning is complete.
- Do not auto-chain into /review-decision after implementation — the user decides.

## Example (correct tool sequences)

Happy path (checks exist):
1. \`flowguard_status\` → phase: IMPLEMENTATION, plan approved
2. (execute plan steps: read/write/edit/bash)
3. \`flowguard_implement({})\` → returns phase: IMPL_VALIDATION
4. \`flowguard_status\` (unfocused) → read \`activeChecks\`
5. \`flowguard_run_check({ kind: "<kind>" })\` for each active check → passes, advances to IMPL_REVIEW
6. (review loop) \`flowguard_review_implementation({ reviewVerdict: "accept" })\` → EVIDENCE_REVIEW (user gate — the USER approves via /review-decision; this call does NOT approve the implementation)

Zero-check path (machine advances within the record call):
1. \`flowguard_implement({})\` → returns phase: IMPL_REVIEW (policy-permitted vacuous validation)
2. go DIRECTLY to the review loop — no status re-read, no invented IMPL_VALIDATION step

Reduced-ceremony path:
1. \`flowguard_implement({})\` → returns phase: EVIDENCE_REVIEW + presentation (or COMPLETE
   under a policy-permitted automatic approval)
2. display \`presentation.markdown\` verbatim and STOP

Revision path (when review returns changes_requested):
1. \`flowguard_review_implementation({ reviewVerdict: "changes_requested" })\` → routes back to IMPLEMENTATION
2. (fix code based on blockingIssues)
3. \`flowguard_implement({})\` → dispatch on the returned phase (step 4)
4. While still IMPL_VALIDATION: \`flowguard_status\` (unfocused) → read \`activeChecks\`
5. \`flowguard_run_check({ kind: "<kind>" })\` for each active check → passes, advances to IMPL_REVIEW
6. (review loop) \`flowguard_review_implementation({ reviewVerdict: "accept" })\` → EVIDENCE_REVIEW (user gate)

${GOVERNANCE_RULES}
## Presentation

- If \`presentation.markdown\` is present, display its markdown verbatim — never summarize, truncate, or omit it; do not append a second conclusion.
- Only when \`presentation.markdown\` is absent, display the legacy \`reviewCard\` field verbatim.
- This is mandatory output: the user relies on it to make their review decision.

## Done-when

- All plan steps are implemented as code changes.
- Verification Evidence distinguishes Planned from Executed checks.
- Implementation evidence is recorded via flowguard_implement.
- Independent review loop has converged.
${DISCOVERY_REVIEW_DONE_WHEN}
- If \`presentation.markdown\` is present, it is displayed verbatim; otherwise the legacy \`reviewCard\` is displayed verbatim.
- On the converged path: phase has advanced to EVIDENCE_REVIEW and the canonical presentation conclusion is the only visible next action.
- On a blocked path (review not converged, reviewer unavailable, or a FlowGuard error code): no \`/review-decision\` next action is emitted; the response surfaces the FlowGuard blocker and its recovery instead.
`;
