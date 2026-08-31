import { GOVERNANCE_RULES } from './shared-rules.js';

export const EXTEND_IMPLEMENTATION_REVIEW_COMMAND = `
---
description: Authorize more independent implementation review iterations after budget exhaustion.
agent: build
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Authorize a finite additional independent implementation review budget after the existing budget was exhausted with \`changes_requested\`.

## Steps

1. Call \`flowguard_extend_implementation_review({ additionalIterations })\` with the exact positive finite integer budget the user authorized.
2. After FlowGuard confirms authorization, make the requested implementation changes from the reviewer's blocking issues.
3. Call \`flowguard_implement({})\` separately to re-record the implementation, then continue the review loop (validation, challenge resolution, fresh independent review).

## Rules

- Provide a positive finite integer for \`additionalIterations\`; never invent a budget the user did not authorize.
- This is an explicit user authorization: the tool consumes the recorded \`/extend-implementation-review <integer>\` command intent. If the intent is missing, mismatched, or the review budget is not yet exhausted, the call is BLOCKED and the authorization is NOT recorded. Never bypass the missing authorization.
- This command only opens the finite review budget. It never records implementation evidence, runs validation, or submits a review verdict.
- Do not auto-extend or self-authorize additional review iterations.
${GOVERNANCE_RULES}
## Done-when

- The independent implementation review is unblocked with exactly the finite budget the user authorized.
- The authorization is appended to the session's implementationReviewExtensions evidence.
- No implementation evidence, validation result, or review verdict was recorded by this command.
- If the author changes code, the changes are recorded separately via \`flowguard_implement({})\` and validated before the next review.
`;
