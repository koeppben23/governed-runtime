# Phases

FlowGuard uses 8 explicit workflow phases to enforce structured development.

## Phase Flow

```
TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE
```

## Phase Reference

| Phase | Description | Gate Type |
|-------|-------------|-----------|
| TICKET | Record task description | Automatic |
| PLAN | Generate plan + self-review | Automatic (self-review) |
| PLAN_REVIEW | Human approves plan | **User Gate** |
| VALIDATION | Run validation checks | Automatic |
| IMPLEMENTATION | Execute plan | Automatic |
| IMPL_REVIEW | Human reviews implementation | **User Gate** |
| EVIDENCE_REVIEW | Human reviews evidence | **User Gate** |
| COMPLETE | Session archived | Terminal |

## Gate Types

### Automatic Gates
- No human intervention required
- Machine evaluates state and advances
- Examples: TICKET → PLAN, VALIDATION → IMPLEMENTATION

### User Gates
- Require explicit human approval
- Four-eyes principle in regulated mode
- Examples: PLAN_REVIEW, EVIDENCE_REVIEW

## Phase Details

### TICKET

**Entry:** `/hydrate`
**Exit:** `/ticket`

Records the task description. Validates that the task is clear and actionable.

### PLAN

**Entry:** `/ticket`
**Exit:** `/review-decision` (approve)

Generates an implementation plan with built-in self-review. The AI critically reviews its own plan and refines it until convergence.

### PLAN_REVIEW

**Entry:** `/review-decision` (approve from PLAN)
**Exit:** `/review-decision`

Human reviews and approves the plan before implementation begins. In regulated mode, a second person must review.

### VALIDATION

**Entry:** `/review-decision` (approve from PLAN_REVIEW)
**Exit:** `/implement`

Runs automated validation checks defined by the active profile. All checks must pass to proceed.

### IMPLEMENTATION

**Entry:** `/review-decision` (approve from VALIDATION)
**Exit:** `/review-decision`

AI implements the plan using OpenCode tools. Changed files are automatically tracked.

### IMPL_REVIEW

**Entry:** `/review-decision` (approve from IMPLEMENTATION)
**Exit:** `/review-decision`

Human reviews the implementation against the plan.

### EVIDENCE_REVIEW

**Entry:** `/review-decision` (approve from IMPL_REVIEW)
**Exit:** `/review-decision`

Final human review of all evidence before completion.

### COMPLETE

**Entry:** Automatic after EVIDENCE_REVIEW approval
**Exit:** Terminal

Session is complete. Can be archived with `/archive`.
