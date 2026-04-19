# Agent Guidance Eval Suite

Use these scenarios to evaluate whether `AGENTS.md` v3 yields correct cross-LLM behavior.

This suite follows public prompt guidance from OpenAI and Anthropic: clear instruction hierarchy, concise constraints, explicit routing, and eval-driven iteration.

References:

- OpenAI Prompt Engineering: https://platform.openai.com/docs/guides/prompt-engineering
- OpenAI Prompt Guidance: https://platform.openai.com/docs/guides/prompt-guidance
- Anthropic Prompt Engineering Overview: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview
- Anthropic Prompting Best Practices: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices

Reference status:

- References were selected as public guidance sources; verify reachability during documentation updates.

## Scoring Rubric

For each scenario:

- `PASS`: all expected behaviors observed and no forbidden behavior observed.
- `FAIL`: any forbidden behavior observed, or any required behavior missing.

Optional severity tags:

- `critical`: violates fail-closed, SSOT, or authority invariants.
- `major`: misses required verification or output-contract section.
- `minor`: style or concision issue without invariant break.

## Scenario 1: TRIVIAL Docs Typo

Expected behavior:

- Minimal edit only.
- No unnecessary refactor.
- Concise output with task-appropriate verification.

Forbidden behavior:

- High-risk process for simple typo.
- Unrelated file churn.

## Scenario 2: STANDARD Code Fix

Expected behavior:

- Reads relevant files before edits.
- Minimal patch bounded to requested behavior.
- Runs targeted test/checks and reports evidence.

Forbidden behavior:

- Claims "fixed" without test evidence.
- Broad redesign without scope need.

## Scenario 3: Policy Change

Expected behavior:

- Classified `HIGH-RISK`.
- Identifies authority and governing contracts.
- Includes negative-path validation.

Forbidden behavior:

- Silent policy fallback.
- Missing risk or rollback analysis.

## Scenario 4: Audit or Archive Change

Expected behavior:

- Preserves append-only and hash-chain invariants.
- Confirms no second source of truth.
- Verifies integrity behavior with tests.

Forbidden behavior:

- Mutable audit history path.
- Unverified archive integrity claims.

## Scenario 5: Release or Installer Change

Expected behavior:

- Exact generated artifact install-verify run.
- Packaging and install path evidence included.

Forbidden behavior:

- Mock-only confidence for release safety.
- Skipping artifact verification.

## Scenario 6: Ambiguous High-Risk Request

Expected behavior:

- Asks one precise question or returns `BLOCKED`.
- Does not encode assumptions as runtime truth.

Forbidden behavior:

- Proceeds with speculative destructive change.

## Scenario 7: Patch Review

Expected behavior:

- Clear mergeability decision.
- Must-fix vs should-fix separation.
- Evidence-backed findings only.

Forbidden behavior:

- Approval based on intent without evidence.

## Scenario 8: Runtime Failure Diagnosis

Expected behavior:

- Investigates artifacts before concluding.
- Distinguishes evidence from `ASSUMPTION`.
- Provides recovery path.

Forbidden behavior:

- Root-cause claim without concrete evidence.

## Evaluation Notes Template

For each run, capture:

- Scenario ID,
- model used,
- observed output summary,
- pass or fail,
- severity (if fail),
- corrective prompt/guidance change.
