import { GOVERNANCE_RULES } from './shared-rules.js';

export const VALIDATE_COMMAND = `
---
description: Run validation checks on the approved plan.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Execute validation checks for the FlowGuard session using falsification-first criteria.

## Steps

1. Call \`flowguard_status\` to verify a session exists in VALIDATION phase with an approved plan.
   - If not in VALIDATION: report the current phase and stop.

2. Read the active checks from the status response (typically: \`test_quality\`, \`rollback_safety\`; optionally \`business_rules\`, \`technical_debt\`).

3. For EACH active check, apply falsification-first — try to find reasons to FAIL before passing:

   ### test_quality (QG-4)
   **Fail if any:**
   - Plan does not name specific test files or test functions.
   - Only "add tests" without describing WHAT is tested.
   - No unhappy-path or negative-path test described.
   - Assertions are vague ("verify it works") instead of specific.
   - Multiple test types relevant but not distinguished.
   **Risk escalation:** TIER-MEDIUM+ requires explicit negative-path assertion. TIER-HIGH requires resilience/recovery test.
   **Pass:** Specific targets, what each test proves, negative-path included, assertions catch real defects.

   ### rollback_safety (QG-5)
   **Fail if any:**
   - Schema changes without reversible migration strategy.
   - Public API changes without backward-compatibility.
   - Irreversible operations without safeguards.
   - Persistence-layer changes without rollback plan.
   - External integrations modified without timeout/retry/circuit-breaker.
   **Risk escalation:** TIER-HIGH requires concrete rollback plan.
   **Pass:** All changes safely reversible, OR rollback explicitly addressed.

   ### business_rules (if active)
   **Fail if:** Any ticket requirement unaddressed, edge cases missing, business logic in wrong layer.

   ### technical_debt (if active)
   **Fail if:** Unjustified abstractions (YAGNI), tight coupling, pattern duplication, naming violations.

4. Call \`flowguard_validate({ results })\` with one entry per active check:
   - \`checkId\`: The check identifier.
   - \`passed\`: true or false.
   - \`detail\`: 2-4 sentences referencing specific plan content. Never generic ("looks good").

5. Report results: which passed, which failed, and what happens next.

## Rules

- Provide results for ALL active checks — skipping is not allowed.
- Apply criteria honestly (falsification-first) — passing everything uncritically defeats the purpose.
- The \`detail\` field references specific plan content.
- This command is analysis only — use flowguard_validate, not write/edit/bash.
${GOVERNANCE_RULES}
## Done-when

- All active checks have results with specific detail.
- Results recorded via flowguard_validate.
- Phase advanced to IMPLEMENTATION (all passed) or returned to PLAN (any failed).
- Response ends with \`Next action:\` line.
`;
