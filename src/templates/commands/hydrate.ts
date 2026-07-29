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
2. If \`presentation.markdown\` is present, print it verbatim — do not reformat, summarize, or
   append a separate \`Next action:\` line. Its rendered conclusion is authoritative.
3. If \`presentation.markdown\` is NOT present:
   - If the response is blocked or contains an error: report its code, message, and recovery, then stop.
   - Otherwise report the returned session state and render exactly one fallback action from
     \`productNextAction\`.

## Rules

- Call \`flowguard_hydrate\` as the first and only FlowGuard tool in this command.
- Do not modify files or call other FlowGuard tools during /hydrate.
${GOVERNANCE_RULES}
## Done-when

- FlowGuard session is active (new or existing loaded).
- A presentation conclusion was rendered verbatim, or one product-derived fallback action was reported.
`;
