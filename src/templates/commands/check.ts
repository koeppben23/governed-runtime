export const CHECK_COMMAND = `
---
description: Run validation checks on the current implementation evidence.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Run automated validation checks for the current implementation.

## Steps

1. Call \`flowguard_status\` to verify a session exists.

2. Call \`flowguard_validate\` with no arguments.

3. Read the returned JSON and report:
   - Which checks passed and which failed.
   - Whether the workflow can proceed to the next governed step.
   - The next action.

## Constraints

- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain to other FlowGuard commands after validation completes.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line.

## Done-when

- Validation checks are run via flowguard_validate.
- Check results and next action are reported to the user.
- Response ends with exactly one \`Next action:\` line.
`;
