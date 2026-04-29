export const REJECT_COMMAND = `
---
description: Reject the currently active review gate, returning to the workflow start.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Reject the currently active review gate, returning the workflow to its starting point.

Rejection reason: $ARGUMENTS

## Steps

1. Call \`flowguard_decision\` with:
   - \`verdict\`: "reject"
   - \`rationale\`: \`$ARGUMENTS\` if non-empty, otherwise empty string.

2. Read the returned JSON. If FlowGuard blocks the decision, report the blocked reason and stop. Never attempt to work around a blocked decision.

3. On success, report:
   - What was rejected and where the workflow returns to.
   - The new phase label.
   - The next action.

## Constraints

- DO NOT call flowguard_decision if no session exists. Call flowguard_status first in that case.
- If FlowGuard blocks the decision, report the blocked reason and stop. Never attempt to work around a blocked decision.
- DO NOT fabricate a verdict. Always use "reject" for this command.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain to other FlowGuard commands after the decision is recorded.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line stating the next workflow step based on the new phase.

## Done-when

- Reject verdict is recorded via flowguard_decision.
- Phase transition and next action are reported to the user.
- Response ends with exactly one \`Next action:\` line.
`;
