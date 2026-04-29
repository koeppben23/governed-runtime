export const CONTINUE_COMMAND = `
---
description: Continue the FlowGuard workflow — do the next thing based on the current phase.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Determine what the FlowGuard workflow needs next and do it.

## Steps

1. Call \`flowguard_status\` to check the current session state.
   - If no session exists, call \`flowguard_hydrate\` first.

2. Based on the current phase, take the appropriate action:

   ### READY (choose flow)
   - Tell the user to choose a flow: /ticket, /architecture, or /review.

   ### TICKET (needs ticket)
   - Tell the user to provide a task description using /ticket.

   ### TICKET (has ticket, needs plan)
   - Tell the user to run /plan to generate a plan.

   ### PLAN (independent review pending)
   - The plan needs independent review. Check the tool response's \`next\` field:
     - If it starts with "INDEPENDENT_REVIEW_COMPLETED": Submit \`_pluginReviewFindings\` with the appropriate verdict to \`flowguard_plan\`.
     - If it starts with "INDEPENDENT_REVIEW_REQUIRED": Call the flowguard-reviewer subagent via Task tool (subagent_type "flowguard-reviewer") to get ReviewFindings, then submit the verdict with reviewFindings to \`flowguard_plan\`.
     - Otherwise: Report the malformed or blocked review state and stop. Do not substitute self-review.
   - Follow the independent review loop as described in /plan.

   ### PLAN_REVIEW (User Gate)
   - Tell the user this is a human decision point.
   - Present the plan summary and ask for a verdict: approve, changes_requested, or reject.
   - Tell the user to use \`/review-decision <verdict>\`.

   ### VALIDATION (needs checks)
   - Run validation checks. For each active check:
     - \`test_quality\`: Analyze test coverage and quality.
     - \`rollback_safety\`: Analyze whether changes can be safely rolled back.
   - Call \`flowguard_validate\` with all results.

   ### IMPLEMENTATION (needs implementation)
   - Tell the user to run /implement to start the implementation.

   ### IMPL_REVIEW (review pending)
   - Review the implementation against the plan. Check the tool response's \`next\` field:
     - If it starts with "INDEPENDENT_REVIEW_COMPLETED": Submit \`_pluginReviewFindings\` with the appropriate verdict to \`flowguard_implement\`.
     - If it starts with "INDEPENDENT_REVIEW_REQUIRED": Call the flowguard-reviewer subagent via Task tool (subagent_type "flowguard-reviewer") to get ReviewFindings, then submit the verdict with reviewFindings to \`flowguard_implement\`.
     - Otherwise: Report the malformed or blocked review state and stop. Do not substitute self-review.
   - Call \`flowguard_implement\` with the appropriate reviewVerdict and ReviewFindings.

   ### EVIDENCE_REVIEW (User Gate)
   - Tell the user this is a human decision point.
   - Present the implementation summary and ask for a verdict.
   - Tell the user to use \`/review-decision <verdict>\`.

   ### COMPLETE (terminal)
   - Report that the workflow is complete. No further actions needed.
   - If there is an error with code "ABORTED", note the session was aborted.

   ### ARCHITECTURE (ADR review pending)
   - The ADR needs review. Review it critically against MADR standards.
   - Call \`flowguard_architecture\` with the appropriate selfReviewVerdict.
   - Follow the ADR review loop as described in /architecture.

   ### ARCH_REVIEW (User Gate)
   - Tell the user this is a human decision point.
   - Present the ADR summary and ask for a verdict: approve, changes_requested, or reject.
   - Tell the user to use \`/review-decision <verdict>\`.

   ### ARCH_COMPLETE (terminal)
   - Report that the architecture flow is complete. ADR accepted.

   ### REVIEW (report generated)
   - Call \`flowguard_continue\` to advance to REVIEW_COMPLETE.

   ### REVIEW_COMPLETE (terminal)
   - Report that the review flow is complete. Report delivered.

3. Report the action taken and the current state to the user.

## Constraints

- DO NOT take destructive actions. /continue is a routing command — it determines what to do, not blindly executes.
- At User Gates (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW), DO NOT make the decision for the user. Present the information and ask for their verdict.
- Always check status first before taking any action.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- Natural-language prompts like "go", "weiter", "proceed", "mach weiter", "next", or "what's next" are NOT command invocations. Only an explicit \`/continue\` triggers this command. If the user sends free-text implying continuation, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line stating the next step for the user.

## Done-when

- Current phase is identified and appropriate action is taken or reported.
- User is informed of the current state and next step.
- Response ends with exactly one \`Next action:\` line.
`;
