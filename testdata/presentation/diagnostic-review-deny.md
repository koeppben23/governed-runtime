FlowGuard blocked this action.

⚠ **Blocked:** `STRICT_REVIEW_ORCHESTRATION_FAILED` — Review returned with blocking issues.

**Root cause:** Review was denied at plan-reviewer-iteration-3.

## Observed

- obligationId=oblig-plan-reviewer-3
- blockedCode=REVIEW_DENIED

## Required

- parseable reviewer output
- valid strict attestation
- bindable review invocation evidence

## Next

- Re-run the FlowGuard command to create a fresh review obligation and retry orchestration.
- Run flowguard doctor if orchestration failures repeat.