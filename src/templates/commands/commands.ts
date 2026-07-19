import { GOVERNANCE_RULES } from './shared-rules.js';

export const COMMANDS_COMMAND = `
---
description: List FlowGuard commands available in the current context.
---

## Goal

Show the currently available FlowGuard commands, or the complete reference.

## Steps

1. Parse optional flags from \`$ARGUMENTS\`:
   - no flags: use \`{ view: "commands", scope: "available" }\`
   - \`--all\`: use \`{ view: "commands", scope: "all" }\`
   - \`--verbose\`: include \`verbose: true\`
2. Call \`flowguard_help\` with the parsed arguments.
3. Read the returned Markdown command list. Present it verbatim. The Markdown contains phase,
   readiness, next action, and available commands. Do not summarize or restructure it.

## Rules

- /commands is read-only. It never changes lifecycle, evidence, or archive state.
- Do not claim a command is available without the FlowGuard result.
${GOVERNANCE_RULES}

## Done-when

- Commands were retrieved through \`flowguard_help\`.
- Markdown command list rendered verbatim.
`;
