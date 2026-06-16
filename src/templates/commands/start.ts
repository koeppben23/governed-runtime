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
2. Read the returned JSON (\`phase\`, \`phaseLabel\`, \`nextAction\`, optional \`productNextAction\`, \`policyResolution.effectiveMode\`, \`gateNotice\`).
3. Report the result in product-friendly language:
   - New session: welcome the user, confirm the session is active, state the active policy mode (\`policyResolution.effectiveMode\`), present available workflows (task, architecture, review).
   - Existing session loaded: report current phase label, active policy mode, and next action.
   - Error: report the error message.
4. If \`gateNotice\` is present (non-null), display it verbatim and prominently — it warns that review gates auto-approve without a human decision. Do not paraphrase or omit it.
5. Briefly note this is a governed session — every step produces verifiable evidence.

## Rules

- Call \`flowguard_hydrate\` as the first and only FlowGuard tool in this command.
- Do not modify files or call other FlowGuard tools during /start.
- Never hide or soften \`gateNotice\` — auto-approve must be visible to the user.
${GOVERNANCE_RULES}
## Done-when

- FlowGuard session is active (new or existing loaded).
- Session ID, phase label, active policy mode, and next action are reported.
- If \`gateNotice\` is present, it is shown verbatim.
- Response ends with \`Next action: run /task to begin a development task, /architecture to create an ADR, or /review for a compliance report.\`
`;
