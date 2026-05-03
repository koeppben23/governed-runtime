import { GOVERNANCE_RULES } from './shared-rules.js';

export const TASK_COMMAND = `
---
description: Capture a governed task description with optional external references.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Record a governed task description for the Ticket flow.

Task description: $ARGUMENTS

## Steps

1. Call \`flowguard_status\` to verify a session exists in READY or TICKET phase.
   - If phase does not allow task capture: report this and stop.

2. If \`$ARGUMENTS\` is empty: ask the user to describe their task (never invent content).
   If \`$ARGUMENTS\` contains "--ref": parse the reference (Jira URL, ADO work item, GitHub Issue, PR URL, branch, or commit SHA) and pass as \`references[]\`.

3. Call \`flowguard_ticket({ text: "<task description>", source: "user", references })\` with the task description.

4. Report the confirmed task, current phase, and next action.

## Rules

- Use exactly what the user provided — never fabricate task content.
- Only call flowguard_ticket when phase allows it (READY or TICKET).
${GOVERNANCE_RULES}
## Done-when

- Task recorded via flowguard_ticket.
- Phase and next action reported.
- Response ends with \`Next action: run /plan to generate an implementation plan.\`
`;
