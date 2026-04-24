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

FlowGuard enforces the subagent requirement at two layers:

**Layer 1 — Structural validation (`review-validation.ts`):**

- When `subagentEnabled: true` and the agent tries to approve without `reviewFindings` → BLOCKED
- When `subagentEnabled: true` and `fallbackToSelf: false`, self-review findings are rejected → BLOCKED
- Plan-version binding, iteration binding, and mandatory-findings checks

**Layer 2 — Plugin-level enforcement (`review-enforcement.ts` via `plugin.ts`):**

The structural validation layer cannot detect whether the primary agent actually called the flowguard-reviewer subagent — it only validates the shape of the submitted findings. A compliant-looking `ReviewFindings` object could be fabricated without ever invoking the subagent, the prompt could be empty/garbage, or the agent could modify the subagent's findings before submitting them.

The plugin-level enforcement solves this with four enforcement levels, using OpenCode's `tool.execute.before/after` hooks:

**Level 1 — Binary Gate** (`tool.execute.before` for flowguard tools, Mode B):
A Task call to `flowguard-reviewer` MUST have occurred before any verdict submission. Blocks with `SUBAGENT_REVIEW_NOT_INVOKED`.

**Level 2 — Session ID Match** (`tool.execute.before` for flowguard tools, Mode B):
When both the actual subagent session ID and the submitted `reviewFindings.reviewedBy.sessionId` are available, they must match. Blocks with `SUBAGENT_SESSION_MISMATCH`. If the actual session ID couldn't be extracted from the subagent response, Level 2 is skipped (Level 4 covers fabrication detection instead).

**Level 3 — Prompt Integrity** (`tool.execute.before` for task calls):
Before the agent calls the `flowguard-reviewer` subagent, the prompt is validated:

- Must meet minimum length (200 chars — catches empty/trivial prompts)
- Must contain the expected `iteration` value near the keyword "iteration"
- Must contain the expected `planVersion` value near the keyword "version" (plan only)
  Blocks with `SUBAGENT_PROMPT_EMPTY` or `SUBAGENT_PROMPT_MISSING_CONTEXT`.

**Level 4 — Findings Integrity** (`tool.execute.before` for flowguard tools, Mode B):
The submitted `reviewFindings` are compared against the actual subagent response captured during the Task call:

- `overallVerdict` must match exactly (blocks `SUBAGENT_FINDINGS_VERDICT_MISMATCH`)
- `blockingIssues` count must match exactly (blocks `SUBAGENT_FINDINGS_ISSUES_MISMATCH`)

```
flowguard_plan (Mode A)     →  plugin registers pending review + captures content meta
    ↓
task (flowguard-reviewer)   →  L3: validates prompt integrity (before)
                            →  plugin matches + records exactly one pending obligation (after)
    ↓
flowguard_plan (Mode B)     →  L1: subagent called?
                            →  L2: session ID match?
                            →  L4: findings match captured?
                                ↳ ALL PASS → tool executes normally
                                ↳ ANY FAIL → throw → tool call physically blocked
```

Each Task call to `flowguard-reviewer` satisfies exactly **one** pending review obligation (P34 1:1 contract). P34a (plan review) and P34b (implement review) are independent governance obligations. When both are pending, the prompt's `iteration`/`planVersion` values are matched against each obligation's content metadata to determine assignment. If no match is found, no obligation is satisfied (fail-closed).

State is session-scoped and cleared after successful verdict submission. Tracking errors (in `tool.execute.after`) are fire-and-forget and never block governance flow. Enforcement errors (in `tool.execute.before`) are strict and physically prevent the tool call.

**Defense-in-depth note:** The plugin and FlowGuard tools are architecturally separate. If the plugin fails to load, the tools remain available but plugin-level enforcement (Levels 1-4) is inactive. In that case, structural validation (Layer 1) still enforces schema compliance, review-mode gating, and mandatory findings. Plugin load failure would also prevent audit event emission, making it detectable through missing audit trails.

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

