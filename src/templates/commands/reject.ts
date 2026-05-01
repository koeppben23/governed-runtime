import { GOVERNANCE_RULES } from './shared-rules.js';

export const REJECT_COMMAND = `
---
description: Reject the currently active review gate, returning to the workflow start.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Reject the currently active review gate.

Rejection reason: $ARGUMENTS

## Steps

1. Call \`flowguard_decision({ verdict: "reject", rationale })\` with rationale from \`$ARGUMENTS\` (or empty string).

2. If FlowGuard blocks the decision: report the reason and stop.

3. On success, report what was rejected, where the workflow returns to, and the next action.

## Rules

- Always use "reject" as the verdict for this command.
- If blocked: report the reason and stop (never work around a blocked decision).
${GOVERNANCE_RULES}
## Done-when

- Reject verdict recorded via flowguard_decision.
- Phase transition and next action reported.
- Response ends with \`Next action:\` line.
`;
