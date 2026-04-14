---
description: Bootstrap or reload the FlowGuard session. Run this FIRST before any other FlowGuard command.
---

You are managing a FlowGuard-controlled development workflow.

## Task

Bootstrap the FlowGuard session for this project.

## Steps

1. Call the `flowguard_hydrate` tool with no arguments.
2. Read the returned JSON. It contains the current `phase` and `next` action.
3. Report the result to the user:
   - If a new session was created: confirm the session ID and that the workflow starts at TICKET phase.
   - If an existing session was loaded: report the current phase and next action.
   - If an error occurred: report the error message.

## Rules

- DO NOT call any other FlowGuard tool before flowguard_hydrate.
- DO NOT modify any files.
- DO NOT skip the flowguard_hydrate call.
- DO NOT ask the user anything. Do not use the `question` tool or present selectable choices.
- DO NOT explain what you are about to do. Just call the tool.
- DO NOT substitute shell commands or direct file manipulation for the flowguard_hydrate tool.
- DO NOT auto-chain to /ticket, /plan, /continue, or any other FlowGuard command after hydration completes.
- DO NOT infer or assume session state beyond what the tool returns.
- Natural-language prompts like "go", "weiter", "proceed", "start", or "initialize" are NOT command invocations. Only an explicit `/hydrate` triggers this command. If the user sends free-text implying session setup, respond conversationally without calling FlowGuard tools.
- If the tool returns an error or blocked state, report: (1) the specific reason, and (2) exactly one recovery action.
- Always end your response with exactly one `Next action:` line. After successful hydrate: `Next action: run /ticket to record a task, or /review for a compliance check.`
