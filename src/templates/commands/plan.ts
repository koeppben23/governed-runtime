export const PLAN_COMMAND = `
---
description: Generate a plan with mandatory independent subagent review for the current task.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Generate a comprehensive implementation plan for the current ticket, then obtain mandatory independent review.

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
5. Read the response. It will contain a \`next\` field and a \`reviewMode\` field that determine whether plugin-provided findings are already available or the reviewer subagent must be called manually.

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
       - If independent review converged: Report the final status to the user. If the response contains a \`reviewCard\` field, present it in full without modification or summarisation.
       - If another iteration is needed: Go back to step 6.

    **Path A2: Required Manual Subagent Review (when \`next\` starts with "INDEPENDENT_REVIEW_REQUIRED")**

   The plugin has not completed the reviewer call. You must call the flowguard-reviewer subagent manually. Do not perform self-review.

   a. Call the Task tool with:
      - \`subagent_type\`: \`"flowguard-reviewer"\`
      - \`prompt\`: Include the full plan text, the ticket text, and specify \`iteration\` and \`planVersion\` as indicated in the tool response.
   b. Read the subagent response. It will be a JSON object matching the ReviewFindings schema.
   c. Parse the \`overallVerdict\` from the ReviewFindings:
      - If \`overallVerdict\` is \`"approve"\`: Call \`flowguard_plan\` with \`selfReviewVerdict: "approve"\` and \`reviewFindings\` set to the parsed JSON object.
      - If \`overallVerdict\` is \`"changes_requested"\`: Review the \`blockingIssues\` and \`majorRisks\` from the findings. Revise the plan to address them. Call \`flowguard_plan\` with \`selfReviewVerdict: "changes_requested"\`, \`planText\` set to the complete revised plan, and \`reviewFindings\` set to the parsed JSON object.
   d. Read the response:
       - If independent review converged: Report the final status to the user. If the response contains a \`reviewCard\` field, present it in full without modification or summarisation.
       - If another iteration is needed: Go back to step 6.

## Constraints

- DO NOT generate a plan with vague steps like "implement the feature" or "add error handling". Every step must be specific.
- DO NOT skip the review. You MUST either use plugin-provided findings (Path A1) or call the flowguard-reviewer subagent manually (Path A2).
- When the tool response indicates INDEPENDENT_REVIEW_COMPLETED, use the \`_pluginReviewFindings\` directly. When it indicates INDEPENDENT_REVIEW_REQUIRED, you MUST call the flowguard-reviewer subagent. DO NOT substitute self-review.
- DO NOT approve a plan that has blocking issues from the independent review.
- When providing a revised plan, you MUST include the COMPLETE plan text, not a diff or partial update.
- The plan MUST include all seven sections listed above (Objective, Approach, Steps, Files to Modify, Edge Cases, Validation Criteria, Verification Plan).
- In Verification Plan, use flowguard_status.verificationCandidates when available. Cite the specific command AND its Source (e.g., "Source: package.json:scripts.test").
- If no repo-native verification candidate is available, state "NOT_VERIFIED" and provide recovery steps (e.g., "inspect package scripts / build wrapper / CI config").
- DO NOT invent verification commands. Always cite the Source when using verificationCandidates.
- DO NOT call any implementation tools (write, edit, bash for code changes). Planning only.
- The independent review loop runs up to 3 iterations maximum.
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
- Independent review loop has converged (approved or max 3 iterations reached).
- Phase has advanced to PLAN_REVIEW.
- Response ends with exactly one \`Next action:\` line.
`;
