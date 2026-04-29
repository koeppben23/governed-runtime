export const STATUS_COMMAND = `
---
description: Show the current FlowGuard status surface.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Show canonical, read-only FlowGuard status.

Arguments: $ARGUMENTS

## Steps

1. Parse optional flags from \`$ARGUMENTS\`:
   - \`--why-blocked\`
   - \`--evidence\`
   - \`--context\`
   - \`--readiness\`
2. Call \`flowguard_status\` with:
   - no flags: no args
   - \`--why-blocked\`: \`{ whyBlocked: true }\`
   - \`--evidence\`: \`{ evidence: true }\`
   - \`--context\`: \`{ context: true }\`
   - \`--readiness\`: \`{ readiness: true }\`
3. Read and report the returned payload concisely.
4. If no session exists, report this and recommend \`/hydrate\`.

## Constraints

- \`/status\` is read-only. Never modify files or workflow state.
- Never invent governance semantics. Report only what \`flowguard_status\` returns.
- If flags are unknown, report valid flags and stop.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- Natural-language prompts like "status", "where am I", or "what next" are NOT command invocations. Only an explicit \`/status\` triggers this command.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line.

## Done-when

- Status was retrieved via \`flowguard_status\`.
- Output reflects canonical runtime truth.
- Response ends with exactly one \`Next action:\` line.
`;
