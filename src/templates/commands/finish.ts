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
3. If \`presentation.markdown\` is present in the response, output it verbatim —
   do not rephrase or interpret it.
   Otherwise output the \`finish\` object without inventing semantics.

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
- If \`presentation.markdown\` was present, it was printed verbatim and its
  rendered conclusion (the trailing \`→\`/\`•\` command line or the
  \`## Decision required\` block) is the next-action guidance — do NOT append a
  separate \`Next action:\` line.
- Only on the fallback projection (no \`presentation.markdown\`): response ends
  with a \`Next action:\` line.
`;
