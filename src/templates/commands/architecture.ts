import { GOVERNANCE_RULES } from './shared-rules.js';

export const ARCHITECTURE_COMMAND = `
---
description: Create or revise an Architecture Decision Record (ADR) in MADR format.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Create or revise an Architecture Decision Record (ADR) for the current FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists in READY or ARCHITECTURE phase.
   - If not: report the current phase and stop.

2. If in READY phase (new ADR):
   - Gather the architecture decision context from the user's request.
   - Generate an ADR in MADR format with mandatory sections: \`## Context\`, \`## Decision\`, \`## Consequences\`.
   - Call \`flowguard_architecture({ id, title, adrText })\` with id format \`ADR-<number>\`.

3. If in ARCHITECTURE phase (revision after changes_requested):
   - Read the review feedback from session state.
   - Revise the ADR to address the feedback.
   - Call \`flowguard_architecture({ id, title, adrText })\` with the updated content.

4. The tool runs the ADR review loop automatically. When it returns in ARCH_REVIEW phase, the ADR is ready for human review.

5. Report the ADR title, ID, current phase, and whether human review is needed.

## Rules

- The ADR includes \`## Context\`, \`## Decision\`, and \`## Consequences\` sections.
- The ADR ID matches format \`ADR-<number>\` (e.g., ADR-1, ADR-42).
- Call the tool immediately — explain only after.
- Do not call implementation tools (write/edit/bash) during /architecture.
- Do not auto-chain into /plan or /implement after ADR approval.
- If the tool returns BLOCKED with code \`SUBAGENT_UNABLE_TO_REVIEW\`: the independent reviewer declared the ADR unreviewable (e.g., contradictory context, missing prerequisites, or scope ambiguity). Stop the review loop. Treat the obligation as consumed (no retry). Report the reviewer's findings to the user, then either resolve the prerequisite ambiguity OR submit a substantially-revised ADR (a fresh \`flowguard_architecture({ id, title, adrText })\` call starts a new review obligation).
${GOVERNANCE_RULES}
## Done-when

- ADR is created or revised with Context, Decision, and Consequences sections.
- ADR review loop has converged.
- Phase has reached ARCH_REVIEW (ready for human review).
- Response ends with a \`Next action:\` line.
`;
