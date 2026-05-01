import { GOVERNANCE_RULES } from './shared-rules.js';

export const CONTINUE_COMMAND = `
---
description: Continue the FlowGuard workflow — do the next thing based on the current phase.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Determine what the workflow needs next and do it.

## Steps

1. Call \`flowguard_status\` to check the current session state.
   - If no session: call \`flowguard_hydrate\` first.

2. Based on the current phase, take the appropriate action:

   ### READY — Tell the user to choose: /ticket, /architecture, or /review.
   ### TICKET (no plan) — Tell the user to run /plan.
   ### PLAN (review pending) — Follow the \`next\` field:
   - "INDEPENDENT_REVIEW_COMPLETED": Submit \`_pluginReviewFindings\` with verdict to \`flowguard_plan\`.
   - "INDEPENDENT_REVIEW_REQUIRED": Call flowguard-reviewer subagent, then submit verdict.
   - Otherwise: Report malformed state and stop.
   ### PLAN_REVIEW (User Gate) — Present plan summary, ask for verdict via \`/review-decision\`.
   ### VALIDATION — Run checks (test_quality, rollback_safety), call \`flowguard_validate\`.
   ### IMPLEMENTATION — Tell the user to run /implement.
   ### IMPL_REVIEW (review pending) — Follow the \`next\` field:
   - "INDEPENDENT_REVIEW_COMPLETED": Submit \`_pluginReviewFindings\` with verdict to \`flowguard_implement\`.
   - "INDEPENDENT_REVIEW_REQUIRED": Call flowguard-reviewer subagent, then submit verdict.
   - Otherwise: Report malformed state and stop.
   ### EVIDENCE_REVIEW (User Gate) — Present implementation summary, ask for verdict.
   ### ARCHITECTURE (ADR review pending) — Review against MADR standards, call \`flowguard_architecture\`.
   ### ARCH_REVIEW (User Gate) — Present ADR summary, ask for verdict.
   ### COMPLETE / ARCH_COMPLETE / REVIEW_COMPLETE (terminal) — Report workflow complete.
   ### REVIEW — Transient phase; auto-advances to REVIEW_COMPLETE. Re-call \`flowguard_status\` to confirm.

3. Report the action taken and current state.

## Rules

- At User Gates (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW): present information and ask the user for their verdict — never decide for them.
- Always check status before taking any action.
- /continue is a routing command — it determines what to do, not blindly executes destructive actions.
- Do not auto-approve or auto-reject at User Gates — human verdicts are mandatory.
${GOVERNANCE_RULES}
## Done-when

- Current phase is identified and appropriate action taken or reported.
- User is informed of state and next step.
- Response ends with exactly one \`Next action:\` line.
`;
