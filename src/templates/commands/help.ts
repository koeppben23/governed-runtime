import { GOVERNANCE_RULES } from './shared-rules.js';

export const HELP_COMMAND = `
---
description: Show concise, context-sensitive FlowGuard help.
---

## Goal

Show the commands and next action relevant to the current FlowGuard session.

## Steps

1. Parse optional arguments from \`$ARGUMENTS\`:
   - no arguments: use \`{ view: "context" }\`
   - a command name: use \`{ view: "command", command: "<name>" }\`
   - \`--verbose\`: include \`verbose: true\`
2. Call \`flowguard_help\` with the parsed arguments.
3. Report the returned help exactly and concisely.

## Rules

- /help is read-only. It never changes lifecycle, evidence, or archive state.
- Do not infer availability or blockers yourself; use the FlowGuard result.
${GOVERNANCE_RULES}

## Done-when

- Help was retrieved through \`flowguard_help\`.
- Output reflects the returned FlowGuard projection without inferred availability.
`;
