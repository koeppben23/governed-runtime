import { renderCommandGovernanceRules } from '../mandates.js';

export const CHECK_COMMAND = `---
description: FlowGuard — Run verification checks on the current implementation evidence.
agent: build
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Run automated verification checks for the current implementation.

## Steps

1. Call \`flowguard_status\` with NO focused flags (no whyBlocked/evidence/context/readiness) so the full projection is returned, then read \`activeChecks\` (equivalently \`remainingChecks\` in VALIDATION) and \`verificationCandidates\`.
2. If \`activeChecks\` is empty AND \`verificationCandidates\` is empty, do not call \`flowguard_run_check\`. Read the canonical \`directive\`: policy may permit a vacuous transition only through \`/validate\`, otherwise it will require Discovery recovery. Report that exact action.
3. For each kind in \`activeChecks\` (or \`remainingChecks\`), call \`flowguard_run_check({ kind: "<kind>" })\` sequentially. Never run two state-mutating checks concurrently.
    - FlowGuard executes the discovered command and returns execution evidence.
    - You may also call \`flowguard_run_check({ kind: "<kind>" })\` directly for any kind in \`verificationCandidates\`; it validates the kind against canonical state, not against the status output.
    - If the response does not transition to a stop phase, call \`flowguard_status\` again before selecting the next check. Treat the status projection, not an earlier check response, as authoritative after another mutation may have run.
4. For a response that transitions to a stop phase, inspect that \`flowguard_run_check\` response before calling any other tool:
   - If its phase is \`IMPLEMENTATION\` while you are INSIDE this /check's repair-recheck continuation (a \`changes_requested\` verdict was already recorded earlier in this /check invocation — the persisted \`implementationRework\` marker stays set across re-records and is closed only when the fresh revalidation fully passes and the machine advances to IMPL_REVIEW): do NOT stop — continue the automatic repair-recheck cycle: repair the code, call \`flowguard_implement({})\` again to re-record, re-run the checks, resolve open implementation challenges, and re-review.
   - If its phase is \`IMPLEMENTATION\` and NO \`changes_requested\` verdict has been recorded during this /check: report the passed checks and the rendered next action, then STOP. Do not call \`read\`, \`glob\`, \`grep\`, \`bash\`, \`write\`, \`edit\`, \`flowguard_implement\`, or any implementation-review tool. Only a new, explicit user \`/implement\` command may start implementation.
   - If its phase is \`PLAN\` or \`IMPL_VALIDATION\`: report the check result and stop. Do not retry or advance without a new explicit user command.
    - If its phase is \`IMPL_REVIEW\`, complete the mandatory independent implementation review before reporting completion:
       1. FlowGuard performs and binds the independent review. Do not invoke a reviewer, construct reviewer context, or submit \`reviewFindings\`.
       2. When \`reviewDispatch.completed\` is true, call \`flowguard_review_implementation({ reviewVerdict })\` with the verdict from \`reviewDispatch.verdict\` only.
       3. After submitting the verdict, follow the response's \`reviewDispatch\` and \`directive\`:
         - \`accept\`: the review converged. Present the returned review card. Never make the subsequent human approval decision.
         - \`changes_requested\`: the review has NOT converged — FlowGuard routes back to IMPLEMENTATION with an active non-exhausted \`implementationRework\` marker and intentionally returns no intermediate presentation card. This is an INTERNAL continuation, not a terminal result: continue automatically inside this /check command — make the code changes based on the blocking issues, call \`flowguard_implement({})\` again to re-record (advances to IMPL_VALIDATION), re-read \`activeChecks\`/\`remainingChecks\` via \`flowguard_status\` and execute the post-recording checks again via \`flowguard_run_check\`, record resolutions for any open implementation challenges via \`flowguard_resolve_implementation_challenge\`, then invoke a fresh independent reviewer and loop through these review steps again. Never render an intermediate result as final and never stop for user input between iterations. Only the loop's terminal responses end it: converged acceptance (present the card), an exhausted budget (FlowGuard ends the loop at EVIDENCE_REVIEW with the \`IMPLEMENTATION_OVERRIDE_REQUIRED\` directive and a presentation card — present it and stop; the user then chooses \`/override-approve\`, \`/request-changes\`, or \`/reject\`), or a BLOCKED code.
         - \`unable_to_review\` or any BLOCKED code: surface the recovery steps from the FlowGuard response and stop. Never retry the review on the same evidence.
5. Report which checks passed, which failed, and whether the workflow can proceed.
${renderCommandGovernanceRules()}
## Done-when

- If both \`activeChecks\` and \`verificationCandidates\` are empty: report the canonical next action; do not claim validation passed.
- All active checks executed via flowguard_run_check.
- When checks advance to \`IMPL_REVIEW\`, the bound independent-review verdict has been submitted through \`flowguard_review_implementation\`.
- When checks advance to \`IMPLEMENTATION\`: a fresh /check without a prior \`changes_requested\` verdict was reported and stopped without implementation work; an /check already inside the repair-recheck continuation was continued automatically through repair-recheck until the review loop's terminal response.
- Results and next action reported.
- If \`presentation.markdown\` is present, render it verbatim and do not append a separate \`Next action:\` line.
- Otherwise, render the canonical \`directive\` as the single fallback conclusion.
`;