**Structural validation (`review-validation.ts`):**

| Rule                 | Condition                                                 | BLOCKED Code                           |
| -------------------- | --------------------------------------------------------- | -------------------------------------- |
| Subagent mode gating | `reviewMode=subagent` + `!subagentEnabled`                | `REVIEW_MODE_SUBAGENT_DISABLED`        |
| Self mode gating     | `reviewMode=self` + `subagentEnabled` + `!fallbackToSelf` | `REVIEW_MODE_SELF_NOT_ALLOWED`         |
| Plan version binding | `findings.planVersion !== expected`                       | `REVIEW_PLAN_VERSION_MISMATCH`         |
| Iteration binding    | `findings.iteration !== expected`                         | `REVIEW_ITERATION_MISMATCH`            |
| Mandatory findings   | `approve` + `subagentEnabled` + no findings               | `REVIEW_FINDINGS_REQUIRED_FOR_APPROVE` |

Validation logic is implemented once in `src/integration/tools/review-validation.ts` and shared by both `/plan` and `/implement` tools.

**Plugin-level enforcement (`review-enforcement.ts`):**

| Level | Rule               | Condition                                                           | BLOCKED Code                         | Hook Point       |
| ----- | ------------------ | ------------------------------------------------------------------- | ------------------------------------ | ---------------- |
| L1    | Subagent invoked   | Pending review + no Task call to `flowguard-reviewer`               | `SUBAGENT_REVIEW_NOT_INVOKED`        | before FG Mode B |
| L2    | Session ID match   | `reviewedBy.sessionId` does not match actual subagent session ID    | `SUBAGENT_SESSION_MISMATCH`          | before FG Mode B |
| L3    | Prompt substantive | Task prompt < 200 chars                                             | `SUBAGENT_PROMPT_EMPTY`              | before task call |
| L3    | Prompt has context | Task prompt missing expected iteration or planVersion               | `SUBAGENT_PROMPT_MISSING_CONTEXT`    | before task call |
| L4    | Verdict integrity  | Submitted `overallVerdict` differs from actual subagent verdict     | `SUBAGENT_FINDINGS_VERDICT_MISMATCH` | before FG Mode B |
| L4    | Issues integrity   | Submitted `blockingIssues` count differs from actual subagent count | `SUBAGENT_FINDINGS_ISSUES_MISMATCH`  | before FG Mode B |

Enforcement logic is implemented in `src/integration/review-enforcement.ts` and integrated via `tool.execute.before/after` hooks in `src/integration/plugin.ts`.

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
| Plugin          | `.opencode/plugins/flowguard-audit.ts`                      | Re-exports FlowGuardAuditPlugin (includes enforcement hooks)  |

---

## Current Status

**Fully implemented.** The independent review system provides two enforcement layers:

1. **Structural validation** — FlowGuard tools validate ReviewFindings schema, review mode vs. policy, plan-version binding, and iteration binding. Invalid findings are BLOCKED.
2. **Plugin-level enforcement** — Four enforcement levels via OpenCode `tool.execute.before/after` hooks:
   - L1: Binary gate — subagent must be called before any verdict
   - L2: Session ID match — submitted session ID must match actual subagent session
   - L3: Prompt integrity — subagent prompt must contain expected iteration/planVersion and meet minimum length
   - L4: Findings integrity — submitted overallVerdict and blockingIssues count must match actual subagent response
3. **1:1 obligation matching** — Each subagent call satisfies exactly one pending review obligation. P34a (plan) and P34b (implement) are independent; if both are pending, each requires its own subagent invocation. Matching uses content metadata (iteration/planVersion) from the Task prompt. No match = fail-closed.

**Backward-compatible.** Default policy (`subagentEnabled: false`) preserves existing self-review behavior. Enforcement hooks only activate when `INDEPENDENT_REVIEW_REQUIRED` is detected in tool responses. No existing workflows are affected.

---

_FlowGuard Version: 1.2.0-rc.1_
_Last Updated: 2026-04-24_
