import { GOVERNANCE_RULES } from './shared-rules.js';

export const REVIEW_DECISION_COMMAND = `
---
description: Submit a human review decision (approve, changes_requested, reject) at a User Gate.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Record a human review decision for the current User Gate.

Decision: $ARGUMENTS

## Steps

1. Call \`flowguard_status\` to verify the phase is a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW).
   - If not at a User Gate: report the current phase and stop.

2. Parse the decision from \`$ARGUMENTS\`:
   - First word: verdict (one of \`approve\`, \`changes_requested\`, \`reject\`)
   - Remaining text: rationale (optional)
   - If \`$ARGUMENTS\` is empty or unclear: ask the user for their decision.

3. Call \`flowguard_decision({ verdict, rationale })\`.

4. Report the outcome:
   - **approve**: Confirm advancement, show new phase.
   - **changes_requested**: Explain workflow returns to revision phase.
   - **reject**: Explain workflow returns to start (PLAN_REVIEW/EVIDENCE_REVIEW → TICKET; ARCH_REVIEW → READY).

## Rules

- Use exactly the verdict the user provided — never fabricate or assume.
- Valid verdicts: approve, changes_requested, reject (nothing else).
- If ambiguous input ("maybe", "not sure"): ask the user to clarify.
- Do not approve without the user's explicit verdict — never infer approval from context.
${GOVERNANCE_RULES}
## Done-when

- Verdict recorded via flowguard_decision.
- Phase transition reported to user.
- Response ends with \`Next action:\` line.
`;
