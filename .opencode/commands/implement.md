---
description: Implement the approved plan and review the implementation.
---

You are managing a governance-controlled development workflow.

## Task

Implement the approved plan and review the implementation.

## Steps

### Phase 1: Check State

1. Call `governance_status` with no arguments to verify:
   - A session exists (if not, call `governance_hydrate` first and stop).
   - The phase is IMPLEMENTATION (if not, report the current phase and stop).
   - A ticket and approved plan exist.
   - Validation checks have passed.
   - If any precondition is not met, report it to the user and stop.

### Phase 2: Implement

2. Read the plan from the status response. Identify the numbered steps and the files to modify.
3. Execute each step from the plan in order:
   - Use the `read` tool to examine existing files before modifying them.
   - Use the `write` or `edit` tool to create or modify files.
   - Use the `bash` tool for commands (install dependencies, run formatters, etc.).
   - Follow the plan steps exactly. Do not add steps that are not in the plan.
4. After completing ALL implementation steps from the plan, call `governance_implement` with no arguments (do NOT set `reviewVerdict`).
   - The tool will auto-detect changed files via git and record implementation evidence.
   - It will advance the phase to IMPL_REVIEW.
5. Read the response. It will list the changed files and say a review is needed.

### Phase 3: Implementation Review Loop

6. Review the implementation against this checklist. For EACH item, determine pass or fail:
   - [ ] Every step from the plan has a corresponding code change (no steps were skipped).
   - [ ] Every file listed in the plan's "Files to Modify" section was actually modified (or the omission is justified).
   - [ ] No files were modified that are NOT in the plan (unless they are direct dependencies like imports or config).
   - [ ] Each edge case from the plan has corresponding handling code.
   - [ ] No obvious bugs: null checks present where needed, error handling in place, no typos in identifiers.
   - [ ] Code follows the project's existing conventions (naming, formatting, file organization).
   - [ ] Each validation criterion from the plan is testable against the current code.
7. Based on your review:
   - If ALL checklist items pass: Call `governance_implement` with `reviewVerdict` set to `"approve"`.
   - If ANY checklist item fails: Call `governance_implement` with `reviewVerdict` set to `"changes_requested"`. Then make the necessary code changes using read/write/bash tools to fix the failing items. After making changes, call `governance_implement` with no arguments (no `reviewVerdict`) to re-record the implementation.
8. Read the response:
   - If review converged (the response says "converged" or the phase changed to EVIDENCE_REVIEW): Report the final status to the user.
   - If another review iteration is needed: Go back to step 6.
9. Report the final status to the user.

## Rules

- Follow the plan exactly. Do not deviate from the approved plan.
- DO NOT skip the implementation review. You MUST run the checklist at least once.
- When changes are requested in the review, you MUST make the actual code changes BEFORE calling governance_implement again.
- Call governance_implement with no arguments (Mode A) BEFORE calling it with reviewVerdict (Mode B). Mode A records the evidence; Mode B records the review.
- The review loop runs up to 3 iterations maximum.
- DO NOT modify governance files (.governance/*) directly. Only use governance tools.
- DO NOT use the `question` tool or present selectable choices.
- DO NOT bypass governance_implement with direct file manipulation of .governance/ state.
- DO NOT auto-chain into /review-decision, /plan, /ticket, or /continue after the implementation review converges.
- DO NOT infer or assume session state beyond what the governance tools return.
- If the `governance_status` response contains profile rules (stack-specific guidance), follow them when implementing. Profile rules supplement the universal governance mandates.
- Natural-language prompts like "go", "weiter", "start implementing", "build it", or "code it" are NOT command invocations. Only an explicit `/implement` triggers this command. If the user sends free-text implying implementation, respond conversationally without calling governance tools.
- If any governance tool returns an error or blocked state, report: (1) the specific reason, and (2) exactly one recovery action.
- Always end your response with exactly one `Next action:` line. After implementation review converges to EVIDENCE_REVIEW: `Next action: run /review-decision approve, /review-decision changes_requested, or /review-decision reject.`
