# Independent Review Architecture

FlowGuard's independent review system enables structured, policy-governed review of plans, architecture decisions (ADRs), and implementations by a separate agent. On OpenCode, the FlowGuard plugin deterministically invokes the reviewer subagent via the OpenCode SDK — no LLM decision is involved in the invocation itself. On Claude Code and Codex, native reviewer agents/subagents are transport and isolation artifacts only. Review completion requires validated, obligation-bound `ReviewFindings` through FlowGuard's existing `ReviewObligation` and `ReviewInvocationEvidence` pipeline; missing or mismatched evidence fails closed.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 OpenCode Primary Agent                  │
│                                                         │
│  1. Draft plan / ADR / implement code                   │
│  2. Submit to FlowGuard                                 │
│     (flowguard_plan / flowguard_architecture /          │
│      flowguard_implement)                               │
│  3. Read tool response:                                 │
│     → reviewDispatch.completed: host-observed           │
│       structured findings bound, verdict in             │
│       reviewDispatch.verdict (submit verdict only)      │
│     → reviewDispatch.required: host reviewer            │
│       dispatch incomplete — follow recovery steps       │
│     → BLOCKED (strict mode orchestration/evidence fail) │
│  4. Submit verdict via flowguard_review_implementation  │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   FlowGuard Tool    │     ┌───────────────────────┐
          │  (plan / arch /     │     │    FlowGuard Plugin   │
          │   implement)        │     │  (tool.execute.after) │
          │                     │     │                       │
          │  • Validate         │────►│  Detects review       │
          │  • Persist          │     │  dispatch required    │
          │  • Respond with     │     │  → session.create()   │
          │    required signal  │     │  → session.prompt()   │
          │                     │     │  → Mutates output to  │
          └─────────────────────┘     │    completed signal   │
                                      │  → Updates enforcement│
                                      └───────────────────────┘

Separation of concerns:
  Author artifacts:   plan.history, architecture.adrText, implementation
  Reviewer artifacts: plan.reviewFindings,
                      architecture.reviewFindings,
                      implReviewFindings
