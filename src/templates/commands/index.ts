export const COMMANDS: Record<string, string> = {
  'hydrate.md': `\
---
description: Bootstrap or reload the FlowGuard session. Run this FIRST before any other FlowGuard command.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Bootstrap the FlowGuard session for this project.

## Steps

1. Call the \`flowguard_hydrate\` tool with no arguments.
2. Read the returned JSON. It contains the current \`phase\` and \`next\` action.
3. Report the result to the user:
   - If a new session was created: confirm the session ID and that the workflow starts at READY phase.
   - If an existing session was loaded: report the current phase and next action.
   - If an error occurred: report the error message.

## Constraints

- DO NOT call any other FlowGuard tool before flowguard_hydrate.
- DO NOT modify any files.
- DO NOT skip the flowguard_hydrate call.
- DO NOT ask the user anything. Do not use the \`question\` tool or present selectable choices.
- DO NOT explain what you are about to do. Just call the tool.
- DO NOT substitute shell commands or direct file manipulation for the flowguard_hydrate tool.
- DO NOT auto-chain to /ticket, /plan, /continue, or any other FlowGuard command after hydration completes.
- DO NOT infer or assume session state beyond what the tool returns.
- Natural-language prompts like "go", "weiter", "proceed", "start", or "initialize" are NOT command invocations. Only an explicit \`/hydrate\` triggers this command. If the user sends free-text implying session setup, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After successful hydrate: \`Next action: run /ticket to start a task, /architecture to create an ADR, or /review for a compliance report.\`

## Done-when

- FlowGuard session is active (new or existing loaded).
- Session ID, phase, and next action are reported to the user.
- Response ends with exactly one \`Next action:\` line.
`,

  'status.md': `\
---
description: Show the current FlowGuard status surface.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Show canonical, read-only FlowGuard status.

Arguments: $ARGUMENTS

## Steps

1. Parse optional flags from \`$ARGUMENTS\`:
   - \`--why-blocked\`
   - \`--evidence\`
   - \`--context\`
   - \`--readiness\`
2. Call \`flowguard_status\` with:
   - no flags: no args
   - \`--why-blocked\`: \`{ whyBlocked: true }\`
   - \`--evidence\`: \`{ evidence: true }\`
   - \`--context\`: \`{ context: true }\`
   - \`--readiness\`: \`{ readiness: true }\`
3. Read and report the returned payload concisely.
4. If no session exists, report this and recommend \`/hydrate\`.

## Constraints

- \`/status\` is read-only. Never modify files or workflow state.
- Never invent governance semantics. Report only what \`flowguard_status\` returns.
- If flags are unknown, report valid flags and stop.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- Natural-language prompts like "status", "where am I", or "what next" are NOT command invocations. Only an explicit \`/status\` triggers this command.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line.

## Done-when

- Status was retrieved via \`flowguard_status\`.
- Output reflects canonical runtime truth.
- Response ends with exactly one \`Next action:\` line.
`,

  'ticket.md': `\
---
description: Record a task or ticket for the FlowGuard session.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Record the following task/ticket in the FlowGuard session:

$ARGUMENTS

## Steps

1. Call \`flowguard_status\` to check the current phase.
   - If no session exists, call \`flowguard_hydrate\` first.
   - If the phase is not READY or TICKET, report that /ticket is only allowed in READY or TICKET phase.
2. Call \`flowguard_ticket\` with:
   - \`text\`: The full task description provided above. If \`$ARGUMENTS\` is empty, ask the user to provide a task description.
   - \`source\`: "user"
3. Read the returned JSON.
4. Report the result to the user: confirm the ticket was recorded, show the current phase, and the next action.

## Constraints

- DO NOT invent or modify the ticket text. Use exactly what the user provided.
- If no arguments were provided, ask the user for the task description. DO NOT proceed without it.
- DO NOT call flowguard_plan or any other workflow-advancing tool.
- DO NOT use the \`question\` tool or present selectable choices (except to ask for missing ticket text via plain text).
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain into /plan, /continue, /review, or /review-decision after the ticket is recorded.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "go", "weiter", "proceed", "start working", or task descriptions sent without the /ticket prefix are NOT command invocations. Only an explicit \`/ticket\` triggers this command. If the user sends free-text describing a task, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After successful ticket: \`Next action: run /plan to generate an implementation plan.\`

## Done-when

- Ticket text is recorded in FlowGuard session via flowguard_ticket.
- Current phase and next action are reported to the user.
- Response ends with exactly one \`Next action:\` line.
`,

  'plan.md': `\
---
description: Generate a plan with self-review loop for the current ticket.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Generate a comprehensive implementation plan for the current ticket, then review it.

## Steps

### Phase 1: Check State

1. Call \`flowguard_status\` with no arguments to verify:
   - A session exists (if not, call \`flowguard_hydrate\` first).
   - A ticket exists (if not, tell the user to run /ticket first and stop).
   - The phase allows /plan (TICKET or PLAN). If not, report the current phase and stop.

### Phase 2: Generate Plan

2. Read the ticket text from the status response.
3. Write a detailed implementation plan in markdown. The plan MUST contain ALL of the following sections with these exact headings:
    - \`## Objective\` — One to three sentences: what is being built and why.
    - \`## Approach\` — Technical strategy. Name specific patterns, libraries, or architecture decisions.
    - \`## Steps\` — Numbered list. Each step MUST name at least one specific file path AND describe the concrete change (not "implement the feature" but "add function X to file Y that does Z").
    - \`## Files to Modify\` — Complete list of file paths that will be created, modified, or deleted.
    - \`## Edge Cases\` — Numbered list of edge cases. Each entry names the scenario and the handling strategy.
    - \`## Validation Criteria\` — Numbered list of verifiable conditions. Each entry is a concrete check (e.g., "running \`npm test\` passes", "function X returns Y when given Z").
    - \`## Verification Plan\` — Numbered list of planned verification checks. For each check, cite the command AND its Source (e.g., "Source: package.json:scripts.test").
4. Call \`flowguard_plan\` with the argument \`planText\` set to the full plan markdown. Do NOT set \`selfReviewVerdict\`.
5. Read the response. It will contain a \`next\` field and a \`reviewMode\` field that determine the review approach.

### Phase 3: Review Loop

6. Check the \`next\` field in the tool response:

#### Path A: Independent Review (when \`next\` starts with "INDEPENDENT_REVIEW_REQUIRED" or "INDEPENDENT_REVIEW_COMPLETED")

   There are two sub-paths depending on whether the plugin automatically invoked the reviewer:

   **Path A1: Plugin-Completed Review (when \`next\` starts with "INDEPENDENT_REVIEW_COMPLETED")**

   The FlowGuard plugin has already invoked the reviewer subagent. The response contains \`_pluginReviewFindings\` with the reviewer's findings.

   a. Read the \`_pluginReviewFindings\` field from the tool response. This is the ReviewFindings JSON object from the reviewer.
   b. Parse the \`overallVerdict\` from the findings:
      - If \`overallVerdict\` is \`"approve"\`: Call \`flowguard_plan\` with \`selfReviewVerdict: "approve"\` and \`reviewFindings\` set to the \`_pluginReviewFindings\` object.
      - If \`overallVerdict\` is \`"changes_requested"\`: Review the \`blockingIssues\` and \`majorRisks\` from the findings. Revise the plan to address them. Call \`flowguard_plan\` with \`selfReviewVerdict: "changes_requested"\`, \`planText\` set to the complete revised plan, and \`reviewFindings\` set to the \`_pluginReviewFindings\` object.
   c. Read the response:
      - If self-review converged: Report the final status to the user.
      - If another iteration is needed: Go back to step 6.

   **Path A2: Fallback LLM-Driven Review (when \`next\` starts with "INDEPENDENT_REVIEW_REQUIRED")**

   The plugin could not invoke the reviewer automatically. You must call the subagent manually.

   a. Call the Task tool with:
      - \`subagent_type\`: \`"flowguard-reviewer"\`
      - \`prompt\`: Include the full plan text, the ticket text, and specify \`iteration\` and \`planVersion\` as indicated in the tool response.
   b. Read the subagent response. It will be a JSON object matching the ReviewFindings schema.
   c. Parse the \`overallVerdict\` from the ReviewFindings:
      - If \`overallVerdict\` is \`"approve"\`: Call \`flowguard_plan\` with \`selfReviewVerdict: "approve"\` and \`reviewFindings\` set to the parsed JSON object.
      - If \`overallVerdict\` is \`"changes_requested"\`: Review the \`blockingIssues\` and \`majorRisks\` from the findings. Revise the plan to address them. Call \`flowguard_plan\` with \`selfReviewVerdict: "changes_requested"\`, \`planText\` set to the complete revised plan, and \`reviewFindings\` set to the parsed JSON object.
   d. Read the response:
      - If self-review converged: Report the final status to the user.
      - If another iteration is needed: Go back to step 6.

#### Path B: Self-Review (when \`next\` does NOT start with "INDEPENDENT_REVIEW_REQUIRED")

   Review the plan yourself against this checklist. For EACH item, determine pass or fail:
    - [ ] Every section heading listed in Phase 2 step 3 is present (including Verification Plan).
    - [ ] The Objective section matches the ticket requirements (no scope creep, no missing requirements).
    - [ ] Every step in the Steps section names at least one file path.
    - [ ] Every step describes a concrete, specific change (not vague or generic).
    - [ ] The Steps are in a logical dependency order (no step depends on a later step).
    - [ ] The Files to Modify list is consistent with the Steps section (no files mentioned in Steps but missing from the list, and vice versa).
    - [ ] At least 2 edge cases are identified.
    - [ ] Each edge case has a concrete handling strategy (not "handle gracefully" but specific behavior).
    - [ ] At least 2 validation criteria are listed.
    - [ ] Each validation criterion is mechanically verifiable (could be checked by running a command or inspecting output).
    - [ ] Verification Plan cites Source for each check OR states NOT_VERIFIED with recovery steps.
    - [ ] Verification Plan does not use generic commands when more specific candidates exist in flowguard_status.verificationCandidates.

   Based on your review:
    - If ALL checklist items pass: Call \`flowguard_plan\` with the argument \`selfReviewVerdict\` set to \`"approve"\`. Do NOT set \`planText\`.
    - If ANY checklist item fails: Revise the plan to fix all failing items. Call \`flowguard_plan\` with \`selfReviewVerdict\` set to \`"changes_requested"\` AND \`planText\` set to the complete revised plan.

   Read the response:
    - If self-review converged (the response says "converged" or the phase changed to PLAN_REVIEW): Report the final status to the user.
    - If another iteration is needed: Go back to step 6.

## Constraints

- DO NOT generate a plan with vague steps like "implement the feature" or "add error handling". Every step must be specific.
- DO NOT skip the review. You MUST either use plugin-provided findings (Path A1), call the subagent manually (Path A2), or run the checklist (Path B) at least once.
- When the tool response indicates INDEPENDENT_REVIEW_COMPLETED, use the \`_pluginReviewFindings\` directly. When it indicates INDEPENDENT_REVIEW_REQUIRED, you MUST call the flowguard-reviewer subagent. Do NOT substitute self-review.
- DO NOT approve a plan that fails any checklist item (Path B) or has blocking issues (Path A).
- When providing a revised plan, you MUST include the COMPLETE plan text, not a diff or partial update.
- The plan MUST include all seven sections listed above (Objective, Approach, Steps, Files to Modify, Edge Cases, Validation Criteria, Verification Plan).
- In Verification Plan, use flowguard_status.verificationCandidates when available. Cite the specific command AND its Source (e.g., "Source: package.json:scripts.test").
- If no repo-native verification candidate is available, state "NOT_VERIFIED" and provide recovery steps (e.g., "inspect package scripts / build wrapper / CI config").
- DO NOT invent verification commands. Always cite the Source when using verificationCandidates.
- DO NOT call any implementation tools (write, edit, bash for code changes). Planning only.
- The review loop runs up to 3 iterations maximum.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain into /continue, /review, /implement, or /review-decision after the plan converges.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- If the \`flowguard_status\` response contains profile rules (stack-specific guidance), follow them when writing the plan. Profile rules supplement the universal FlowGuard mandates.
- Natural-language prompts like "go", "weiter", "proceed", "make a plan", or "start planning" are NOT command invocations. Only an explicit \`/plan\` triggers this command. If the user sends free-text implying planning, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After plan converges to PLAN_REVIEW: \`Next action: run /review-decision approve, /review-decision changes_requested, or /review-decision reject.\`

## Done-when

- Plan contains all 7 required sections (Objective, Approach, Steps, Files to Modify, Edge Cases, Validation Criteria, Verification Plan).
- Verification Plan cites Source for each check OR states NOT_VERIFIED with recovery steps.
- Review loop has converged (approved or max 3 iterations reached).
- Phase has advanced to PLAN_REVIEW.
- Response ends with exactly one \`Next action:\` line.
`,

  'continue.md': `\
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

   ### PLAN (self-review pending)
   - The plan needs review. Check the tool response's \`next\` field:
     - If it starts with "INDEPENDENT_REVIEW_REQUIRED": Call the flowguard-reviewer subagent via Task tool (subagent_type "flowguard-reviewer") to get ReviewFindings, then submit the verdict with reviewFindings to flowguard_plan.
     - Otherwise: Review the current plan critically yourself. Call \`flowguard_plan\` with the appropriate selfReviewVerdict.
   - Follow the review loop as described in /plan.

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
     - If it starts with "INDEPENDENT_REVIEW_REQUIRED": Call the flowguard-reviewer subagent via Task tool (subagent_type "flowguard-reviewer") to get ReviewFindings, then submit the verdict with reviewFindings to flowguard_implement.
     - Otherwise: Review the implementation yourself.
   - Call \`flowguard_implement\` with the appropriate reviewVerdict.

   ### EVIDENCE_REVIEW (User Gate)
   - Tell the user this is a human decision point.
   - Present the implementation summary and ask for a verdict.
   - Tell the user to use \`/review-decision <verdict>\`.

   ### COMPLETE (terminal)
   - Report that the workflow is complete. No further actions needed.
   - If there is an error with code "ABORTED", note the session was aborted.

   ### ARCHITECTURE (self-review pending)
   - The ADR needs self-review. Review it critically.
   - Call \`flowguard_architecture\` with the appropriate selfReviewVerdict.
   - Follow the self-review loop as described in /architecture.

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
`,

  'implement.md': `\
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
`,

  'validate.md': `\
---
description: Run validation checks on the approved plan.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Execute validation checks for the FlowGuard session.

## Steps

1. Call \`flowguard_status\` with no arguments to verify:
   - A session exists.
   - The phase is VALIDATION.
   - An approved plan exists.
   - If the phase is not VALIDATION, report the current phase and stop.

2. Read the active checks from the status response. The active checks are typically: \`test_quality\` and \`rollback_safety\`. Additional checks may include \`business_rules\` and \`technical_debt\`.

3. For EACH active check, apply the falsification-first criteria below. Try to find reasons to FAIL the check before passing it.

   ### test_quality (QG-4)

   Attempt to falsify the plan's testing strategy. Check each criterion:

   **Hard fail (any one of these → \`passed: false\`):**
   - The plan does not name specific test files or test functions to create/modify.
   - The plan only mentions "add tests" or "ensure test coverage" without describing WHAT is tested.
   - No unhappy-path or negative-path test is described for any changed function.
   - Test assertions are vague ("verify it works") instead of specific (checking return values, error types, state changes).
   - The plan does not distinguish between unit, integration, and contract tests when multiple test types are relevant.

   **Risk-tier escalation:**
   - TIER-MEDIUM or higher: At least one explicit negative-path assertion per changed behavior MUST be described. Fail if missing.
   - TIER-HIGH: At least one resilience/recovery test (retry, idempotency, rollback, concurrent access) MUST be described. Fail if missing.

   **Pass criteria:** The plan names specific test targets, describes what each test proves, includes at least one negative-path test, and assertions are specific enough to catch real defects.

   ### rollback_safety (QG-5)

   Attempt to falsify the plan's rollback safety. Check each criterion:

   **Hard fail (any one of these → \`passed: false\`):**
   - Database schema changes exist but no reversible migration strategy is described.
   - Public API changes exist but backward-compatibility or versioning strategy is missing.
   - Irreversible operations (data deletion, schema drops, message schema changes) exist without safeguards.
   - Persistence-layer changes exist but no rollback plan is mentioned.
   - External system integrations are modified without timeout/retry/circuit-breaker consideration.

   **Risk-tier escalation:**
   - TIER-HIGH: A concrete rollback plan MUST be described (feature flag, migration rollback, config revert). Fail if missing.

   **Pass criteria:** All changes are safely reversible, OR the plan explicitly addresses rollback for each irreversible operation, including monitoring/verification steps.

   ### business_rules (if active)

   Attempt to falsify business requirement coverage:

   **Hard fail:**
   - Any requirement stated in the ticket is not addressed in the plan.
   - A requirement is partially addressed or reinterpreted without explicit justification.
   - Edge cases mentioned in the ticket have no corresponding handling in the plan.
   - Business logic is placed in the wrong layer (e.g., in adapters, UI, or infrastructure instead of domain).

   **Pass criteria:** Every ticket requirement maps to at least one plan step, edge cases are addressed, and business logic is in the domain layer.

   ### technical_debt (if active)

   Attempt to falsify architectural quality:

   **Hard fail:**
   - The plan introduces new abstractions without justification (YAGNI violation).
   - The plan creates tight coupling between modules that should be independent.
   - The plan duplicates existing patterns instead of extending them.
   - The plan violates existing naming conventions or file organization without justification.

   **Pass criteria:** Changes extend existing patterns, abstractions are justified, coupling is minimal, and naming/organization is consistent.

4. Call \`flowguard_validate\` with the argument \`results\` set to an array containing one entry per active check. Each entry must have:
   - \`checkId\`: The check identifier string (e.g., \`"test_quality"\`).
   - \`passed\`: \`true\` or \`false\`.
   - \`detail\`: A string with 2-4 sentences explaining why the check passed or failed. Reference specific parts of the plan.

5. Read the response:
   - If all passed: The workflow advances to IMPLEMENTATION. Report this.
   - If any failed: The workflow returns to PLAN for revision. Report which checks failed, why, and what the plan needs to address.

## Constraints

- DO NOT skip any active check. Results must be provided for ALL active checks.
- DO NOT always pass checks. Apply the criteria honestly — falsification-first.
- The \`detail\` field must reference specific plan content. Do not write generic statements like "looks good" or "testing is adequate".
- DO NOT modify any code or files. Validation is analysis only.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain into /implement, /plan, or any other FlowGuard command after validation completes.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "go", "weiter", "validate", "check it", or "run checks" are NOT command invocations. Only an explicit \`/validate\` triggers this command. If the user sends free-text implying validation, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. If all checks passed: \`Next action: run /implement to start implementation.\` If any check failed: \`Next action: run /plan to revise the plan and address the failed checks.\`

## Done-when

- All active checks have results with specific detail referencing plan content.
- Results are recorded in FlowGuard via flowguard_validate.
- Phase has advanced to IMPLEMENTATION (all passed) or returned to PLAN (any failed).
- Response ends with exactly one \`Next action:\` line.
`,

  'review-decision.md': `\
---
description: Submit a human review decision (approve, changes_requested, reject) at a User Gate.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Record a human review decision for the current User Gate.

Decision: $ARGUMENTS

## Steps

1. Call \`flowguard_status\` to verify:
   - A session exists.
   - The current phase is PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW (a User Gate).
   - If the phase is NOT a User Gate, report this to the user and stop.

2. Parse the decision from \`$ARGUMENTS\`:
   - Expected format: one of \`approve\`, \`changes_requested\`, \`reject\`
   - Optionally followed by a rationale (e.g., \`approve looks good\` or \`changes_requested missing error handling\`)
   - The first word is the verdict. Everything after is the rationale.
   - If \`$ARGUMENTS\` is empty or unclear, ask the user for their decision. DO NOT guess.

3. Call \`flowguard_decision\` with:
   - \`verdict\`: The parsed verdict (exactly one of: "approve", "changes_requested", "reject")
   - \`rationale\`: The parsed rationale, or empty string if none provided.

4. Read the returned JSON and report:
   - **approve**: Confirm advancement and show the new phase.
   - **changes_requested**: Explain that the workflow returns to the revision phase. State what needs to happen next.
    - **reject**: Explain that the workflow returns to the revision start. At PLAN_REVIEW or EVIDENCE_REVIEW, reject returns to TICKET and clears plan/implementation evidence. At ARCH_REVIEW, reject returns to READY and clears ADR evidence.

## Constraints

- DO NOT fabricate a verdict. Use exactly what the user provided.
- If the arguments are ambiguous (e.g., "maybe" or "not sure"), ask the user to clarify.
- DO NOT call this tool if the current phase is not PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW.
- Valid verdicts are ONLY: approve, changes_requested, reject. Nothing else.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain to other FlowGuard commands after the decision is recorded.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "approve", "go", "weiter", "looks good", "ship it", or "reject" sent WITHOUT the /review-decision prefix are NOT command invocations. Only an explicit \`/review-decision\` triggers this command. If the user sends free-text implying a decision, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line stating the next workflow step based on the verdict and phase.

## Done-when

- User verdict (approve, changes_requested, or reject) is recorded via flowguard_decision.
- Phase transition is reported to the user.
- Response ends with exactly one \`Next action:\` line.
`,

  'review.md': `\
---
description: Start the standalone compliance review flow (READY → REVIEW → REVIEW_COMPLETE).
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Start the compliance review flow for the current FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists and is in the READY phase.
   - If no session exists, report this and stop.
   - If the session is not in READY phase, report the current phase and stop.

2. Call \`flowguard_review\` with no arguments.
   - The tool transitions the session from READY → REVIEW → REVIEW_COMPLETE and generates a compliance report.

3. Read the response and present the report to the user:
   - **Overall status**: clean, warnings, or issues.
   - **Findings**: List each finding with severity (info/warning/error), category, and message.
   - **Validation summary**: Show which checks passed or failed.
   - **Current phase**: Should be REVIEW_COMPLETE.

4. If there are warnings or issues, explain what actions could address them.

## Verification Review Check

When reviewing implementation evidence or plan verification, check:

- Were verificationCandidates from flowguard_status used when available?
- Were generic commands (e.g., "npm test") suggested despite more specific repo-native candidates existing?
- Were executed checks clearly distinguished from planned checks?
- Are unexecuted checks marked as NOT_VERIFIED?

If generic commands are used when specific candidates exist, flag this as a defect in the report.

## Constraints

- This command starts a standalone flow. It transitions the session through READY → REVIEW → REVIEW_COMPLETE.
- This command is only available in the READY phase.
- DO NOT modify any FlowGuard state or files other than the report.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- DO NOT auto-chain to any other FlowGuard command after generating the report.
- Present the report clearly and concisely.
- Natural-language prompts like "review it", "check the status", "how does it look", or "is it ready" are NOT command invocations. Only an explicit \`/review\` triggers this command. If the user sends free-text implying a review, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with a \`Next action:\` line based on the current phase and report findings.

## Done-when

- Compliance report is generated and presented to the user.
- Verification review checked for repo-native candidates vs generic command mismatches.
- Findings and actionable recommendations are shown.
- Phase has reached REVIEW_COMPLETE.
- Response ends with a \`Next action:\` line.
`,

  'architecture.md': `\
---
description: Create or revise an Architecture Decision Record (ADR) in MADR format.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Create or revise an Architecture Decision Record (ADR) for the current FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists and is in READY or ARCHITECTURE phase.
   - If no session exists, report this and stop.
   - If the session is not in READY or ARCHITECTURE phase, report the current phase and stop.

2. If in READY phase (new ADR):
   - Gather the architecture decision context from the user's request.
   - Generate an ADR in MADR format with these mandatory sections: \`## Context\`, \`## Decision\`, \`## Consequences\`.
   - Call \`flowguard_architecture\` with \`id\` (format: ADR-<number>), \`title\`, and \`adrText\`.

3. If in ARCHITECTURE phase (revision after changes_requested):
   - Read the review feedback from the session state.
   - Revise the ADR based on the feedback.
   - Call \`flowguard_architecture\` with the updated \`id\`, \`title\`, and \`adrText\`.

4. The tool will run a self-review loop automatically. If it returns in ARCH_REVIEW phase, the ADR is ready for human review.

5. Report the result to the user:
   - Show the ADR title and ID.
   - Show the current phase.
   - Indicate whether human review is needed.

## Constraints

- The ADR MUST include \`## Context\`, \`## Decision\`, and \`## Consequences\` sections.
- The ADR ID MUST match the format \`ADR-<number>\` (e.g., ADR-1, ADR-42).
- DO NOT skip the flowguard_architecture tool call.
- DO NOT ask the user anything. Do not use the \`question\` tool or present selectable choices.
- DO NOT explain what you are about to do. Just call the tool.
- DO NOT auto-chain to /review-decision or any other FlowGuard command after the architecture tool completes.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "write an ADR", "architecture decision", or "design doc" are NOT command invocations. Only an explicit \`/architecture\` triggers this command.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with a \`Next action:\` line based on the current phase.

## Done-when

- ADR is created or revised with Context, Decision, and Consequences sections.
- Self-review loop has converged.
- Phase has reached ARCH_REVIEW (ready for human review).
- Response ends with a \`Next action:\` line.
`,

  'abort.md': `\\
---
description: Emergency termination of the FlowGuard session.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Abort the FlowGuard session.

Reason: $ARGUMENTS

## Steps

1. Call \`flowguard_status\` to verify a session exists.
   - If no session exists, report "No session to abort" and stop.
   - If the session is already COMPLETE, report it is already terminal and stop.

2. Confirm with the user:
   - Report the current phase and any work that will be preserved (all evidence remains in state).
   - The session will be marked as ABORTED at COMPLETE phase.
   - This is irreversible — a new session must be started with /hydrate.

3. Call \`flowguard_abort_session\` with:
   - \`reason\`: The reason from \`$ARGUMENTS\`, or "Session aborted by user" if no reason was provided.

4. Report the result: confirm the session has been terminated and that /hydrate can start a new one.

## Constraints

- DO NOT abort without informing the user of the consequences.
- If no reason is provided in $ARGUMENTS, use "Session aborted by user" as the default reason.
- After aborting, DO NOT attempt any further FlowGuard workflow actions. The session is terminal.
- DO NOT auto-chain to /hydrate or any other FlowGuard command after abort completes.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "stop", "cancel", "nevermind", or "forget it" are NOT command invocations. Only an explicit \`/abort\` triggers this command. If the user sends free-text implying cancellation, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After successful abort: \`Next action: run /hydrate to start a new session, or /review to inspect the aborted session.\`

## Done-when

- User is informed of consequences before abort.
- Session is terminated via flowguard_abort_session.
- Session is marked COMPLETE with ABORTED error.
- Response ends with exactly one \`Next action:\` line.
`,

  'archive.md': `\
---
description: Archive a completed FlowGuard session as a compressed tar.gz file.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Archive the current (or a specified) completed FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists.
   - If no session exists, report "No session to archive" and stop.

2. Call \`flowguard_archive\` with no arguments.
   - The tool archives the current session if it is in a terminal phase (COMPLETE, ARCH_COMPLETE, or REVIEW_COMPLETE).
   - The archive is stored in the workspace sessions/archive/ directory.

3. Read the response and report:
   - The archive file path.
   - Confirmation that the session data was archived successfully.

## Constraints

- Only terminal sessions (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) can be archived.
- If the session is not in a terminal phase, report the current phase and tell the user to complete or abort the session first.
- DO NOT modify any FlowGuard state.
- DO NOT auto-chain to other FlowGuard commands after archiving.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "archive", "save", "compress", or "backup" are NOT command invocations. Only an explicit \`/archive\` triggers this command. If the user sends free-text implying archiving, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After successful archive: \`Next action: run /hydrate to start a new session.\`

## Done-when

- Session archive is created as tar.gz file.
- Archive file path is reported to the user.
- Response ends with exactly one \`Next action:\` line.
`,
};
