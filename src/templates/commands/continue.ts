import { GOVERNANCE_RULES } from './shared-rules.js';

export const CONTINUE_COMMAND = `
---
description: Continue the FlowGuard workflow — do the next thing based on the current phase.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Determine what the workflow needs next and do it.

## Steps

1. Call \`flowguard_continue\` to get deterministic guidance for the current phase.
   - If the tool returns \`_continue: { action: "deterministic" }\`, present the \`next\` command as the deterministic recommendation. Do not execute another workflow command unless explicitly requested by the user.
   - If the tool returns \`_continue: { action: "manual_decision" }\`, present the blocked reason + recommended commands to the user.
   - If the tool returns \`_continue: { action: "terminal" }\`, report workflow complete.
   - If the tool blocks (error), present the blocked reason and recovery steps.

2. Do not infer or execute another command unless the tool response explicitly says to do so.

## Rules

- At User Gates (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW): present information and ask the user for their verdict — never decide for them.
- Always check status before taking any action.
- /continue is a routing command — it determines what to do, not blindly executes destructive actions.
- Do not auto-approve or auto-reject at User Gates — human verdicts are mandatory.
${GOVERNANCE_RULES}
## Done-when

- Current phase is identified and appropriate action taken or reported.
- User is informed of state and next step.
- Response ends with exactly one \`Next action:\` line.
`;
