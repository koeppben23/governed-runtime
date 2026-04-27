# Independent Review Architecture

FlowGuard's independent review system enables structured, policy-governed review of plans and implementations by a separate agent. The FlowGuard plugin deterministically invokes the reviewer subagent via the OpenCode SDK — no LLM decision is involved in the invocation itself. In strict mode (`selfReview.strictEnforcement=true`), review approval is fail-closed unless mandate-bound, single-use subagent evidence is present.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 OpenCode Primary Agent                  │
│                                                         │
│  1. Draft plan / implement code                         │
│  2. Submit to FlowGuard (flowguard_plan/implement)      │
│  3. Read tool response:                                 │
│     → INDEPENDENT_REVIEW_COMPLETED: findings injected   │
│       (plugin invoked reviewer automatically)           │
│     → INDEPENDENT_REVIEW_REQUIRED: non-strict fallback  │
│       path (plugin invocation failed, call Task tool)   │
│     → BLOCKED (strict mode orchestration/evidence fail) │
│  4. Submit verdict + reviewFindings to FlowGuard tool   │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   FlowGuard Tool    │     ┌───────────────────────┐
          │  (plan / implement) │     │    FlowGuard Plugin   │
          │                     │     │  (tool.execute.after)  │
          │  • Validate         │────►│                        │
          │  • Persist          │     │  Detects REVIEW_REQ'd  │
          │  • Respond with     │     │  → session.create()    │
          │    REVIEW_REQUIRED  │     │  → session.prompt()    │
          └─────────────────────┘     │  → Mutates output to   │
                                      │    REVIEW_COMPLETED    │
                                      │  → Updates enforcement │
                                      └───────────────────────┘

Separation of concerns:
  Author artifacts:   plan.history, implementation
  Reviewer artifacts: plan.reviewFindings, implReviewFindings
```

**Key invariant:** The plugin deterministically invokes the reviewer subagent via the SDK client. The LLM does not decide whether to call the reviewer — the plugin does it programmatically in `tool.execute.after`. Only structured, parseable ReviewFindings trigger `INDEPENDENT_REVIEW_COMPLETED`. In strict mode, unparseable responses and orchestration failures are BLOCKED (no probabilistic fallback). In non-strict mode, failures preserve `INDEPENDENT_REVIEW_REQUIRED` and the LLM can still invoke the reviewer via the Task tool.

---

## How It Works

### Policy-Conditional Next-Action

When the primary agent submits a plan or implementation to FlowGuard, the tool response includes a `reviewMode` field and a `next` field:

- **`subagentEnabled: false` (default):** `next` says "Self-review needed. Review the plan critically..." — the agent reviews its own work using the checklist in the slash command.
- **`subagentEnabled: true`:** `next` says "INDEPENDENT_REVIEW_REQUIRED: Call the flowguard-reviewer subagent via Task tool..." — triggers deterministic plugin invocation.

### Deterministic Invocation (Primary Path)

When the plugin's `tool.execute.after` hook detects `INDEPENDENT_REVIEW_REQUIRED` in a FlowGuard tool response:

1. **Reads session state** to get ticket text, plan text, and implementation context
2. **Builds a structured prompt** with the plan/implementation text, ticket context, iteration, and planVersion
3. **Creates a child session** via `client.session.create({ parentID })` for traceability
4. **Sends the prompt** to the `flowguard-reviewer` agent via `client.session.prompt({ agent: "flowguard-reviewer" })`
5. **Parses ReviewFindings** from the reviewer's response
6. **Mutates `output.output`** from `INDEPENDENT_REVIEW_REQUIRED` to `INDEPENDENT_REVIEW_COMPLETED` with `_pluginReviewFindings` injected (only when structured ReviewFindings are available)
7. **Updates enforcement state** to satisfy L1/L2/L4 checks for the subsequent verdict submission

The LLM then sees the `INDEPENDENT_REVIEW_COMPLETED` response and submits the verdict with the pre-injected findings.

**Contract:** `INDEPENDENT_REVIEW_COMPLETED` is only signaled when the reviewer's response contains valid, structured `ReviewFindings` (with `overallVerdict` and `blockingIssues`). Unparseable reviewer responses never produce `COMPLETED`.

### Fallback Path (Non-Strict Only)

If strict mode is disabled and deterministic invocation fails (session creation error, prompt timeout, output mutation failure), or the reviewer's response is not parseable as structured ReviewFindings, the plugin:

- Logs the error (non-blocking)
- Preserves the original `INDEPENDENT_REVIEW_REQUIRED` output unchanged
- The LLM follows the slash command's Path A2: calls the `flowguard-reviewer` subagent via the Task tool

In strict mode, this path is disabled: orchestration and parsing failures return BLOCKED (`STRICT_REVIEW_ORCHESTRATION_FAILED`).

### Fail-Closed Enforcement

FlowGuard enforces the subagent requirement at three layers:

**Layer 1 — Structural validation (`review-validation.ts`):**

- When `subagentEnabled: true` and the agent tries to approve without `reviewFindings` → BLOCKED
- When `subagentEnabled: true` and `fallbackToSelf: false`, self-review findings are rejected → BLOCKED
- Plan-version binding, iteration binding, and mandatory-findings checks

**Layer 2 — Deterministic invocation (`review-orchestrator.ts` via `plugin.ts`):**

The plugin programmatically invokes the reviewer subagent via the OpenCode SDK client when it detects `INDEPENDENT_REVIEW_REQUIRED` in a tool response. This ensures invocation happens by code, not by LLM decision.

**Layer 3 — Plugin-level enforcement (`review-enforcement.ts` via `plugin.ts`):**

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
    ↓                          plugin invokes reviewer via SDK (deterministic)
    ↓                          plugin mutates output to INDEPENDENT_REVIEW_COMPLETED
    ↓                          plugin records review in enforcement state
    ↓
[Optional fallback if plugin invocation failed:]
task (flowguard-reviewer)   →  L3: validates prompt integrity (before)
                            →  plugin matches + records exactly one pending obligation (after)
    ↓
flowguard_plan (Mode B)     →  L1: subagent called?
                            →  L2: session ID match?
                            →  L4: findings match captured?
                                ↳ ALL PASS → tool executes normally
                                ↳ ANY FAIL → throw → tool call physically blocked
```

