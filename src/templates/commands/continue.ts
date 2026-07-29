import { GOVERNANCE_RULES } from './shared-rules.js';

export const CONTINUE_COMMAND = `
---
description: Route to the canonical next FlowGuard action for the current phase.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Determine the canonical next workflow action without executing it.

## Steps

1. Call \`flowguard_continue\` to get deterministic guidance for the current phase.
   - If the tool returns \`_continue: { action: "deterministic" }\`, present the canonical
     \`productNextAction\` recommendation. Do not execute another workflow command unless explicitly requested by the user.
   - If the tool returns \`_continue: { action: "manual_decision" }\`, present the decision-required
     context and canonical \`decisionCommands\` to the user.
   - If the tool returns \`_continue: { action: "terminal" }\`, report workflow complete.
   - If the tool blocks (error), present the blocked reason and recovery steps.

2. Do not infer or execute another command unless the tool response explicitly says to do so.

## Rules

- At User Gates (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW): present information and ask the user for their verdict — never decide for them.
- /continue is a routing command — it determines what to do, not blindly executes destructive actions.
- Do not auto-approve or auto-reject at User Gates — human verdicts are mandatory.
${GOVERNANCE_RULES}
## Done-when

- Current phase is identified and its canonical action is reported.
- User is informed of state and next step.
- Response follows the active Presentation Conclusion/fallback convention.
`;
