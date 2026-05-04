import { GOVERNANCE_RULES } from './shared-rules.js';

export const STATUS_COMMAND = `
---
description: Show the current FlowGuard status surface.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Show canonical, read-only FlowGuard status.

Arguments: $ARGUMENTS

## Steps

1. Parse optional flags from \`$ARGUMENTS\`:
   - \`--why-blocked\` | \`--evidence\` | \`--context\` | \`--readiness\`
2. Call \`flowguard_status\` with the appropriate flag (or no args if none provided).
3. Report the returned payload concisely.
4. If no session exists: report this and recommend \`/hydrate\`.

## Rules

- /status is read-only — never modify files or workflow state.
- Report only what \`flowguard_status\` returns — never invent governance semantics.
- If flags are unknown: report valid flags and stop.
${GOVERNANCE_RULES}
## Done-when

- Status retrieved via \`flowguard_status\`.
- Output reflects canonical runtime truth.
- Response ends with \`Next action:\` line.
`;
