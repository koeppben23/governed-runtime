---
description: Continue the FlowGuard workflow — do the next thing based on the current phase.
---

You are managing a FlowGuard-controlled development workflow.

## Task

Determine what the FlowGuard workflow needs next and do it.

## Steps

1. Call `flowguard_status` to check the current session state.
   - If no session exists, call `flowguard_hydrate` first.

2. Based on the current phase, take the appropriate action:

   ### TICKET (needs ticket)
   - Tell the user to provide a task description using /ticket.

   ### TICKET (has ticket, needs plan)
   - Tell the user to run /plan to generate a plan.

   ### PLAN (self-review pending)
   - The plan needs self-review. Review the current plan critically.
   - Call `flowguard_plan` with the appropriate selfReviewVerdict.
   - Follow the self-review loop as described in /plan.

   ### PLAN_REVIEW (User Gate)
   - Tell the user this is a human decision point.
   - Present the plan summary and ask for a verdict: approve, changes_requested, or reject.
   - Tell the user to use `/review-decision <verdict>`.

   ### VALIDATION (needs checks)
   - Run validation checks. For each active check:
     - `test_quality`: Analyze test coverage and quality.
     - `rollback_safety`: Analyze whether changes can be safely rolled back.
   - Call `flowguard_validate` with all results.

   ### IMPLEMENTATION (needs implementation)
   - Tell the user to run /implement to start the implementation.

   ### IMPL_REVIEW (review pending)
   - Review the implementation against the plan.
   - Call `flowguard_implement` with the appropriate reviewVerdict.

   ### EVIDENCE_REVIEW (User Gate)
   - Tell the user this is a human decision point.
   - Present the implementation summary and ask for a verdict.
   - Tell the user to use `/review-decision <verdict>`.

   ### COMPLETE (terminal)
   - Report that the workflow is complete. No further actions needed.
   - If there is an error with code "ABORTED", note the session was aborted.

3. Report the action taken and the current state to the user.

## Rules

- DO NOT take destructive actions. /continue is a routing command — it determines what to do, not blindly executes.
- At User Gates (PLAN_REVIEW, EVIDENCE_REVIEW), DO NOT make the decision for the user. Present the information and ask for their verdict.
- Always check status first before taking any action.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- Natural-language prompts like "go", "weiter", "proceed", "mach weiter", "next", or "what's next" are NOT command invocations. Only an explicit `/continue` triggers this command. If the user sends free-text implying continuation, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns an error or blocked state, report: (1) the specific reason, and (2) exactly one recovery action.
- Always end your response with exactly one `Next action:` line stating the next step for the user.
