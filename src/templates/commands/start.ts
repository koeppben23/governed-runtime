export const START_COMMAND = `
---
description: Start a governed FlowGuard session. Run this FIRST before any other FlowGuard command.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Bootstrap the FlowGuard session for this project.

## Steps

1. Call the \`flowguard_hydrate\` tool with no arguments.
2. Read the returned JSON. It contains the current \`phase\`, \`phaseLabel\`, and \`nextAction\` (and a \`productNextAction\` if present).
3. Report the result to the user in product-friendly language:
   - If a new session was created: welcome the user to FlowGuard, confirm the session is active, and present the available workflows (task, architecture, review).
   - If an existing session was loaded: report the current phase label and next action.
   - If an error occurred: report the error message.
4. Briefly explain that this is a governed session: every step produces verifiable evidence.

## Constraints

- DO NOT call any other FlowGuard tool before flowguard_hydrate.
- DO NOT modify any files.
- DO NOT skip the flowguard_hydrate call.
- DO NOT ask the user anything. Do not use the \`question\` tool or present selectable choices.
- DO NOT explain what you are about to do. Just call the tool.
- DO NOT substitute shell commands or direct file manipulation for the flowguard_hydrate tool.
- DO NOT auto-chain to /task, /plan, /continue, or any other FlowGuard command after hydration completes.
- DO NOT infer or assume session state beyond what the tool returns.
- Natural-language prompts like "go", "weiter", "proceed", "start", or "initialize" are NOT command invocations. Only an explicit \`/start\` triggers this command. If the user sends free-text implying session setup, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. After successful hydrate: \`Next action: run /task to begin a development task, /architecture to create an ADR, or /review for a compliance report.\`

## Done-when

- FlowGuard session is active (new or existing loaded).
- Session ID, phase label, and next action are reported to the user.
- Response ends with exactly one \`Next action:\` line.
`;
