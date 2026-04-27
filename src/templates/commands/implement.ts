export const IMPLEMENT_COMMAND = `
---
description: Implement the approved plan and review the implementation.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Implement the approved plan and review the implementation.

## Steps

### Phase 1: Check State

1. Call \`flowguard_status\` with no arguments to verify:
   - A session exists (if not, call \`flowguard_hydrate\` first and stop).
   - The phase is IMPLEMENTATION (if not, report the current phase and stop).
   - A ticket and approved plan exist.
   - Validation checks have passed.
   - If any precondition is not met, report it to the user and stop.

### Phase 2: Implement

2. Read the plan from the status response. Identify the numbered steps and the files to modify.
3. Execute each step from the plan in order:
   - Use the \`read\` tool to examine existing files before modifying them.
   - Use the \`write\` or \`edit\` tool to create or modify files.
   - Use the \`bash\` tool for commands (install dependencies, run formatters, etc.).
   - Follow the plan steps exactly. Do not add steps that are not in the plan.
4. After completing ALL implementation steps from the plan, call \`flowguard_implement\` with no arguments (do NOT set \`reviewVerdict\`).
   - The tool will auto-detect changed files via git and record implementation evidence.
   - It will advance the phase to IMPL_REVIEW.
5. Read the response. It will list the changed files, a \`reviewMode\` field, and a \`next\` field that determines the review approach.

### Phase 3: Record Verification Evidence

6. After implementation, write a \`## Verification Evidence\` section in your response that clearly distinguishes:
    - **Planned checks**: List each check from the plan's Verification Plan section.
    - **Executed checks**: List ONLY the checks you actually ran. If you did not run a check, do NOT list it — mark it as NOT_VERIFIED.
    - If no checks were executed, state "NOT_VERIFIED: No verification was run."

### Phase 4: Implementation Review Loop

7. Check the \`next\` field in the tool response:

#### Path A: Independent Review (when \`next\` starts with "INDEPENDENT_REVIEW_REQUIRED" or "INDEPENDENT_REVIEW_COMPLETED")

   There are two sub-paths depending on whether the plugin automatically invoked the reviewer:

   **Path A1: Plugin-Completed Review (when \`next\` starts with "INDEPENDENT_REVIEW_COMPLETED")**

   The FlowGuard plugin has already invoked the reviewer subagent. The response contains \`_pluginReviewFindings\` with the reviewer's findings.

   a. Read the \`_pluginReviewFindings\` field from the tool response. This is the ReviewFindings JSON object from the reviewer.
   b. Parse the \`overallVerdict\` from the findings:
      - If \`overallVerdict\` is \`"approve"\`: Call \`flowguard_implement\` with \`reviewVerdict: "approve"\` and \`reviewFindings\` set to the \`_pluginReviewFindings\` object.
      - If \`overallVerdict\` is \`"changes_requested"\`: Call \`flowguard_implement\` with \`reviewVerdict: "changes_requested"\` and \`reviewFindings\` set to the \`_pluginReviewFindings\` object. Then make the necessary code changes to address the blocking issues. After making changes, call \`flowguard_implement\` with no arguments (no \`reviewVerdict\`) to re-record the implementation.
   c. Read the response:
      - If review converged: Report the final status to the user.
      - If another iteration is needed: Go back to step 7.

   **Path A2: Fallback LLM-Driven Review (when \`next\` starts with "INDEPENDENT_REVIEW_REQUIRED")**

   The plugin could not invoke the reviewer automatically. You must call the subagent manually.

   a. Call the Task tool with:
      - \`subagent_type\`: \`"flowguard-reviewer"\`
      - \`prompt\`: Include the list of changed files, the approved plan text, the ticket text, and specify \`iteration\` and \`planVersion\` as indicated in the tool response. Instruct the subagent to read and review the changed files using the read/grep/glob tools.
   b. Read the subagent response. It will be a JSON object matching the ReviewFindings schema.
   c. Parse the \`overallVerdict\` from the ReviewFindings:
      - If \`overallVerdict\` is \`"approve"\`: Call \`flowguard_implement\` with \`reviewVerdict: "approve"\` and \`reviewFindings\` set to the parsed JSON object.
      - If \`overallVerdict\` is \`"changes_requested"\`: Call \`flowguard_implement\` with \`reviewVerdict: "changes_requested"\` and \`reviewFindings\` set to the parsed JSON object. Then make the necessary code changes to address the blocking issues. After making changes, call \`flowguard_implement\` with no arguments (no \`reviewVerdict\`) to re-record the implementation.
   d. Read the response:
      - If review converged: Report the final status to the user.
      - If another iteration is needed: Go back to step 7.

#### Path B: Self-Review (when \`next\` does NOT start with "INDEPENDENT_REVIEW_REQUIRED")

   Review the implementation yourself against this checklist. For EACH item, determine pass or fail:
    - [ ] Every step from the plan has a corresponding code change (no steps were skipped).
    - [ ] Every file listed in the plan's "Files to Modify" section was actually modified (or the omission is justified).
    - [ ] No files were modified that are NOT in the plan (unless they are direct dependencies like imports or config).
    - [ ] Each edge case from the plan has corresponding handling code.
    - [ ] No obvious bugs: null checks present where needed, error handling in place, no typos in identifiers.
    - [ ] Code follows the project's existing conventions (naming, formatting, file organization).
    - [ ] Each validation criterion from the plan is testable against the current code.
    - [ ] Verification Evidence clearly distinguishes Planned checks from Executed checks.
    - [ ] Unexecuted checks are marked as NOT_VERIFIED.

   Based on your review:
    - If ALL checklist items pass: Call \`flowguard_implement\` with \`reviewVerdict\` set to \`"approve"\`.
    - If ANY checklist item fails: Call \`flowguard_implement\` with \`reviewVerdict\` set to \`"changes_requested"\`. Then make the necessary code changes using read/write/bash tools to fix the failing items. After making changes, call \`flowguard_implement\` with no arguments (no \`reviewVerdict\`) to re-record the implementation.

   Read the response:
    - If review converged: Report the final status to the user.
    - If another review iteration is needed: Go back to step 7.

8. Report the final status to the user.

## Constraints

- Follow the plan exactly. Do not deviate from the approved plan.
- In Verification Evidence, only list checks in "Executed checks" if they were actually run. Otherwise mark as NOT_VERIFIED.
- DO NOT skip the review. You MUST either use plugin-provided findings (Path A1), call the subagent manually (Path A2), or run the checklist (Path B) at least once.
- When the tool response indicates INDEPENDENT_REVIEW_COMPLETED, use the \`_pluginReviewFindings\` directly. When it indicates INDEPENDENT_REVIEW_REQUIRED, you MUST call the flowguard-reviewer subagent. Do NOT substitute self-review.
- When changes are requested in the review, you MUST make the actual code changes BEFORE calling flowguard_implement again.
- Call flowguard_implement with no arguments (Mode A) BEFORE calling it with reviewVerdict (Mode B). Mode A records the evidence; Mode B records the review.
- The review loop runs up to 3 iterations maximum.
- DO NOT modify FlowGuard state files directly. Only use FlowGuard tools.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT bypass flowguard_implement with direct file manipulation of FlowGuard state.
- DO NOT auto-chain into /review-decision, /plan, /ticket, or /continue after the implementation review converges.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- If the \`flowguard_status\` response contains profile rules (stack-specific guidance), follow them when implementing. Profile rules supplement the universal FlowGuard mandates.
- Natural-language prompts like "go", "weiter", "start implementing", "build it", or "code it" are NOT command invocations. Only an explicit \`/implement\` triggers this command. If the user sends free-text implying implementation, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After implementation review converges to EVIDENCE_REVIEW: \`Next action: run /review-decision approve, /review-decision changes_requested, or /review-decision reject.\`

## Done-when

- All plan steps are implemented as code changes.
- Verification Evidence section clearly distinguishes Planned checks from Executed checks.
- Unexecuted checks are marked as NOT_VERIFIED.
- Implementation evidence is recorded via flowguard_implement.
- Implementation review loop has converged (approved or max iterations).
- Phase has advanced to EVIDENCE_REVIEW.
- Response ends with exactly one \`Next action:\` line.
`;
