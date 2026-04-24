# Independent Review Architecture

FlowGuard's independent review system enables structured, policy-governed review of plans and implementations by a separate agent. FlowGuard itself does not invoke subagents — it accepts, validates, and persists review findings produced by OpenCode's primary agent orchestration.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 OpenCode Primary Agent                  │
│                                                         │
│  1. Draft plan / implement code                         │
│  2. Submit to FlowGuard (flowguard_plan/implement)      │
│  3. Read tool response: next + reviewMode               │
│  4. If INDEPENDENT_REVIEW_REQUIRED:                     │
│     a. Call flowguard-reviewer subagent via Task tool    │
│     b. Receive structured ReviewFindings from subagent   │
│  5. Submit verdict + reviewFindings to FlowGuard tool    │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   FlowGuard Tool    │
          │  (plan / implement) │
          │                     │
          │  • Validate         │
          │  • Persist          │
          │  • Respond with     │
          │    policy-conditional│
          │    next-action      │
          └─────────────────────┘

Separation of concerns:
  Author artifacts:   plan.history, implementation
  Reviewer artifacts: plan.reviewFindings, implReviewFindings
```

**Key invariant:** FlowGuard is a governance boundary, not an orchestrator. The OpenCode primary agent orchestrates the review subagent based on FlowGuard's policy-conditional `next` field. FlowGuard validates and persists the results.

---

## How It Works

### Policy-Conditional Next-Action

When the primary agent submits a plan or implementation to FlowGuard, the tool response includes a `reviewMode` field and a `next` field:

- **`subagentEnabled: false` (default):** `next` says "Self-review needed. Review the plan critically..." — the agent reviews its own work using the checklist in the slash command.
- **`subagentEnabled: true`:** `next` says "INDEPENDENT_REVIEW_REQUIRED: Call the flowguard-reviewer subagent via Task tool..." — the agent MUST call the hidden review subagent.

The `INDEPENDENT_REVIEW_REQUIRED` prefix is a deterministic signal. The slash commands (`/plan`, `/implement`, `/continue`) check for this prefix and follow the appropriate review path.

### Subagent Invocation

When independent review is required, the primary agent:

1. Calls the Task tool with `subagent_type: "flowguard-reviewer"`
2. Passes a prompt containing the plan/implementation text, ticket text, iteration number, and plan version
3. The subagent reviews the material (read-only — no write, edit, or bash access)
4. The subagent returns structured JSON matching the ReviewFindings schema
5. The primary agent submits the findings to FlowGuard alongside its verdict

### Fail-Closed Enforcement

FlowGuard enforces the subagent requirement:

- When `subagentEnabled: true` and the agent tries to approve without `reviewFindings` → BLOCKED
- When `subagentEnabled: true` and `fallbackToSelf: false`, self-review findings are rejected → BLOCKED
- The validation layer is the single authority (`review-validation.ts`)

---

## OpenCode Configuration

The installer (`flowguard install`) automatically deploys all required artifacts.

### 1. Review Subagent Definition (auto-deployed)

The installer writes `.opencode/agents/flowguard-reviewer.md`:

- `mode: subagent`, `hidden: true`, `temperature: 0.1`
- Read-only: `edit: deny`, `bash: deny`, `webfetch: deny`
- Adversarial, falsification-first review prompt
- Returns structured ReviewFindings JSON

### 2. Task Permissions (auto-merged)

The installer merges into `opencode.json`:

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

### 3. FlowGuard Policy

Enable subagent review in FlowGuard policy configuration:

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

## Installed Artifacts

The `flowguard install` command deploys:

| Artifact        | Path                                                        | Purpose                                                       |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Review subagent | `.opencode/agents/flowguard-reviewer.md`                    | Hidden subagent definition with adversarial review prompt     |
| Task permission | `opencode.json` (merged)                                    | Allows build agent to invoke flowguard-reviewer               |
| Slash commands  | `.opencode/commands/plan.md`, `implement.md`, `continue.md` | Updated with Path A (subagent) / Path B (self) review routing |

---

## Current Status

**Fully implemented.** FlowGuard validates and persists ReviewFindings. The installer deploys the review subagent definition, task permissions, and updated slash commands. When `selfReview.subagentEnabled: true`, the primary agent is instructed to call the `flowguard-reviewer` subagent via the Task tool for independent review of plans and implementations.

**Backward-compatible.** Default policy (`subagentEnabled: false`) preserves existing self-review behavior. No existing workflows are affected.

---

_FlowGuard Version: 1.2.0-rc.1_
_Last Updated: 2026-04-24_
