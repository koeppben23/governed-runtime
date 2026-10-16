import { renderCommandGovernanceRules } from '../mandates.js';

export const VALIDATE_COMMAND = `---
description: FlowGuard — Run verification checks on the approved plan.
---

You are managing a FlowGuard-controlled development workflow.

## Important

FlowGuard executes verification commands directly via \`flowguard_run_check\`. You do NOT need to run commands yourself — FlowGuard's runtime executor handles subprocess execution and produces cryptographic evidence (output digest, exit code, timing).

## Goal

Execute all active verification checks for the FlowGuard session.

## Test quality (advisory)

FlowGuard executes the discovered checks; it does not judge their quality. When the validating checks include tests and you have any influence over them, favor checks that exercise observable behavior through public interfaces over checks coupled to internal structure. A check that breaks on an internal refactor without a behavior change is a weak signal. This guidance never changes which checks run or how \`flowguard_run_check\` executes them.

## Steps

1. Call \`flowguard_status({ compact: true })\` so the compact canonical projection is returned (full rule/mandate text bodies are digest-addressed; call without \`compact\` only when the complete text is required), and verify a session exists in VALIDATION phase with an approved plan.
   - If not in VALIDATION: report the current phase and stop.

2. Read \`activeChecks\` and \`verificationCandidates\` from the status response (\`remainingChecks\` is NOT equivalent: it lists only the active checks that have no passing result yet). Each active check corresponds to a discovered verification kind (e.g., \`test\`, \`lint\`, \`typecheck\`, \`build\`). If you see no checks, re-read status WITHOUT focused flags before concluding there are none — focused projections are not the source for checks.

3. For EACH active check kind, call \`flowguard_run_check({ kind: "<kind>" })\`:
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
${renderCommandGovernanceRules()}
## Done-when

- All active checks have been executed via flowguard_run_check.
- Phase advanced to IMPLEMENTATION (all passed) or returned to PLAN (any failed).
- If \`presentation.markdown\` is present, render it verbatim and do not append a separate \`Next action:\` line.
- Otherwise, render the canonical \`directive\` as the single fallback conclusion.
`;