```

**Key invariant:** ReviewObligation, ReviewInvocationEvidence, and ReviewFindings are the only review-governance authority. On OpenCode, the reviewer runs in a host-created child session that the plugin prompts with the canonical review prompt and a required `json_schema` output contract; only the host-observed structured result can bind to a review obligation. Claude Code and Codex may transport reviewer instructions through native agents/subagents. None of those transport mechanisms completes review by itself. Only structured, parseable, obligation-bound ReviewFindings can satisfy review. In strict mode, unparseable responses and orchestration failures are BLOCKED. `flowguard_decision` is a human gate decision only and never replaces independent review evidence.

### Review Coverage Profile (`core` / `full`)

Every review — plan, implementation, architecture, and standalone `/review` — runs under a mandatory **review coverage profile**:

- **`core`** — the non-optional baseline. It is not operator-selectable and has no `off` mode. `core` reuses the canonical reviewer criteria in `src/templates/mandates-reviewer-criteria.ts`; it does **not** define a second set of criteria or a second review authority. The reviewer prompt carries a digit-free trailing marker declaring the profile; it never displaces the enforcement-bound `iteration`/`planVersion` context tokens.
- **`full`** — a reserved, forward-compatible value. In the current release it is never auto-selected. Wave 2 of #730 binds parallel specialist coverage and automatic HIGH-RISK escalation to `full`; that work is pending host-capability verification (#732).

The profile is **frozen into the review obligation at creation, before any reviewer is invoked** (`ReviewObligation.reviewProfile`, `ReviewObligation.profileSource`). It is sourced from the frozen policy snapshot (`policySnapshot.reviewProfile`), which every preset sets to `core`. Resolution is fail-closed: a missing or invalid frozen value, and any legacy snapshot without the field, resolves to `core`. The chosen profile and its source are recorded in the `review:obligation_created` and `review:subagent_invoked` audit events.

The profile is advisory context and provenance only. It does not transition state, satisfy an obligation, or replace ReviewFindings — the canonical reviewer remains the sole producer of binding, obligation-bound findings.

### Controlled Challenge Fixture Evaluation (#747)

`src/integration/review/validation/challenge-policy-evaluation.test.ts` runs controlled,
deterministic implementation-review fixtures twice: once with a legacy-shaped
obligation that has no frozen challenge requirements, and once with requirements
frozen from `challenge-policy.v1`. It resolves host-task-captured reviewer
findings through the production host-task validation path rather than calling the
challenge validator directly. Fixture ground truth is independently assigned and
is intentionally allowed to disagree with structural validation.

| Metric                      |       Without frozen requirements |          With frozen requirements |
| --------------------------- | --------------------------------: | --------------------------------: |
| Recall                      |                                0% |                               50% |
| Precision                   |         N/A (no fixtures blocked) |                               50% |
| Blocking rate               |                                0% |                         40% (2/5) |
| Re-review rate              |                         20% (1/5) |                         20% (1/5) |
| Fixture reviewer latency    | measured with `performance.now()` | measured with `performance.now()` |
| Pipeline validation latency | measured with `performance.now()` | measured with `performance.now()` |

The fixture set contains a missing-challenge case, a structurally valid but
independently labeled semantic gap (an intentional false negative), a contested
no-challenge control (an intentional false positive), and a valid control. It
also executes `changes_requested`, records advisory challenge-resolution evidence
through `resolve_implementation_challenge`, and accepts a distinct second
host-captured reviewer finding only after that reviewer independently marks the
resolution `resolved`. Re-review rate is therefore the observed second-review
occurrence, not a count of blocks.

These are deterministic fixture results only. `fixture reviewer latency` measures
the deterministic fixture-reviewer artifact parsing and findings production; it is
not reviewer-model or production latency. `pipeline validation latency` is the
separate wall-clock execution time for host capture, validation, persistence, and
re-review handling, measured with `performance.now()`.
The labels and results do not establish reviewer/model quality or real-world
false-positive and false-negative rates.

### Multi-Platform Reviewer Transport

FlowGuard projects one of three reviewer transport modes in tool output:

| Mode                           | Meaning                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `host_structured`              | OpenCode high-assurance path: parent-dispatched native Task reviewer child session with required structured output. |
| `external_instruction_pending` | Claude/Codex instruction transport. The runtime remains pending until ReviewFindings validate and bind.             |
| `unsupported_blocked`          | No safe reviewer transport is available; the session fails closed instead of accepting unverifiable evidence.       |

External transport files under `.flowguard/sessions/<session-id>/review-evidence/*.json` are not approval evidence by existence. `flowguard_continue` reads them only as transport, then parses, schema-validates, binds to the active obligation/attestation, records invocation evidence, and leaves review completion to the existing verdict submission path. Invalid or mismatched files remain pending/blocked.

The four reviewable flows — `/plan`, `/architecture`, `/implement`, and standalone `/review` — share the same ReviewFindings schema and fail-closed attestation model. `/plan`, `/architecture`, and `/implement` share the plugin-orchestration pipeline; standalone `/review` is fulfilled through the same host-visible native reviewer Task on OpenCode. All paths are validated through the same `validateStrictAttestation` gate.

---

## How It Works

### Mandatory Review Dispatch

When the primary agent submits a plan or implementation to FlowGuard, the tool response includes a `reviewMode` field and a structured `reviewDispatch` field:

- **Plugin-completed path:** `reviewDispatch.completed` is `true`; `reviewDispatch.verdict` carries the bound reviewer verdict. Submit only that verdict.
- **Host dispatch pending path:** `reviewDispatch.required` is `true` (and `completed` is not `true`); the host has not yet recorded a completed structured reviewer child session. Follow the `reviewInvocation` instructions and the recovery steps in the tool response (typically re-run the originating FlowGuard command). Do not submit a verdict, and do not reconstruct or submit reviewer findings.
- **Blocked path:** strict orchestration or evidence failures return BLOCKED. The agent must stop and report the recovery action.

### Deterministic Invocation (Primary Path)

The reviewer is a host-visible native Task child, never a hidden SDK session:

1. The parent agent calls the host `task` tool with `subagent_type: "flowguard-reviewer"`, following the `reviewDispatch` / `reviewInvocation` instruction (`action: "call_task"`) in the FlowGuard tool response.
2. The plugin `tool.execute.before` hook authorizes the exact current pending obligation/attempt, persists a durable dispatch under the host `callID`, and overwrites the Task arguments with the canonical frozen reviewer prompt (the parent-supplied prompt is transport filler only).
3. The host runs the visible, navigable `flowguard-reviewer` child Task session.
4. The plugin `tool.execute.after` hook resolves the durable dispatch lineage by `callID`, requires the authoritative child session ID from Task metadata, replays the reviewer observations, and sends a schema-constrained serialization request (`format: json_schema`) to that SAME child session.
5. The structured payload is validated against `ReviewerFindingsInput`, host provenance and attestation are stamped, and the canonical `ReviewFindings` is bound to the obligation.
6. Only after a successful binding does the hook replace the Task output with the completed dispatch signal (`reviewDispatch.completed: true` and the bound verdict).

The LLM then sees the completed `reviewDispatch` response and submits the verdict.

**Contract:** the completed dispatch signal (`reviewDispatch.completed`) is only signaled when the reviewer's structured payload validates and binds against the durable dispatch and invocation evidence. Only host-observed structured output from the same native Task child (`structured_output` / `structured_high`) can bind. The Task's free-form text is never findings authority; unparseable, text-only, or contract-violating reviewer responses never produce a completed dispatch and block with an explicit structured-output code.

### Evidence-Grounded Implementation Review

The frozen implementation review material
(`buildFrozenReviewMaterialContent` in
`src/integration/review/context/reviewer-context.ts`) carries a
`Verification Evidence (host-executed)` section built from FlowGuard-executed
validation attempts, so the reviewer can falsify verification claims against
runtime ground truth instead of inferring them from the diff. The frozen
material is the single canonical carrier for the native reviewer transport; no
separate runtime re-read is injected into the prompt. This evidence is
executor-produced (`flowguard_run_check` via `src/verification/executor.ts`),
never agent-reported: each entry exposes the executed attempt identity
(`attemptId`, `executedAt`), the verification `kind`, `command`, `exitCode`,
pass/fail/timeout status, `executionMs`, the tamper-evident `outputDigest`, and
the execution-continuity observation described below.

Execution-continuity binding:

- Each `implementation`-scope validation attempt persists the host-observed
  `executionObservedStateDigest` (session state observed before the command ran)
  and `preCommitStateDigest` (state re-read under the session write lock
  immediately before the attempt was persisted).
- `stateChangedDuringExecution` is a deterministic projection of that digest
  pair (`executionObservedStateDigest !== preCommitStateDigest`). It is never
  persisted as a second authority.
- `committedStateDigest` deliberately stays out of the attempt record: the
  attempt is itself part of the committed state, so persisting it would create a
  recursive self-binding.
- A changed continuity is a **continuity caveat, not a verdict on the check**.
  The canonical reviewer prompt carries a host-owned rule: when frozen
  host-executed verification evidence records
  `stateChangedDuringExecution: true`, the reviewer treats session-state
  continuity as
  `NOT_VERIFIED: session-state continuity changed during execution.` and never
  changes the executed check verdict solely because of that signal.
- The continuity caveat is deliberately silent about subject re-attestation.
  Under the lock the request and the validation subject are re-validated and
  the execution subject is re-attested before persistence, so an executed PASS
  is bound to an unchanged subject; a subject-changed execution is persisted as
  BLOCKED, never as PASS. Because the evidence section can also contain earlier
  non-passing attempts, the caveat must not be read as a universal
  subject-binding guarantee.

Fail-closed binding rules:

- **Digest binding.** Only `implementation`-scope validation attempts whose
  `implementationDigest` equals the current `implementation.digest` are injected.
  Stale attempts (from a prior implementation revision), `baseline`-scope
  attempts, and foreign-digest attempts are excluded, so the reviewer never
  verifies claims against outdated ground truth
  (`stateVerificationEvidence` in `src/integration/review/shared-helpers.ts`).
- **No silent omission.** When no bound evidence exists, the SDK prompt builder
  renders an explicit `NOT_VERIFIED: no executed verification evidence is bound
to the current implementation digest.` line rather than being dropped — "no
  bound evidence" is itself a review signal.
- **Read-only reviewer preserved.** FlowGuard executes the checks; the reviewer
  model does not. The reviewer stays strictly read-only (`bash: deny`), and the
  reviewer criteria (`REVIEWER_CRITERIA`) are unchanged — the behavior lives in
  the prompt builder, not in a new review authority.
- **Enforcement-safe.** The evidence section is emitted after the
  attestation/context block and uses neutral field labels (`durationMs`,
  `digest`) so it can never introduce `iteration`/`version`-adjacent digits into
  the reviewer prompt.

This surfaces executed evidence to the reviewer; it does not yet _require_ that
the checks were executed before review (a `NOT_VERIFIED` section is still a valid
review input). Mandatory pre-review execution is tracked separately.

### Reviewer Output Contract

Reviewer output is accepted only through the host-observed structured child
session: the plugin prompts the reviewer child session with `format: json_schema`
and binds `reviewOutputMode: "structured_output"` with
`reviewAssuranceLevel: "structured_high"`. There is no text-compatibility
fallback. Failures block explicitly:

| Condition                                                           | BLOCKED Code                                    |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| Reviewer model cannot produce structured output                     | `STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE`      |
| Reviewer Thinking Mode conflicts with the required structured tool  | `STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE` |
| Host does not return the required structured result                 | `HOST_STRUCTURED_OUTPUT_REQUIRED`               |
| Host structured result violates the reviewer findings contract      | `HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION`     |
| Child session output cannot bind to host-owned execution provenance | `REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE`  |

Recovery is to configure the `flowguard-reviewer` agent with a
structured-output-capable model and, for OpenCode, `reasoningEffort: none`; then
re-run the originating FlowGuard command.

### Reviewer Dispatch Recovery

The reviewer is dispatched only by the host. When a tool response still carries
`reviewDispatch.required` without `completed`, the host has not recorded a
completed structured reviewer child session yet. The agent must:

- Follow the `reviewInvocation` instructions and the recovery steps in the tool response — typically re-running the
  originating FlowGuard command to authorize a fresh reviewer dispatch.
- Submit only `reviewVerdict` once `reviewDispatch.completed` reports
  host-observed structured findings, using the verdict in `reviewDispatch.verdict`.
- Never invoke a reviewer itself, never reconstruct findings from text output,
  and never submit copied `reviewFindings`.

> **Enforcement note:** Verdict submission is enforcement-bound to the
> host-observed child session. In strict mode, a verdict without a recorded
> structured invocation blocks with `SUBAGENT_REVIEW_NOT_INVOKED`, and evidence
> that cannot bind to host-owned execution provenance blocks with
> `REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE`.

Self-review is not a fallback. Strict orchestration and parsing failures return BLOCKED (`STRICT_REVIEW_ORCHESTRATION_FAILED`).

### Reviewer Verdict Outcomes

The reviewer subagent returns one of three `overallVerdict` values:

| Verdict             | Outcome                                                                                                                                                                                                                                                                                                          | Loop status                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `accept`            | Findings accepted; if no blocking issues, the review loop converges to PLAN_REVIEW / EVIDENCE_REVIEW.                                                                                                                                                                                                            | converged                     |
| `changes_requested` | Findings recorded; agent revises the artifact and resubmits. Loop continues until convergence or `maxIterations`.                                                                                                                                                                                                | continues                     |
| `unable_to_review`  | The reviewer declares the artifact unreviewable (e.g., contradictory inputs, missing prerequisites, scope ambiguity that prevents critique). The tool returns BLOCKED with code `SUBAGENT_UNABLE_TO_REVIEW`. The pending review obligation is consumed — retrying the review with the same artifact is rejected. | BLOCKED (obligation consumed) |

`unable_to_review` is enforced fail-closed at every layer:

- **Tool layer (`src/integration/review/validation/review-validation.ts`):** rejects `findings.overallVerdict='unable_to_review'` regardless of the submitted reviewer verdict.
- **Native Task transport (`src/integration/review/dispatch/native-task-review.ts`):** when the host-captured reviewer findings declare `unable_to_review`, it routes BLOCKED (code `SUBAGENT_UNABLE_TO_REVIEW`) instead of completing the review.
- **Convergence guard (`isConverged`):** returns `false` for `unable_to_review`, preventing any loop convergence path.
- **Rails layer:** plan/implement/continue rails translate `unable_to_review` into a `BlockedResult` discriminated-union variant.

Recovery: revise the artifact substantially (e.g., new `flowguard_plan({ planText })` with clearer scope) or address the prerequisite that made the artifact unreviewable (e.g., file a new ticket). A fresh artifact submission starts a new review obligation.

#### Acceptance Requires Passing Validation Evidence (Defense-in-Depth)

Accepting an implementation review does not advance to `EVIDENCE_REVIEW` on the
reviewer verdict alone. Before advancing, `handleImplReview` requires that every
active verification check has a **passing execution attempt bound to the current
`implementation.digest`** — checked against `state.validationAttempts`
(scope `implementation`, matching digest, `passed`), the same digest-bound
authority used to inject verification evidence into the reviewer prompt.

On the normal path this is redundant — `IMPL_REVIEW` is only reachable once the
`IMPL_VALIDATION` gate passed — but acceptance must not rely on topology alone.
This gate is deliberately stronger than the machine guard `implValidationPassed`,
which reads the digest-less `implValidation` slot and stays sound only by the
invariant that a fresh implementation clears that slot. By binding to the current
digest instead, any future inbound path to `IMPL_REVIEW`, a topology regression,
or a future mutation of `implementation` that failed to clear stale
`implValidation`, still cannot accept unvalidated or prior-revision code. When the
active checks are unsatisfied, acceptance blocks with
`IMPL_VALIDATION_EVIDENCE_REQUIRED`. Sessions with no active checks are unaffected
— the deliberate zero-check behavior for repos without discoverable verification
commands is preserved.

### Fail-Closed Enforcement

FlowGuard enforces the subagent requirement at three layers:

**Layer 1 — Structural validation (`src/integration/review/validation/review-validation.ts`):**

- When the agent tries to approve without `reviewFindings` → BLOCKED
- Self-review findings are rejected → BLOCKED
- Plan-version binding, iteration binding, and mandatory-findings checks

**Layer 2 — Native Task transport (`src/integration/review/dispatch/native-task-review.ts` via `src/integration/plugin.ts`):**

The plugin programmatically invokes the reviewer subagent via the OpenCode SDK client when it detects the review-dispatch-required signal in a tool response. This ensures invocation happens by code, not by LLM decision.

**Layer 3 — Plugin-level enforcement (`src/integration/review/enforcement/enforcement.ts` via `src/integration/plugin.ts`):**

The structural validation layer cannot detect whether a host-observed reviewer child session actually produced the submitted findings — it only validates their shape. The plugin-level enforcement closes that gap with OpenCode's `tool.execute.before/after` hooks, binding every verdict to the host-dispatched structured child session:

**Level 1 — Invocation Gate** (`tool.execute.before` for flowguard tools):
A host-observed structured reviewer invocation MUST be recorded before any verdict submission. Blocks with `SUBAGENT_REVIEW_NOT_INVOKED`.

**Level 2 — Child Session Match** (`tool.execute.before` for flowguard tools):
When both the host-observed reviewer child session ID and the submitted `reviewFindings.reviewedBy.sessionId` are available, they must match. Blocks with `SUBAGENT_SESSION_MISMATCH`.

**Level 4 — Findings Integrity** (`tool.execute.before` for flowguard tools):
The submitted `reviewFindings` are compared against the host-captured structured reviewer output:

- `overallVerdict` must match exactly (blocks `SUBAGENT_FINDINGS_VERDICT_MISMATCH`)
- `blockingIssues` count must match exactly (blocks `SUBAGENT_FINDINGS_ISSUES_MISMATCH`)
- `accept` with blocking issues is rejected (blocks `SUBAGENT_VERDICT_FINDINGS_INCOHERENT`)

The former Level 3 (Task-prompt integrity) was removed with reviewer Task interception. Reviewer dispatch failures now surface as `STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE`, `HOST_STRUCTURED_OUTPUT_REQUIRED`, `HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION`, or `REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE`.

```
flowguard_plan (initial)    →  tool emits reviewDispatch.required
    ↓                          plugin creates reviewer child session (session.create)
    ↓                          plugin prompts it with format: json_schema
    ↓                          plugin captures host-owned structured output
    ↓                          plugin mutates reviewDispatch to completed
    ↓                          plugin records the invocation in enforcement state
    ↓
flowguard_plan (verdict)    →  L1: host-observed invocation recorded?
                            →  L2: child session ID match?
                            →  L4: findings match host-captured structured output?
                                ↳ ALL PASS → tool executes normally
                                ↳ ANY FAIL → throw → tool call physically blocked
```

Each host-observed reviewer child session fulfills exactly **one** pending review obligation (1:1 contract). Plan review and implement review are independent governance obligations; a verdict binds to the child session recorded for its own obligation. If no matching invocation is recorded, enforcement fails closed.

State is session-scoped and cleared after successful verdict submission. Tracking errors (in `tool.execute.after`) are fire-and-forget and never block governance flow. Enforcement errors (in `tool.execute.before`) are strict and physically prevent the tool call.

**Defense-in-depth note:** The plugin and FlowGuard tools are architecturally separate. If the plugin fails to load, the tools remain available but plugin-level enforcement (Levels 1, 2, and 4) is inactive. In that case, structural validation (Layer 1) still enforces schema compliance, review-mode gating, and mandatory findings. Plugin load failure would also prevent audit event emission, making it detectable through missing audit trails.

---

## OpenCode Configuration

The installer (`flowguard install`) automatically deploys all required artifacts.

### 1. Review Subagent Definition (auto-deployed)

The installer writes `.opencode/agents/flowguard-reviewer.md`:

- `mode: subagent`, `hidden: true`, `steps: 10`
- Read-only: `edit: deny`, `bash: deny`, `webfetch: deny`
- FlowGuard-isolated: `flowguard_*: deny` and `mcp__flowguard__*: deny` are
  agent-specific OpenCode permission rules. They prevent reviewer children from
  hydrating, mutating, or auditing an independent FlowGuard workflow session.
  `task: deny` prevents reviewer subagent cascades; `read`, `glob`, and `grep`
  remain available for review research.
- Adversarial, falsification-first review prompt
- Returns structured ReviewFindings JSON

### 2. Task Permissions (auto-merged)

The installer merges into `opencode.jsonc`:

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

### 3. Mandatory Review Invariant

Independent subagent review is mandatory in every policy mode. It is not configurable: every review requires mandate-bound, one-time reviewer evidence, and self-review findings are blocked.

---

## ReviewFindings Schema

```typescript
{
  iteration:            number    // 0-based, must match expected iteration
  planVersion:          number    // positive integer, must match current plan version
  reviewMode:           'subagent'
  overallVerdict:       'accept' | 'changes_requested' | 'unable_to_review'
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
    toolObligationId:   string    // RFC 4122 UUID; must match strict review obligation id
    iteration:          number    // must match expected iteration
    planVersion:        number    // must match expected plan version
    reviewedBy:         string    // expected: flowguard-reviewer
  }
}
```

Each `Finding` requires `severity`, `category`, `message`, and `relation`.
`relation.subjectAnchors` is a non-empty array of structured repository or artifact
anchors. `relation.evidenceLocations` is required but may be empty. The legacy
free-text `location` field is not accepted.

> **Attestation in subagent mode:** the canonical `ReviewFindings.attestation`
> is optional at the record level (human/self-review shapes do not carry it),
> while the reviewer-facing `ReviewerFindingsInput` requires exactly
> `toolObligationId`. The OpenCode SDK `REVIEW_FINDINGS_JSON_SCHEMA` sent to the
> reviewer child requires that same single field; the host enriches the
> attested record with `mandateDigest`, `criteriaVersion`, `iteration`,
> `planVersion`, and `reviewedBy` before binding. `validateStrictAttestation`
> in `src/integration/review/obligations/assurance.ts` is the runtime gate that rejects a
> missing or mismatched strict attestation fail-closed.

---

## Validation Rules

All validation is fail-closed. Invalid findings return BLOCKED.

**Structural validation (`src/integration/review/validation/review-validation.ts`):**

| Rule                 | Condition                            | BLOCKED Code                         |
| -------------------- | ------------------------------------ | ------------------------------------ |
| Self mode gating     | `reviewMode=self`                    | `REVIEW_MODE_SELF_NOT_ALLOWED`       |
| Plan version binding | `findings.planVersion !== expected`  | `REVIEW_PLAN_VERSION_MISMATCH`       |
| Iteration binding    | `findings.iteration !== expected`    | `REVIEW_ITERATION_MISMATCH`          |
| Mandatory findings   | verdict + no findings                | `REVIEW_FINDINGS_REQUIRED`           |
| Strict enforcement   | plugin assurance unavailable         | `PLUGIN_ENFORCEMENT_UNAVAILABLE`     |
| Strict enforcement   | orchestration obligation blocked     | `STRICT_REVIEW_ORCHESTRATION_FAILED` |
| Strict enforcement   | subagent evidence missing            | `SUBAGENT_EVIDENCE_MISSING`          |
| Strict enforcement   | attestation missing                  | `SUBAGENT_MANDATE_MISSING`           |
| Strict enforcement   | attestation mismatch                 | `SUBAGENT_MANDATE_MISMATCH`          |
| Strict enforcement   | invocation evidence already consumed | `SUBAGENT_EVIDENCE_REUSED`           |

Validation logic is implemented once in `src/integration/review/validation/review-validation.ts` and shared by `/plan`, `/architecture`, `/implement`, and `/review` tools. The `obligationType` discriminator (`'plan' | 'architecture' | 'implement' | 'review'`) selects per-obligation criteria. Plan, architecture, and implementation reviews bind iteration/version fields; standalone `/review` additionally binds the obligation to the concrete review input fingerprint and `toolObligationId`.

**Challenge freshness binding (both ingestion routes).** When an obligation
carries a frozen challenge requirement, challenge `evidenceRefs` are validated
against the obligation's `allowedEvidenceRefs`, and each challenge's
`obligationId` must equal the active obligation (`expectedObligationId`). This
obligation-scoping applies to **every** challenge-bearing obligation type —
plan/architecture `design_challenge`, implement `implementation_challenge`, and
peer review `content_challenge` — not to implementation alone. For
implementation challenges the allowed set additionally binds an `outcome='pass'`
challenge to a validation attempt for the **current** implementation digest — a
stale, failed, foreign, or wrong-obligation reference is rejected with
`SUBAGENT_CHALLENGE_EVIDENCE_MISSING`. Both ingestion routes pass this binding
context identically: the host-captured path (`resolveHostTaskFindings`) and the
directly-submitted path
(`resolveHostTaskEffectiveFindings` → `validateReviewFindings`). Neither route can
accept a challenge whose evidence is outside the frozen allowed set.

**Plugin-level enforcement (`src/integration/review/enforcement/enforcement.ts`):**

| Level   | Rule                | Condition                                                                                   | BLOCKED Code                         | Hook Point                |
| ------- | ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------- |
| L1      | Invocation recorded | Pending review + no host-observed structured reviewer invocation recorded                   | `SUBAGENT_REVIEW_NOT_INVOKED`        | before verdict tool       |
| L2      | Child session match | `reviewedBy.sessionId` does not match the host-observed reviewer child session ID           | `SUBAGENT_SESSION_MISMATCH`          | before verdict tool       |
| L4      | Verdict integrity   | Submitted `overallVerdict` differs from the host-captured reviewer verdict                  | `SUBAGENT_FINDINGS_VERDICT_MISMATCH` | before verdict tool       |
| L4      | Issues integrity    | Submitted `blockingIssues` count differs from the host-captured reviewer count              | `SUBAGENT_FINDINGS_ISSUES_MISMATCH`  | before verdict tool       |
| L4/Tool | Reviewability       | Submitted `overallVerdict='unable_to_review'` (reviewer declared the artifact unreviewable) | `SUBAGENT_UNABLE_TO_REVIEW`          | tool layer + orchestrator |

L3 (Task-prompt integrity) was removed with reviewer Task interception; reviewer
dispatch contract failures surface as `STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE`,
`STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE`,
`HOST_STRUCTURED_OUTPUT_REQUIRED`, `HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION`, or
`REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE`.

Enforcement logic is implemented in `src/integration/review/enforcement/enforcement.ts` (with supporting modules under `src/integration/review/enforcement/`) and integrated via `tool.execute.before/after` hooks in `src/integration/plugin.ts`.

---

## Persistence Model

Author and reviewer artifacts are stored in parallel, never mixed:

| Tool            | Author artifacts                                     | Reviewer artifacts                                |
| --------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `/plan`         | `state.plan.current`, `state.plan.history`           | `state.plan.reviewFindings`                       |
| `/architecture` | `state.architecture.decisions[id].adrText` + history | `state.architecture.decisions[id].reviewFindings` |
| `/implement`    | `state.implementation`                               | `state.implReviewFindings`                        |

Reviewer findings for `/plan`, `/architecture`, and `/implement` are **append-only** in their respective state locations. Each review submission adds to the array; no entries are ever removed or overwritten. ADR review findings are scoped per-decision-id (one append-only array per ADR), parity with how plan history is iteration-scoped. Standalone `/review` records accepted findings in the generated review report together with explicit target coverage — target resolved/frozen, repository identity, base/head SHA, changed-path count, objectives covered/total, review assurance tier, and missing-verification messages — plus invocation evidence and derived review-card artifacts. These are evidence surfaces, not runtime authority.

### Standalone /review Obligation Lifecycle

Standalone `/review` creates its own obligation lifecycle (obligationType `review`), independent of plan/architecture/implement obligations:

1. Content-aware `/review` without findings → blocked with `CONTENT_ANALYSIS_REQUIRED` + `requiredReviewAttestation` (containing the obligation UUID)
2. Reviewer dispatch (host-structured on OpenCode; external/native transport on Claude Code and Codex)
3. `/review` with `reviewFindings` matching the obligation UUID → validated via `validateStrictAttestation`
4. Obligation consumed on success (single-use enforcement)

Invocation evidence carries source marking:

- `host-orchestrated` — the host created the reviewer child session and captured its structured output (stronger evidence: real `childSessionId`, real `promptHash`)
- `agent-submitted-attested` — external/native transport evidence submitted outside the host-observed child session (attested but reconstructed evidence)

Both sources are validated through the same `validateStrictAttestation` gate. Attested evidence is accepted only when subagent-attested and obligation-bound.

#### Discovery Context Requirement (Issue #401)

Standalone PR/content `/review` evaluates external diffs against the **current repository**, so it requires compact Discovery context as review evidence:

- The content-review prompt requires Discovery context (`buildReviewContentPrompt`'s `discoveryContext` is non-optional); the content/PR pipeline enables a **bounded drift check** so reviewers see whether local Discovery is drifted relative to the reviewed branch/diff. Drift checking fails closed: a timeout or error produces an explicit drift failure status (`timeout` / `discovery_drift_timeout`, or `unavailable` / `discovery_drift_unavailable`) rendered as `NOT_VERIFIED`.
- Reviewers MUST check Discovery **health and drift before** any repo-dependent quality claim, flag generic verification suggestions when repo-native `verificationCandidates` exist, and mark Discovery-dependent claims `NOT_VERIFIED` when the content cannot be correlated to local Discovery (diff references files absent from the Discovery snapshot, or local Discovery is drifted).
- Discovery context is advisory falsification **evidence**, not review verdict authority: ReviewFindings, obligation binding, mandate digest, and attestation remain the review authority. The same shared Discovery review-context builder is reused — there is no separate PR-only Discovery authority. <!-- NOT_VERIFIED: drift-check latency/behavior under live repositories is bounded by the status drift timeout but not measured here. -->

---

## Status Projections

`flowguard_status` exposes the latest review summary for all three reviewable tools:

- `latestReview` — latest plan review findings (iteration, planVersion, overallVerdict, counts, reviewMode, reviewedAt)
- `latestArchitectureReview` — latest architecture (ADR) review findings. planVersion is a compatibility binding for the ADR review subject and must not be interpreted as the task plan version.
- `latestImplementationReview` — latest implementation review findings (same shape without planVersion)

---

## Installed Artifacts

The `flowguard install` command deploys:

| Artifact        | Path                                                        | Purpose                                                                       |
| --------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Review subagent | `.opencode/agents/flowguard-reviewer.md`                    | Hidden subagent definition with adversarial review prompt                     |
| Task permission | `opencode.jsonc` (merged)                                   | Explicitly allows flowguard-reviewer, denies all others                       |
| Slash commands  | `.opencode/commands/plan.md`, `implement.md`, `continue.md` | Review-loop routing: submit the bound verdict / follow host-dispatch recovery |
| Plugin          | `.opencode/plugins/flowguard-audit.ts`                      | Re-exports FlowGuardAuditPlugin (orchestration + enforcement)                 |

### Security Model Clarification

**Task tool permissions** use OpenCode's last-matching-rule semantics. The explicit allow for `flowguard-reviewer` combined with deny for `*` ensures no other subagent can be invoked via the Task tool by the build agent. <!-- NOT_VERIFIED: the claim that @subagent direct calls bypass permission.task has not been confirmed against the OpenCode permissions implementation. -->

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
2. **Deterministic invocation** — The parent agent dispatches the visible native `task` reviewer; the plugin before/after hooks bind the exact child session and capture schema-constrained findings in that same child. There is no hidden SDK auto-spawn and no text fallback.
3. **Plugin-level enforcement** — Host-observed child-session enforcement via OpenCode `tool.execute.before/after` hooks:
   - L1: Invocation gate — a host-observed structured reviewer invocation must be recorded before any verdict
   - L2: Child session match — submitted session ID must match the host-observed reviewer child session
   - L4: Findings integrity — submitted overallVerdict and blockingIssues count must match the host-captured structured reviewer output
4. **1:1 obligation matching** — Each host-observed reviewer child session fulfills exactly one pending review obligation. Plan and implement are independent; if both are pending, each requires its own reviewer dispatch. A verdict binds to the child session recorded for its own obligation; no matching invocation = fail-closed.
5. **Strict evidence contract ** — With `strictEnforcement=true`, verdicts are accepted only when obligation, invocation evidence, and reviewer attestation are all present, mandate-bound, and single-use. No fallback to probabilistic review.

Mandatory by default. The default policy enables strict subagent review, blocks self-review evidence, and normalizes missing or weaker session snapshots to the mandatory strict configuration.

---

FlowGuard Version: 1.2.0-tp.2
_Last Updated: 2026-04-24_
