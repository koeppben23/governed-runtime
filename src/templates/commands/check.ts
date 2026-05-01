import { GOVERNANCE_RULES } from './shared-rules.js';

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
3. Report which checks passed, which failed, and whether the workflow can proceed.
${GOVERNANCE_RULES}
## Done-when

- Validation checks run via flowguard_validate.
- Results and next action reported.
- Response ends with \`Next action:\` line.
`;
