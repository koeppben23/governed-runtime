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
2. Read the \`blocker\` field (\`reasonText\`, \`reasonCode\`).
3. Report in plain language: what is blocking, why, and exactly one recommended command to resolve it.

## Rules

- Use only the recovery guidance from the tool output — never guess how to resolve a block.
${GOVERNANCE_RULES}
## Done-when

- Blocker reason and recovery action reported.
- Response ends with \`Next action:\` line with the recommended command.
`;
