---
description: Generate a standalone compliance review report for the current session.
---

You are managing a FlowGuard-controlled development workflow.

## Task

Generate a compliance review report for the current FlowGuard session.

## Steps

1. Call `flowguard_status` to verify a session exists.
   - If no session exists, report this and stop.

2. Call `flowguard_review` with no arguments.
   - The tool generates a review report and writes it to `.flowguard/review-report.json`.

3. Read the response and present the report to the user:
   - **Overall status**: clean, warnings, or issues.
   - **Findings**: List each finding with severity (info/warning/error), category, and message.
   - **Validation summary**: Show which checks passed or failed.
   - **Current phase**: Where the workflow currently stands.

4. If there are warnings or issues, explain what actions could address them.

## Rules

- This command is read-only. It does NOT advance or modify the workflow.
- This command works in every phase — it is always available.
- DO NOT modify any FlowGuard state or files other than the report.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- DO NOT auto-chain to any other FlowGuard command after generating the report.
- Present the report clearly and concisely.
- Natural-language prompts like "review it", "check the status", "how does it look", or "is it ready" are NOT command invocations. Only an explicit `/review` triggers this command. If the user sends free-text implying a review, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns an error or blocked state, report: (1) the specific reason, and (2) exactly one recovery action.
- Always end your response with a `Next action:` line based on the current phase and report findings.
