export const TASK_COMMAND = `
---
description: Capture a governed task description with optional external references.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Record a governed task description for the Ticket flow.

Task description: $ARGUMENTS

## Steps

1. Call \`flowguard_status\` to verify:
   - A session exists.
   - The current phase is READY or TICKET.
   - If the phase does not allow task capture, report this to the user and stop.

2. If \`$ARGUMENTS\` is empty, ask the user to describe their task. DO NOT invent content.
   If \`$ARGUMENTS\` contains "--ref", parse the reference (a Jira URL, ADO work item, GitHub Issue, PR URL, branch name, or commit SHA). Pass it as \`references[]\` to the tool.

3. Call \`flowguard_ticket\` with:
   - \`ticketText\`: The task description from \`$ARGUMENTS\`
   - \`references\` (optional): Array of external references with type, source, and title

4. Read the returned JSON and report the confirmed task, current phase, and next action.

## Constraints

- DO NOT fabricate a task description. Use exactly what the user provided.
- DO NOT call flowguard_ticket if the current phase is not READY or TICKET.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain to /plan or any other FlowGuard command after the task is recorded.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After successful task capture: \`Next action: run /plan to generate an implementation plan.\`

## Done-when

- Task is recorded via flowguard_ticket.
- Task ID, phase label, and next action are reported to the user.
- Response ends with exactly one \`Next action:\` line.
`;
