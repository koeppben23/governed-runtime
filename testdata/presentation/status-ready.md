## Status

**Phase:** Ready
**Readiness:** In progress
**Policy:** solo

## Verification

No verification obligations declared.
Approval evidence: Not recorded

Diagnostic: `flowguard_status({ proofGraph: true })`

## Decision required

Choose one workflow to start. Nothing runs until you send a command.
- `/task` — Capture the task and start the standard governed flow (recommended)
- `/architecture` — Create or revise an ADR without starting a task flow
- `/review` — Review a diff, branch, PR, or pasted text
