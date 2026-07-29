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
3. If \`presentation.markdown\` is present in the response, print it verbatim — do not reformat
   or interpret it. Otherwise render the focused projection without inventing semantics.
4. If no session exists: report this and recommend \`/start\`.

## Rules

- /status is read-only — never modify files or workflow state.
- Report only what \`flowguard_status\` returns — never invent governance semantics.
- If flags are unknown: report valid flags and stop.
${GOVERNANCE_RULES}
## Done-when

- Status retrieved via \`flowguard_status\`.
- Output reflects canonical runtime truth.
- If \`presentation.markdown\` was present, it was printed verbatim and its
  rendered conclusion (the trailing \`→\`/\`•\` command line or the
  \`## Decision required\` block) is the next-action guidance — do NOT append a
  separate \`Next action:\` line.
- Only on the fallback projection (no \`presentation.markdown\`): derive one action from
  \`productNextAction\`; do not invent a local action.
`;
