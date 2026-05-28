import { GOVERNANCE_RULES } from './shared-rules.js';

export const VALIDATE_COMMAND = `
---
description: Run verification checks on the approved plan.
---

You are managing a FlowGuard-controlled development workflow.

## Important

FlowGuard executes verification commands directly via \`flowguard_run_check\`. You do NOT need to run commands yourself — FlowGuard's runtime executor handles subprocess execution and produces cryptographic evidence (output digest, exit code, timing).

## Goal

Execute all active verification checks for the FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists in VALIDATION phase with an approved plan.
   - If not in VALIDATION: report the current phase and stop.

2. Read the active checks and verificationCandidates from the status response. Each active check corresponds to a discovered verification kind (e.g., \`test\`, \`lint\`, \`typecheck\`, \`build\`).

3. For EACH active check, call \`flowguard_run_check({ kind: "<kind>" })\`:
   - FlowGuard will execute the discovered command for that kind.
   - The tool returns execution evidence: exit code, timing, output digest, pass/fail.
   - If the check times out, it is recorded as failed with timedOut: true.

4. After all checks are executed, report results:
   - Which passed (exit code 0), which failed (non-zero exit code).
   - If ALL passed → phase advances to IMPLEMENTATION.
   - If ANY failed → phase returns to PLAN (plan must be revised).

## Rules

- Execute ALL active checks — skipping is not allowed.
- Do NOT attempt to run verification commands yourself (via bash, etc.) — use flowguard_run_check exclusively.
- Each \`flowguard_run_check\` call executes exactly one verification kind.
- If a check fails, review the output to understand what went wrong before reporting.
${GOVERNANCE_RULES}
## Done-when

- All active checks have been executed via flowguard_run_check.
- Phase advanced to IMPLEMENTATION (all passed) or returned to PLAN (any failed).
- Response ends with \`Next action:\` line.
`;
