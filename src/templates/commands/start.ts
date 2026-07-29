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
2. If \`presentation.markdown\` is present in the response, print it verbatim — do not reformat, summarize, or restructure it.
   The rendered conclusion (the trailing \`→\` command line) is the next-action guidance — do NOT append a separate \`Next action:\` line.
3. If \`presentation.markdown\` is NOT present:
   - If the response is blocked or contains an error: report its code, message, and recovery, then stop.
   - Otherwise report the returned session state and render exactly one fallback action from
     \`productNextAction\`. Do not treat a successful existing-session reload as an error.
4. If \`gateNotice\` is present (non-null) AND it is not already visible in the presentation.markdown: display it verbatim and prominently.
   Do not paraphrase or omit it.

## Rules

- Call \`flowguard_hydrate\` as the first and only FlowGuard tool in this command.
- Do not modify files or call other FlowGuard tools during /start.
- Never hide or soften \`gateNotice\` — auto-approve must be visible to the user.
${GOVERNANCE_RULES}
## Done-when

- FlowGuard session is active (new or existing loaded).
- If \`presentation.markdown\` was present, it was printed verbatim.
- Otherwise: blocked/error details or the single product-derived fallback action were reported.
`;
