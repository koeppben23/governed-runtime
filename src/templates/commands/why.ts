import { GOVERNANCE_RULES } from './shared-rules.js';

export const WHY_COMMAND = `
---
description: Explain why the current workflow is blocked and how to unblock it.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Show the user what is blocking progress and how to resolve it.

## Steps

1. Call \`flowguard_status({ whyBlocked: true })\`.
2. Read the \`whyBlocked\` object (\`whyBlocked.reasonText\`, \`whyBlocked.reasonCode\`, \`whyBlocked.recoveryHint\`, \`whyBlocked.nextResolvableCommand\`).
3. Wenn \`presentation.markdown\` im Response vorhanden ist, gib es wörtlich
   aus — nicht umformulieren, nicht interpretieren.
   Andernfalls gib die Projektion aus, ohne eigene Semantik zu erfinden.

## Rules

- Use only the recovery guidance from the tool output — never guess how to resolve a block.
${GOVERNANCE_RULES}
## Done-when

- Blocker reason and recovery action reported.
- If \`presentation.markdown\` was present, it was printed verbatim and its
  rendered conclusion (the trailing \`→\`/\`•\` command line or the
  \`## Decision required\` block) is the next-action guidance — do NOT append a
  separate \`Next action:\` line.
- Only on the fallback projection (no \`presentation.markdown\`): response ends
  with a \`Next action:\` line with the recommended command.
`;
