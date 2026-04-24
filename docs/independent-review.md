# Independent Review Architecture

FlowGuard's independent review system enables structured, policy-governed review of plans and implementations by a separate agent. FlowGuard itself does not invoke subagents — it accepts, validates, and persists review findings produced by OpenCode's primary agent orchestration.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 OpenCode Primary Agent                  │
│                                                         │
│  1. Draft plan / implement code                         │
│  2. Call hidden review subagent via Task tool            │
│  3. Receive structured ReviewFindings from subagent      │
│  4. Submit plan/impl + reviewFindings to FlowGuard tool  │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   FlowGuard Tool    │
          │  (plan / implement) │
          │                     │
          │  • Validate         │
          │  • Persist          │
          │  • Respond          │
          └─────────────────────┘

Separation of concerns:
  Author artifacts:   plan.history, implementation
  Reviewer artifacts: plan.reviewFindings, implReviewFindings
```

**Key invariant:** FlowGuard is a governance boundary, not an orchestrator. The OpenCode primary agent orchestrates the review subagent. FlowGuard only validates and persists the results.

---

## OpenCode Configuration

To use independent review, configure a hidden review subagent in OpenCode and enable the policy in FlowGuard.

### 1. Define Hidden Review Subagent

Create `.opencode/agents/flowguard-reviewer.md`:

```markdown
---
description: Independent reviewer for FlowGuard plan and implementation phases
mode: subagent
hidden: true
tools:
  write: false
  edit: false
  bash: false
---

You are an independent code and plan reviewer for FlowGuard governance.

Your task is to review the provided plan or implementation and return structured findings.

## Output Format

Return a JSON object matching the ReviewFindings schema:

- iteration: current review iteration (0 for initial)
- planVersion: version number of the plan being reviewed
- reviewMode: "subagent"
- overallVerdict: "approve" or "changes_requested"
- blockingIssues: array of { severity, category, message, location? }
- majorRisks: array of { severity, category, message, location? }
- missingVerification: array of strings
- scopeCreep: array of strings
- unknowns: array of strings
- reviewedBy: { sessionId: your session ID }
- reviewedAt: ISO 8601 timestamp

## Review Criteria

- Completeness: Does the plan/implementation cover all requirements?
- Correctness: Are there logical errors or incorrect assumptions?
- Feasibility: Can this be implemented as described?
- Risk: Are there security, performance, or reliability risks?
- Quality: Does the code follow project conventions?
```

### 2. Configure Task Permissions

In `opencode.json`, allow the primary agent to invoke the review subagent:

```json
{
  "agent": {
    "build": {
      "permission": {
        "task": {
          "flowguard-reviewer": "allow"
        }
      }
    }
  }
}
```

### 3. Enable FlowGuard Policy

In FlowGuard policy configuration, enable subagent review:

```json
{
  "selfReview": {
    "subagentEnabled": true,
    "fallbackToSelf": false
  }
}
```

| Setting                                        | Effect                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `subagentEnabled: false` (default)             | Only `reviewMode: "self"` accepted. Existing self-review behavior unchanged. |
| `subagentEnabled: true, fallbackToSelf: false` | Only `reviewMode: "subagent"` accepted. Self-review blocked.                 |
| `subagentEnabled: true, fallbackToSelf: true`  | Both modes accepted. Self-review used as degraded fallback.                  |

---

## ReviewFindings Schema

```typescript
{
  iteration:            number    // 0-based, must match expected iteration
  planVersion:          number    // positive integer, must match current plan version
  reviewMode:           'subagent' | 'self'
  overallVerdict:       'approve' | 'changes_requested'
  blockingIssues:       Finding[] // severity: critical|major|minor
  majorRisks:           Finding[] // category: completeness|correctness|feasibility|risk|quality
  missingVerification:  string[]
  scopeCreep:           string[]
  unknowns:             string[]
  reviewedBy:           ReviewActorInfo  // { sessionId, actorId?, actorSource?, actorAssurance? }
  reviewedAt:           string    // ISO 8601 datetime
}
```

---

## Validation Rules

All validation is fail-closed. Invalid findings return BLOCKED.

| Rule                 | Condition                                                 | BLOCKED Code                           |
| -------------------- | --------------------------------------------------------- | -------------------------------------- |
| Subagent mode gating | `reviewMode=subagent` + `!subagentEnabled`                | `REVIEW_MODE_SUBAGENT_DISABLED`        |
| Self mode gating     | `reviewMode=self` + `subagentEnabled` + `!fallbackToSelf` | `REVIEW_MODE_SELF_NOT_ALLOWED`         |
| Plan version binding | `findings.planVersion !== expected`                       | `REVIEW_PLAN_VERSION_MISMATCH`         |
| Iteration binding    | `findings.iteration !== expected`                         | `REVIEW_ITERATION_MISMATCH`            |
| Mandatory findings   | `approve` + `subagentEnabled` + no findings               | `REVIEW_FINDINGS_REQUIRED_FOR_APPROVE` |

Validation logic is implemented once in `src/integration/tools/review-validation.ts` and shared by both `/plan` and `/implement` tools.

---

## Persistence Model

Author and reviewer artifacts are stored in parallel, never mixed:

| Tool         | Author artifacts                           | Reviewer artifacts          |
| ------------ | ------------------------------------------ | --------------------------- |
| `/plan`      | `state.plan.current`, `state.plan.history` | `state.plan.reviewFindings` |
| `/implement` | `state.implementation`                     | `state.implReviewFindings`  |

Both reviewer artifact arrays are **append-only**. Each review submission adds to the array; no entries are ever removed or overwritten.

---

## Status Projections

`flowguard_status` exposes the latest review summary for both tools:

- `latestReview` — latest plan review findings (iteration, planVersion, overallVerdict, counts, reviewMode, reviewedAt)
- `latestImplementationReview` — latest implementation review findings (same shape without planVersion)

---

## Current Status

**Foundation layer complete.** FlowGuard validates and persists ReviewFindings. The OpenCode-side configuration (subagent definition, system prompt, structured output integration) is documented above as reference architecture. Actual subagent implementation is deferred to a follow-up.

**Backward-compatible.** Default policy (`subagentEnabled: false`) preserves existing self-review behavior. No existing workflows are affected.

---

_FlowGuard Version: 1.2.0-rc.1_
_Last Updated: 2026-04-24_
