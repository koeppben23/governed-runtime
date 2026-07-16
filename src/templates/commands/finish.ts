import { GOVERNANCE_RULES } from './shared-rules.js';

export const FINISH_COMMAND = `
---
description: Show the read-only Finish Card before export / PR / archive.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Show the read-only Finish Card: a curated overview of session readiness before
/export, PR, or archive decisions. /finish is a status aggregator, not an
approval, merge, or archive-finalization command.

## Steps

1. Call \`flowguard_status\` with exactly \`{ finish: true }\`.
2. If no session exists: report this and recommend \`/hydrate\`. Stop.
3. Report the Finish Card concisely:
   - overallStatus (READY, READY_WITH_WARNINGS, BLOCKED, NOT_VERIFIED)
   - blockers and warnings
   - evidence completeness (missing/failed shown as NOT_VERIFIED, never as pass)
   - actionGuidance (recommended / not_recommended / not_verified)
   - exitOptions

## Rules

- /finish is read-only — never modify files or workflow state.
- Report only what \`flowguard_status\` returns — never invent governance semantics.
- actionGuidance labels are presentation-only. They are NOT approvals and NOT
  command-policy. Never treat them as permission to act.
- Never approve, never consume obligations, never trigger /export, PR, merge, or
  archive. Offer next actions only; the user decides.
- Never render an exit option (e.g. abandon) as forbidden.
${GOVERNANCE_RULES}
## Done-when

- Finish Card retrieved via \`flowguard_status\` with \`{ finish: true }\`.
- Output reflects canonical runtime truth without approval or mutation.
- Response ends with \`Next action:\` line.
`;
