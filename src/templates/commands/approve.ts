export const APPROVE_COMMAND = `
---
description: Approve the currently active review gate (plan, implementation evidence, or architecture).
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Approve the currently active review gate by invoking the canonical FlowGuard review-decision tool.

Decision context: $ARGUMENTS

## Steps

1. Call \`flowguard_decision\` with:
   - \`verdict\`: "approve"
   - \`rationale\`: \`$ARGUMENTS\` if non-empty, otherwise empty string.

2. Read the returned JSON. If FlowGuard blocks the decision (not in a review gate, insufficient assurance, etc.), report the blocked reason and stop. Never attempt to work around a blocked decision.

3. On success, report:
   - What was approved (plan, implementation evidence, or architecture ADR).
   - The new phase label.
   - The next action.

## Constraints

- DO NOT call flowguard_decision if no session exists. Call flowguard_status first in that case.
- If FlowGuard blocks the decision because the current phase is not a review gate, report the blocked reason and stop. Never attempt to work around a blocked decision.
- DO NOT fabricate a verdict. Always use "approve" for this command.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain to other FlowGuard commands after the decision is recorded.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- The approval target is determined by the current phase — flowguard_decision handles the routing deterministically. Do not attempt to reinterpret or route the decision yourself.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line stating the next workflow step based on the new phase.

## Done-when

- Approval verdict is recorded via flowguard_decision.
- Phase transition and next action are reported to the user.
- Response ends with exactly one \`Next action:\` line.
`;
