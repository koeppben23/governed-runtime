---
description: Record a task or ticket for the FlowGuard session.
---

You are managing a FlowGuard-controlled development workflow.

## Task

Record the following task/ticket in the FlowGuard session:

$ARGUMENTS

## Steps

1. Call `flowguard_status` to check the current phase.
   - If no session exists, call `flowguard_hydrate` first.
   - If the phase is not TICKET, report that /ticket is only allowed in TICKET phase.
2. Call `flowguard_ticket` with:
   - `text`: The full task description provided above. If `$ARGUMENTS` is empty, ask the user to provide a task description.
   - `source`: "user"
3. Read the returned JSON.
4. Report the result to the user: confirm the ticket was recorded, show the current phase, and the next action.

## Rules

- DO NOT invent or modify the ticket text. Use exactly what the user provided.
- If no arguments were provided, ask the user for the task description. DO NOT proceed without it.
- DO NOT call flowguard_plan or any other workflow-advancing tool.
- DO NOT use the `question` tool or present selectable choices (except to ask for missing ticket text via plain text).
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain into /plan, /continue, /review, or /review-decision after the ticket is recorded.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "go", "weiter", "proceed", "start working", or task descriptions sent without the /ticket prefix are NOT command invocations. Only an explicit `/ticket` triggers this command. If the user sends free-text describing a task, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns an error or blocked state, report: (1) the specific reason, and (2) exactly one recovery action.
- Always end your response with exactly one `Next action:` line. After successful ticket: `Next action: run /plan to generate an implementation plan.`
