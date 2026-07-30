## Status

**Phase:** Complete
**Readiness:** ready

## Next

`/status` — Show the current phase and next action.

## Available commands

- **`/status`** — Show the current phase and next action.
- `/continue` — Route to the next workflow step.
- `/abort` — End the current workflow without presenting it as completed.
- `/start` — Prepare or restore a governed session.
- `/export` — Export audit package as tar.gz (redactionMode: none|basic|pseudonymous, default basic; includeRaw: true|false, default false). (aliases: `/archive`)
- `/why` — Explain the current runtime blocker.

**Session artifacts:**
ticket: available "Fix the auth bug in login.ts" (digest: digest-o...)
current plan v1: available "## Plan" (digest: digest-o...)
