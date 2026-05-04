import { GOVERNANCE_RULES } from './shared-rules.js';

export const APPROVE_COMMAND = `
---
description: Approve the currently active review gate (plan, implementation evidence, or architecture).
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Approve the currently active review gate.

Decision context: $ARGUMENTS

## Steps

1. Call \`flowguard_decision({ verdict: "approve", rationale })\` with rationale from \`$ARGUMENTS\` (or empty string).

2. If FlowGuard blocks the decision (not at a review gate, insufficient assurance, etc.): report the reason and stop.

3. On success, report what was approved (plan, implementation, or ADR), the new phase, and next action.

## Rules

- Always use "approve" as the verdict for this command.
- The approval target is determined by the current phase — flowguard_decision handles routing deterministically.
- If blocked: report the reason and stop (never work around a blocked decision).
${GOVERNANCE_RULES}
## Done-when

- Approval recorded via flowguard_decision.
- Phase transition and next action reported.
- Response ends with \`Next action:\` line.
`;