Each Task call to `flowguard-reviewer` satisfies exactly **one** pending review obligation (1:1 contract). Plan review and implement review are independent governance obligations. When both are pending, the prompt's `iteration`/`planVersion` values are matched against each obligation's content metadata to determine assignment. If no match is found, no obligation is satisfied (fail-closed).

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
    "fallbackToSelf": false,
    "strictEnforcement": true
  }
}
```

| Setting                                        | Effect                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `subagentEnabled: false` (default)             | Only `reviewMode: "self"` accepted. Existing self-review behavior unchanged.                   |
| `subagentEnabled: true, fallbackToSelf: false` | Only `reviewMode: "subagent"` accepted. Self-review blocked.                                   |
| `subagentEnabled: true, fallbackToSelf: true`  | Both modes accepted. Self-review used as degraded fallback.                                    |
| `strictEnforcement: true`                      | Enforces mandate-bound, one-time subagent evidence; missing or mismatched evidence is BLOCKED. |

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
  attestation?: {
    mandateDigest:      string    // must match runtime review mandate digest
    criteriaVersion:    string    // must match runtime review criteria version
    toolObligationId:   string    // must match strict review obligation id
    iteration:          number    // must match expected iteration
    planVersion:        number    // must match expected plan version
    reviewedBy:         string    // expected: flowguard-reviewer
  }
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
| Strict enforcement   | plugin assurance unavailable                              | `PLUGIN_ENFORCEMENT_UNAVAILABLE`       |
| Strict enforcement   | orchestration obligation blocked                          | `STRICT_REVIEW_ORCHESTRATION_FAILED`   |
| Strict enforcement   | subagent evidence missing                                 | `SUBAGENT_EVIDENCE_MISSING`            |
| Strict enforcement   | attestation missing                                       | `SUBAGENT_MANDATE_MISSING`             |
| Strict enforcement   | attestation mismatch                                      | `SUBAGENT_MANDATE_MISMATCH`            |
| Strict enforcement   | invocation evidence already consumed                      | `SUBAGENT_EVIDENCE_REUSED`             |

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

| Artifact        | Path                                                        | Purpose                                                          |
| --------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| Review subagent | `.opencode/agents/flowguard-reviewer.md`                    | Hidden subagent definition with adversarial review prompt        |
| Task permission | `opencode.json` (merged)                                    | Explicitly allows flowguard-reviewer, denies all others          |
| Slash commands  | `.opencode/commands/plan.md`, `implement.md`, `continue.md` | Updated with Path A1 (plugin) / A2 (fallback) / B (self) routing |
| Plugin          | `.opencode/plugins/flowguard-audit.ts`                      | Re-exports FlowGuardAuditPlugin (orchestration + enforcement)    |

### Security Model Clarification

**Task tool permissions** use OpenCode's last-matching-rule semantics. The explicit allow for `flowguard-reviewer` combined with deny for `*` ensures no other subagent can be invoked via the Task tool by the build agent. However, `permission.task` controls only Task tool invocations — direct user invocations via `@subagent` are **not blocked** by this permission model. This is a known limitation documented in OpenCode's architecture: `permission.task` is not a security boundary for user-@ direct calls. FlowGuard's strict mode achieves security through enforcement hooks (L1-L4) and mandate binding, not through permission denial.

---

## Required CI Status Checks

For strict Independent Review enforcement in CI, the following checks must be **required** in GitHub Branch Protection or Rulesets:

1. **`independent-review-e2e`** — Targeted strict-review verifier plus real OpenCode runtime install/server smoke. The runtime smoke builds a release tarball, installs FlowGuard into a fresh repo, starts `opencode serve`, and verifies commands/tools/agent/permission surfaces through the real server API.
2. All other standard checks (`test`, `lint`, `build`, `codeql-sast`, etc.)

### Configuration

1. Go to **Repository Settings → Branches → Branch protection rules**
2. Create or edit rule for your default branch (e.g., `main`)
3. Under **Status checks**, require `independent-review-e2e` to pass before merging
4. Optionally require **branches to be up to date** before merging

> **Note:** The `independent-review-e2e` check is defined in `.github/workflows/ci.yml`. Configuring it as required is done in GitHub settings, not in code. This CI smoke does not execute a provider-backed LLM `/plan` + `/implement` conversation; that remains an operator/runtime acceptance test because it requires configured model credentials.

---

## Current Status

**Strict code hardening implemented.** The independent review system provides strict, fail-closed assurance with three enforcement layers:

1. **Structural validation** — FlowGuard tools validate ReviewFindings schema, review mode vs. policy, plan-version binding, and iteration binding. Invalid findings are BLOCKED.
2. **Deterministic invocation** — Plugin programmatically invokes the reviewer subagent via the OpenCode SDK client (`session.create()` + `session.prompt()`). No LLM decision involved.
3. **Plugin-level enforcement** — Four enforcement levels via OpenCode `tool.execute.before/after` hooks:
   - L1: Binary gate — subagent must be called before any verdict
   - L2: Session ID match — submitted session ID must match actual subagent session
   - L3: Prompt integrity — subagent prompt must contain expected iteration/planVersion and meet minimum length
   - L4: Findings integrity — submitted overallVerdict and blockingIssues count must match actual subagent response
4. **1:1 obligation matching** — Each subagent call satisfies exactly one pending review obligation. Plan and implement are independent; if both are pending, each requires its own subagent invocation. Matching uses content metadata (iteration/planVersion) from the Task prompt. No match = fail-closed.
5. **Strict evidence contract ** — With `strictEnforcement=true`, verdicts are accepted only when obligation, invocation evidence, and reviewer attestation are all present, mandate-bound, and single-use. No fallback to probabilistic review.

**Backward-compatible.** Default policy (`subagentEnabled: false`) preserves existing self-review behavior. Deterministic invocation and enforcement hooks only activate when `INDEPENDENT_REVIEW_REQUIRED` is detected in tool responses. No existing workflows are affected.

---

FlowGuard Version: 1.2.0-rc.1
_Last Updated: 2026-04-24_
