export const VALIDATE_COMMAND = `
---
description: Run validation checks on the approved plan.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Execute validation checks for the FlowGuard session.

## Steps

1. Call \`flowguard_status\` with no arguments to verify:
   - A session exists.
   - The phase is VALIDATION.
   - An approved plan exists.
   - If the phase is not VALIDATION, report the current phase and stop.

2. Read the active checks from the status response. The active checks are typically: \`test_quality\` and \`rollback_safety\`. Additional checks may include \`business_rules\` and \`technical_debt\`.

3. For EACH active check, apply the falsification-first criteria below. Try to find reasons to FAIL the check before passing it.

   ### test_quality (QG-4)

   Attempt to falsify the plan's testing strategy. Check each criterion:

   **Hard fail (any one of these → \`passed: false\`):**
   - The plan does not name specific test files or test functions to create/modify.
   - The plan only mentions "add tests" or "ensure test coverage" without describing WHAT is tested.
   - No unhappy-path or negative-path test is described for any changed function.
   - Test assertions are vague ("verify it works") instead of specific (checking return values, error types, state changes).
   - The plan does not distinguish between unit, integration, and contract tests when multiple test types are relevant.

   **Risk-tier escalation:**
   - TIER-MEDIUM or higher: At least one explicit negative-path assertion per changed behavior MUST be described. Fail if missing.
   - TIER-HIGH: At least one resilience/recovery test (retry, idempotency, rollback, concurrent access) MUST be described. Fail if missing.

   **Pass criteria:** The plan names specific test targets, describes what each test proves, includes at least one negative-path test, and assertions are specific enough to catch real defects.

   ### rollback_safety (QG-5)

   Attempt to falsify the plan's rollback safety. Check each criterion:

   **Hard fail (any one of these → \`passed: false\`):**
   - Database schema changes exist but no reversible migration strategy is described.
   - Public API changes exist but backward-compatibility or versioning strategy is missing.
   - Irreversible operations (data deletion, schema drops, message schema changes) exist without safeguards.
   - Persistence-layer changes exist but no rollback plan is mentioned.
   - External system integrations are modified without timeout/retry/circuit-breaker consideration.

   **Risk-tier escalation:**
   - TIER-HIGH: A concrete rollback plan MUST be described (feature flag, migration rollback, config revert). Fail if missing.

   **Pass criteria:** All changes are safely reversible, OR the plan explicitly addresses rollback for each irreversible operation, including monitoring/verification steps.

   ### business_rules (if active)

   Attempt to falsify business requirement coverage:

   **Hard fail:**
   - Any requirement stated in the ticket is not addressed in the plan.
   - A requirement is partially addressed or reinterpreted without explicit justification.
   - Edge cases mentioned in the ticket have no corresponding handling in the plan.
   - Business logic is placed in the wrong layer (e.g., in adapters, UI, or infrastructure instead of domain).

   **Pass criteria:** Every ticket requirement maps to at least one plan step, edge cases are addressed, and business logic is in the domain layer.

   ### technical_debt (if active)

   Attempt to falsify architectural quality:

   **Hard fail:**
   - The plan introduces new abstractions without justification (YAGNI violation).
   - The plan creates tight coupling between modules that should be independent.
   - The plan duplicates existing patterns instead of extending them.
   - The plan violates existing naming conventions or file organization without justification.

   **Pass criteria:** Changes extend existing patterns, abstractions are justified, coupling is minimal, and naming/organization is consistent.

4. Call \`flowguard_validate\` with the argument \`results\` set to an array containing one entry per active check. Each entry must have:
   - \`checkId\`: The check identifier string (e.g., \`"test_quality"\`).
   - \`passed\`: \`true\` or \`false\`.
   - \`detail\`: A string with 2-4 sentences explaining why the check passed or failed. Reference specific parts of the plan.

5. Read the response:
   - If all passed: The workflow advances to IMPLEMENTATION. Report this.
   - If any failed: The workflow returns to PLAN for revision. Report which checks failed, why, and what the plan needs to address.

## Constraints

- DO NOT skip any active check. Results must be provided for ALL active checks.
- DO NOT always pass checks. Apply the criteria honestly — falsification-first.
- The \`detail\` field must reference specific plan content. Do not write generic statements like "looks good" or "testing is adequate".
- DO NOT modify any code or files. Validation is analysis only.
- DO NOT use the \`question\` tool or present selectable choices.
- DO NOT substitute shell commands or direct file manipulation for FlowGuard tools.
- DO NOT auto-chain into /implement, /plan, or any other FlowGuard command after validation completes.
- DO NOT infer or assume session state beyond what the FlowGuard tools return.
- Natural-language prompts like "go", "weiter", "validate", "check it", or "run checks" are NOT command invocations. Only an explicit \`/validate\` triggers this command. If the user sends free-text implying validation, respond conversationally without calling FlowGuard tools.
- If any FlowGuard tool returns a failed, blocked, malformed, or nonconforming response, apply the Tool Error Classification from FlowGuard mandates: report the specific reason, exactly one recovery action, and stop.
- Always end your response with exactly one \`Next action:\` line. If all checks passed: \`Next action: run /implement to start implementation.\` If any check failed: \`Next action: run /plan to revise the plan and address the failed checks.\`

## Done-when

- All active checks have results with specific detail referencing plan content.
- Results are recorded in FlowGuard via flowguard_validate.
- Phase has advanced to IMPLEMENTATION (all passed) or returned to PLAN (any failed).
- Response ends with exactly one \`Next action:\` line.
`;
