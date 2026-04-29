export const WHY_COMMAND = `
---
description: Explain why the current workflow is blocked and how to unblock it.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Show the user what is blocking progress and how to resolve it.

## Steps

1. Call \`flowguard_status\` with the argument \`whyBlocked: true\`.

2. Read the returned JSON. Focus on the \`blocker\` field:
   - \`blocker.reasonText\`: Human-readable explanation of the block.
   - \`blocker.reasonCode\`: Machine-readable error code.

3. Report to the user in plain language:
   - What is blocking progress.
   - Why it is blocked.
   - Exactly one recommended next command to resolve it.

## Constraints

- DO NOT guess how to resolve the block. Use only the recovery guidance from the tool output.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain to other FlowGuard commands.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line with the recommended command.

## Done-when

- Blocker reason and recovery action are reported to the user.
- Response ends with exactly one \`Next action:\` line.
`;
