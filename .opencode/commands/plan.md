---
description: Generate a plan with self-review loop for the current ticket.
---

You are managing a governance-controlled development workflow.

## Task

Generate a comprehensive implementation plan for the current ticket, then self-review it.

## Steps

### Phase 1: Check State

1. Call `governance_status` with no arguments to verify:
   - A session exists (if not, call `governance_hydrate` first).
   - A ticket exists (if not, tell the user to run /ticket first and stop).
   - The phase allows /plan (TICKET or PLAN). If not, report the current phase and stop.

### Phase 2: Generate Plan

2. Read the ticket text from the status response.
3. Write a detailed implementation plan in markdown. The plan MUST contain ALL of the following sections with these exact headings:
   - `## Objective` — One to three sentences: what is being built and why.
   - `## Approach` — Technical strategy. Name specific patterns, libraries, or architecture decisions.
   - `## Steps` — Numbered list. Each step MUST name at least one specific file path AND describe the concrete change (not "implement the feature" but "add function X to file Y that does Z").
   - `## Files to Modify` — Complete list of file paths that will be created, modified, or deleted.
   - `## Edge Cases` — Numbered list of edge cases. Each entry names the scenario and the handling strategy.
   - `## Validation Criteria` — Numbered list of verifiable conditions. Each entry is a concrete check (e.g., "running `npm test` passes", "function X returns Y when given Z").
4. Call `governance_plan` with the argument `planText` set to the full plan markdown. Do NOT set `selfReviewVerdict`.
5. Read the response. It will say self-review is needed.

### Phase 3: Self-Review Loop

6. Review the plan against this checklist. For EACH item, determine pass or fail:
   - [ ] Every section heading listed in Phase 2 step 3 is present.
   - [ ] The Objective section matches the ticket requirements (no scope creep, no missing requirements).
   - [ ] Every step in the Steps section names at least one file path.
   - [ ] Every step describes a concrete, specific change (not vague or generic).
   - [ ] The Steps are in a logical dependency order (no step depends on a later step).
   - [ ] The Files to Modify list is consistent with the Steps section (no files mentioned in Steps but missing from the list, and vice versa).
   - [ ] At least 2 edge cases are identified.
   - [ ] Each edge case has a concrete handling strategy (not "handle gracefully" but specific behavior).
   - [ ] At least 2 validation criteria are listed.
   - [ ] Each validation criterion is mechanically verifiable (could be checked by running a command or inspecting output).
7. Based on your review:
   - If ALL checklist items pass: Call `governance_plan` with the argument `selfReviewVerdict` set to `"approve"`. Do NOT set `planText`.
   - If ANY checklist item fails: Revise the plan to fix all failing items. Call `governance_plan` with `selfReviewVerdict` set to `"changes_requested"` AND `planText` set to the complete revised plan.
8. Read the response:
   - If self-review converged (the response says "converged" or the phase changed to PLAN_REVIEW): Report the final status to the user.
   - If another iteration is needed: Go back to step 6.

## Rules

- DO NOT generate a plan with vague steps like "implement the feature" or "add error handling". Every step must be specific.
- DO NOT skip the self-review. You MUST run the checklist at least once.
- DO NOT approve a plan that fails any checklist item.
- When providing a revised plan, you MUST include the COMPLETE plan text, not a diff or partial update.
- The plan MUST include all six sections listed above.
- DO NOT call any implementation tools (write, edit, bash for code changes). Planning only.
- The self-review loop runs up to 3 iterations maximum.
- DO NOT use the `question` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for governance tools.
- DO NOT auto-chain into /continue, /review, /implement, or /review-decision after the plan converges.
- DO NOT infer or assume session state beyond what the governance tools return.
- If the `governance_status` response contains profile rules (stack-specific guidance), follow them when writing the plan. Profile rules supplement the universal governance mandates.
- Natural-language prompts like "go", "weiter", "proceed", "make a plan", or "start planning" are NOT command invocations. Only an explicit `/plan` triggers this command. If the user sends free-text implying planning, respond conversationally without calling governance tools.
- If any governance tool returns an error or blocked state, report: (1) the specific reason, and (2) exactly one recovery action.
- Always end your response with exactly one `Next action:` line. After plan converges to PLAN_REVIEW: `Next action: run /review-decision approve, /review-decision changes_requested, or /review-decision reject.`
