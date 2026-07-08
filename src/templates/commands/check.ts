import { GOVERNANCE_RULES } from './shared-rules.js';

export const CHECK_COMMAND = `
---
description: Run verification checks on the current implementation evidence.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Run automated verification checks for the current implementation.

## Steps

1. Call \`flowguard_status\` with NO focused flags (no whyBlocked/evidence/context/readiness) so the full projection is returned, then read \`activeChecks\` (equivalently \`remainingChecks\` in VALIDATION) and \`verificationCandidates\`.
2. If \`activeChecks\` is empty AND \`verificationCandidates\` is empty, report that no verification checks are active (no discoverable commands).
3. For each kind in \`activeChecks\` (or \`remainingChecks\`), call \`flowguard_run_check({ kind: "<kind>" })\`.
   - FlowGuard executes the discovered command and returns execution evidence.
   - You may also call \`flowguard_run_check({ kind: "<kind>" })\` directly for any kind in \`verificationCandidates\`; it validates the kind against canonical state, not against the status output.
4. Report which checks passed, which failed, and whether the workflow can proceed.
${GOVERNANCE_RULES}
## Done-when

- If both \`activeChecks\` and \`verificationCandidates\` are empty: report no active checks.
- All active checks executed via flowguard_run_check.
- Results and next action reported.
- Response ends with \`Next action:\` line.
`;
