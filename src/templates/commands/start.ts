import { GOVERNANCE_RULES } from './shared-rules.js';

export const START_COMMAND = `
---
description: Start a governed FlowGuard session. Run this FIRST before any other FlowGuard command.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Bootstrap the FlowGuard session for this project.

## Steps

1. Call \`flowguard_hydrate\` with no arguments.
2. Read the returned JSON (\`phase\`, \`phaseLabel\`, \`nextAction\`, optional \`productNextAction\`).
3. Report the result in product-friendly language:
   - New session: welcome the user, confirm the session is active, present available workflows (task, architecture, review).
   - Existing session loaded: report current phase label and next action.
   - Error: report the error message.
4. Briefly note this is a governed session — every step produces verifiable evidence.

## Rules

- Call \`flowguard_hydrate\` as the first and only FlowGuard tool in this command.
- Do not modify files or call other FlowGuard tools during /start.
${GOVERNANCE_RULES}
## Done-when

- FlowGuard session is active (new or existing loaded).
- Session ID, phase label, and next action are reported.
- Response ends with \`Next action: run /task to begin a development task, /architecture to create an ADR, or /review for a compliance report.\`
`;
