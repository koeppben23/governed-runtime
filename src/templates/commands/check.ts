import { GOVERNANCE_RULES } from './shared-rules.js';

export const CHECK_COMMAND = `
---
description: Run verification checks on the current implementation evidence.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Run automated verification checks for the current implementation.

## Steps

1. Call \`flowguard_status\` to verify a session exists and read \`activeChecks\` and \`verificationCandidates\`.
2. If \`activeChecks\` is empty, report that no verification checks are active (no discoverable commands).
3. For each check in \`activeChecks\`, call \`flowguard_run_check({ kind: "<kind>" })\`.
   - FlowGuard executes the discovered command and returns execution evidence.
4. Report which checks passed, which failed, and whether the workflow can proceed.
${GOVERNANCE_RULES}
## Done-when

- If \`activeChecks\` is empty: report no active checks.
- All active checks executed via flowguard_run_check.
- Results and next action reported.
- Response ends with \`Next action:\` line.
`;
