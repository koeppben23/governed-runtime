import { GOVERNANCE_RULES } from './shared-rules.js';

export const HYDRATE_COMMAND = `
---
description: Bootstrap or reload the FlowGuard session. Run this FIRST before any other FlowGuard command.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Bootstrap the FlowGuard session for this project.

## Steps

1. Call \`flowguard_hydrate\` with no arguments.
2. Read the returned JSON (\`phase\`, \`next\` action).
3. Report the result:
   - New session: confirm the session ID and READY phase.
   - Existing session loaded: report current phase and next action.
   - Error: report the error message.

## Rules

- Call \`flowguard_hydrate\` as the first and only FlowGuard tool in this command.
- Do not modify files or call other FlowGuard tools during /hydrate.
${GOVERNANCE_RULES}
## Done-when

- FlowGuard session is active (new or existing loaded).
- Session ID, phase, and next action are reported.
- Response ends with \`Next action: run /ticket to start a task, /architecture to create an ADR, or /review for a compliance report.\`
`;
