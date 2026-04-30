import { GOVERNANCE_RULES } from './shared-rules.js';

export const REQUEST_CHANGES_COMMAND = `
---
description: Request changes on the currently active review gate.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Request changes at the currently active review gate.

Change request: $ARGUMENTS

## Steps

1. Call \`flowguard_decision({ verdict: "changes_requested", rationale })\` with rationale from \`$ARGUMENTS\` (or empty string).

2. If FlowGuard blocks the decision: report the reason and stop.

3. On success, report what was sent back for revision, the new phase, and next action.

## Rules

- Always use "changes_requested" as the verdict for this command.
- If blocked: report the reason and stop (never work around a blocked decision).
${GOVERNANCE_RULES}
## Done-when

- Changes-requested verdict recorded via flowguard_decision.
- Phase transition and next action reported.
- Response ends with \`Next action:\` line.
`;
