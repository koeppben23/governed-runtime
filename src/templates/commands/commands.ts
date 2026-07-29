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
3. If \`verbose\` is false or omitted, read the returned Markdown command list and present it
   verbatim. Do not summarize or restructure it.
4. If \`verbose\` is true, the result is JSON. Present its structured fields without claiming it
   is Markdown.

## Rules

- /commands is read-only. It never changes lifecycle, evidence, or archive state.
- Do not claim a command is available without the FlowGuard result.
${GOVERNANCE_RULES}

## Done-when

- Commands were retrieved through \`flowguard_help\`.
- Standard Markdown command list rendered verbatim, or verbose JSON rendered as structured data.
`;
