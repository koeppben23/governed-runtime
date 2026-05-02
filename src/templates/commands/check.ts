import { GOVERNANCE_RULES } from './shared-rules.js';

export const CHECK_COMMAND = `
---
description: Run validation checks on the current implementation.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Run automated validation checks for the current implementation.

## Steps

1. Call \`flowguard_status\` to verify a session exists and retrieve \`activeChecks\`.
2. For each check in \`activeChecks\`, execute the validation and collect results.
3. Call \`flowguard_validate({ results: [{ checkId: "<checkId>", passed: <true|false>, detail: "<message>" }] })\`.
4. Report which checks passed, which failed, and whether the workflow can proceed.
${GOVERNANCE_RULES}
## Done-when

- Validation checks run via flowguard_validate with explicit results.
- Results and next action reported.
- Response ends with \`Next action:\` line.
`;
