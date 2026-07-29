FlowGuard blocked this action.

⚠ **Blocked:** `HOST_TOOL_PHASE_DENIED` — Plan review is required.

**Root cause:** /plan is mutating and is not allowed while FlowGuard is in PLAN_REVIEW.

## Observed

- tool=/plan
- phase=PLAN_REVIEW

## Required

- read-only investigation tools in this phase
- implementation phase before mutating host tools

## Recovery

Use the canonical recovery steps below.
- Use read-only tools such as read, glob, or grep while investigating.
- Advance the FlowGuard workflow to the implementation phase before mutating files.
