# Commands

FlowGuard distinguishes between **Workflow Commands** (drive session state) and **Operational Tools** (operate on session artifacts).

## Command Surface

FlowGuard uses a two-level command surface:

| Level           | Syntax                  | Example                                 | Purpose                |
| --------------- | ----------------------- | --------------------------------------- | ---------------------- |
| **User-facing** | `/<command>`            | `/hydrate`, `/ticket`                   | OpenCode chat commands |
| **Internal**    | `flowguard_<tool-name>` | `flowguard_hydrate`, `flowguard_ticket` | OpenCode tool bindings |

The `/<command>` syntax invokes the corresponding `flowguard_<tool-name>` tool internally.

**Naming exceptions** (slash command and tool name differ):

| Slash command         | Tool binding              | Reason                                                                                        |
| --------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `/review-decision`    | `flowguard_decision`      | Tool kept short; verdict-routing is the surface                                               |
| `/abort`              | `flowguard_abort_session` | Tool name disambiguates `abort` from `serve`/`run`                                            |
| `/validate`, `/check` | `flowguard_run_check`     | The tool runs verification checks; `/validate` and the `/check` product alias both bind to it |

For all other commands, slash and tool names match `1:1` (`/hydrate` →
`flowguard_hydrate`, `/architecture` → `flowguard_architecture`, etc.).

### Interactive vs Non-Interactive Execution

- Interactive chat sessions may ask one precise follow-up question when required inputs are missing.
- Non-interactive/headless execution (`flowguard run`, `flowguard serve`, host CLI/API automation) does not rely on follow-up questions.
- `flowguard run --host opencode|claude-code|codex` selects only the host execution process. Governance authority remains in FlowGuard MCP tools, hooks, state, policy, audit, and validated review evidence.
- `flowguard serve` currently has verified native support only for OpenCode. Claude Code and Codex serve attempts fail closed with `HOST_SERVE_UNSUPPORTED`.
- In headless mode, missing safety-critical input returns `BLOCKED` with required values and recovery guidance.

## Flows

After `/hydrate`, the session starts in the **READY** phase. Three standalone flows are available:

| Flow             | Command         | Phases                                                                                                                         | Purpose                                              |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| **Ticket**       | `/ticket`       | READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_VALIDATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE | Full development lifecycle                           |
| **Architecture** | `/architecture` | READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE                                                                             | Create an Architecture Decision Record (ADR)         |
| **Review**       | `/review`       | READY → REVIEW → REVIEW_COMPLETE                                                                                               | Generate a compliance or content-aware review report |

## Product Commands

Product commands invoke canonical FlowGuard tools. Runtime enforcement remains in the canonical command policy or in the target tool's fail-closed checks.

| Product command    | Canonical command                    | Description                                                            |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------- |
| `/start`           | `/hydrate`                           | Start a governed session                                               |
| `/task`            | `/ticket`                            | Capture a governed task                                                |
| `/plan`            | `/plan`                              | Generate an implementation plan (same name)                            |
| `/approve`         | `/review-decision approve`           | Approve the current review gate                                        |
| `/request-changes` | `/review-decision changes_requested` | Request changes at the current review gate                             |
| `/reject`          | `/review-decision reject`            | Reject the current review gate                                         |
| `/implement`       | `/implement`                         | Execute the approved plan (same name)                                  |
| `/check`           | `/validate`                          | Run validation checks                                                  |
| `/export`          | `/archive`                           | Export a redacted sharing package or an authorized raw auditor package |
| `/status`          | `/status`                            | Show current phase, evidence, and next action (same name)              |
| `/why`             | `/status --why-blocked`              | Show why the workflow is blocked                                       |
| `/review`          | `/review`                            | Generate a compliance/content review report (same name)                |
| `/architecture`    | `/architecture`                      | Create an ADR (same name)                                              |

Product commands are the recommended surface for daily use. Advanced/canonical commands are documented below and remain fully supported for scripts, CI, and power users.

## Workflow Commands (Advanced/Canonical)

These are the canonical commands that drive the session through the workflow phases. All governance assertions, audit records, and reason codes use canonical command names.

### /status

Read-only orientation surface for the current session.

Use `/status` to inspect where the workflow is, what is allowed, and what happens next.
It does not mutate state and is safe to call at any time.

When a session exists, full `/status` responses include `discoveryHealth`. Valid discovery artifacts return an available advisory projection; missing, corrupt, schema-invalid, or unreadable discovery artifacts return `status: "unavailable"` with a deterministic `reason`, `recovery`, and `notVerified` guidance. Status never recreates discovery artifacts, hides corrupt data behind fake healthy defaults, or weakens discovery schema validation. Agents must mark discovery-dependent claims `NOT_VERIFIED` until `/hydrate` or the listed recovery step restores valid discovery evidence.

Full `/status` responses include `implementationGuidance` when a session exists. This is a compact, runtime-only, advisory projection from `DiscoveryResult` and `SessionState` that can list relevant files, modules, surfaces, tests, contracts, and risk hotspots with confidence and evidence provenance. It is not persisted, is not a second plan/ticket/risk authority, and never overrides phase gates, policy gates, review obligations, validation requirements, or the approved plan. Missing or degraded discovery is surfaced with `NOT_VERIFIED` wording and capped confidence instead of fake certainty.

Discovery code-surface data may include bounded semantic extraction for common TypeScript/JavaScript and Java Spring patterns such as route handlers, controllers, auth guards, data-access boundaries, and test targets. These signals remain advisory `DiscoveryResult.codeSurfaces` evidence with confidence and locations; unsupported frameworks degrade to heuristic-only behavior rather than invented architecture truth.

Full `/status` responses also include `discoveryDrift` when a session exists. This is a bounded, read-only, advisory projection from `checkDiscoveryDrift()` with explicit statuses: `clean`, `drifted`, `missing_discovery`, `unavailable`, `timeout`, or `not_checked`. Drift status does not overwrite discovery artifacts, does not rehydrate, and is not an approval or denial authority. `discoveryHealth.ageWarning` only indicates stale collection time; `discoveryDrift.status` indicates whether a stable digest comparison found actual repository drift. Drift timeouts bound the status response, but underlying discovery work may continue if the existing discovery path cannot be aborted.

Optional focused views:

- `/status --why-blocked` — blocker analysis from evaluator/completeness truth
- `/status --evidence` — slot-by-slot evidence detail
- `/status --context` — actor/policy/archive context projection
- `/status --readiness` — compact operational readiness projection

When multiple flags are provided simultaneously, flag precedence is deterministic: `--finish` > `--why-blocked` > `--evidence` > `--context` > `--readiness`. Only the highest-precedence matching flag is applied.

`/status` maps internally to `flowguard_status`.

### /finish

Read-only readiness overview rendered before `/export`, PR, or archive decisions.

`/finish` is a **status aggregator, not an approval, merge, or archive-finalization command**. It never approves anything, never consumes review obligations, never writes state, and never triggers `/export`. It only reports and recommends; the user decides.

It composes existing authorities (the readiness projection, evidence completeness, and the canonical next action) and renders a Finish Card:

- `overallStatus` — one of `READY`, `READY_WITH_WARNINGS`, `BLOCKED`, or `NOT_VERIFIED`. Missing or failed required evidence is reported as `NOT_VERIFIED`, never as a pass. `BLOCKED` takes precedence over `NOT_VERIFIED`.
- `readiness`, `evidence`, `warnings` — the underlying projection results, unmodified.
- `nextAction` — the canonical next action.
- `actionGuidance` — non-normative labels (`recommended` / `not_recommended` / `not_verified`) for candidate actions (create PR, export evidence, keep branch). These are presentation labels only; they are **not** command-policy decisions and must not be consumed for enforcement.
- `exitOptions` — user-owned exit choices such as `abandon`, which are never rendered as forbidden.

Difference from `/status --readiness`: `/status --readiness` returns the compact readiness projection; `/finish` additionally derives the single `overallStatus`, the non-normative action guidance, and the exit options as a curated pre-export card. Fail-closed enforcement remains with `/export` and the existing gates — `/finish` reports a blocker, it does not enforce one.

Available in any phase, including terminal phases (`COMPLETE`, `ARCH_COMPLETE`, `REVIEW_COMPLETE`). When no session exists, `/finish` reports this and recommends `/hydrate`.

`/finish` maps internally to `flowguard_status` with `{ finish: true }`.

### /help

Read-only, context-sensitive FlowGuard guidance. `/help` shows the current phase,
one recommended next action, and a compact list of relevant commands. Use
`/help <command>` for command details; use `--verbose` only when phase IDs,
preflight reasons, or canonical aliases are needed.

### /commands

Read-only command listing for the current session. `/commands` shows currently
relevant commands. `/commands --all` shows the complete installed command
reference, including visible compatibility invocations.

### /hydrate

Bootstrap or reload the FlowGuard session. Idempotent — safe to call repeatedly.

**Creates:**

- Session state in workspace registry
- Discovery results (repository metadata, stack, topology)
- Profile resolution

**Arguments:** `policyMode` (optional): `solo`, `team`, `team-ci`, or `regulated`.
When omitted, reads `flowguard.json` → `policy.defaultMode`, then falls back to `team` (human-gated).

If `FLOWGUARD_POLICY_PATH` is set, `/hydrate` enforces the central `minimumMode` from that
file. Explicit weaker modes are blocked; repo/default weaker modes are elevated with visible
resolution evidence.

`team-ci` semantics:

- In CI context: effective mode = `team-ci` (auto-approve at user gates)
- Without CI context: degrades to `team` (human-gated), reason `ci_context_missing`
  **Starts at:** READY

### /ticket

Record the task description. Starts the ticket flow from READY or updates ticket in TICKET phase.

**Allowed in:** READY, TICKET
**Arguments:**

- `text` (required): Task description
- `inputOrigin` (optional): Where the text came from — `manual_text` (typed by user), `external_reference` (extracted from URL/tracker), or `mixed` (both)
- `references` (optional): Array of external references with audit provenance. Each reference has:
  - `ref` (required): URL, ticket ID, or reference string
  - `type` (optional): `ticket` (Jira/ADOS), `issue` (GitHub/GitLab), `pr`, `branch`, `commit`, `url`, `doc` (Confluence/spec), `other`
  - `title` (optional): Extracted title from the reference
  - `source` (optional): Platform — `jira`, `ados`, `github`, `gitlab`, `confluence`, etc.
  - `extractedAt` (optional): ISO timestamp — only set when content was actually extracted

**Examples:**

- `/ticket Fix the auth bug in login.ts`
- `/ticket https://jira.example.com/browse/PROJ-123` — agent fetches Jira, extracts title+description, stores URL as reference
- `/ticket PROJ-123 Fix login redirect` — mixed: manual text + ticket ID

**Derived artifacts:** On successful state persistence, FlowGuard materializes append-only evidence artifacts:

- `artifacts/ticket.v{n}.md` (human-readable)
- `artifacts/ticket.v{n}.json` (machine-verifiable metadata)

### /plan

Generate an implementation plan with mandatory independent subagent review.

1. LLM generates plan text
2. `flowguard-reviewer` reviews the plan
3. Plan refined until independent review convergence
4. Advances to PLAN_REVIEW

**Allowed in:** TICKET, PLAN

When `/plan` advances to PLAN_REVIEW, the Plan Review Card footer renders the available decision commands as explanatory bullets:

- `/approve` — approve the plan if it is complete and acceptable
- `/request-changes` — send the plan back for revision
- `/reject` — stop this task

**Derived artifacts:** Every recorded plan revision is materialized as append-only evidence artifacts:

- `artifacts/plan.v{n}.md` (human-readable)
- `artifacts/plan.v{n}.json` (machine-verifiable metadata)

FlowGuard fail-closes governance commands when required ticket/plan artifacts are missing, malformed, or digest/hash-inconsistent with current ticket/plan evidence.

### /review-decision

Record a human verdict at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW).
The slash command name `review-decision` differs from the tool name; the tool is
registered as `flowguard_decision`.

**Allowed in:** PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW

**Verdicts:**

- `approve` → advance to next phase
- `changes_requested` → return to previous phase for revision
- `reject` → restart (TICKET for ticket flow, READY for architecture flow)

**Four-eyes (regulated mode):** `approve` requires reviewer identity different
from session initiator, and both identities must be known. Same-actor approve
returns BLOCKED `FOUR_EYES_ACTOR_MATCH`. (Related regulated-mode blockers when
identities are missing or unknown: `DECISION_IDENTITY_REQUIRED`,
`REGULATED_ACTOR_UNKNOWN`.)

**Actor assurance gate (any mode with `policy.minimumActorAssuranceForApproval`
set above the default `best_effort`):** the approver's resolved assurance tier
must be `>=` the configured minimum. Insufficient assurance returns BLOCKED
`ACTOR_ASSURANCE_INSUFFICIENT`. If `policy.identityProviderMode = required` and
the approver cannot be IdP-verified, returns BLOCKED `ACTOR_IDP_MODE_REQUIRED`.
See `docs/policies.md` "Actor Identity & Assurance" for configuration.

Every successful `/review-decision` emits a decision receipt in the audit trail
(`decision:DEC-xxx`). Archive Layout v2 writes the raw companion projection as
`audit/decision-receipts.v1.json`.

### /validate

Run validation checks against the approved plan.

**Allowed in:** VALIDATION
**Checks:** Derived from `verificationCandidates` (refer to `docs/configuration.md#profileactivechecks`)
**ALL_PASSED** → advance to IMPLEMENTATION

When `flowguard_run_check` executes, a failed or timed-out check includes an advisory `derivedRepairGuidance` projection parsed from stdout/stderr. Guidance is bounded (excerpts, locations, categories) and labelled `NOT_VERIFIED`. It never determines pass/fail — the `exitCode`, `passed`, `timedOut`, and `outputDigest` remain the authoritative execution evidence. Unknown or unparseable failures return `status: "unavailable"` without fabricated advice. Passing checks surface no repair guidance. Guidance is persisted only so `/status` can surface it later; raw subprocess output is never persisted.

### /implement

Execute the implementation plan.

1. LLM implements using OpenCode tools
2. Changed files recorded via git
3. Independent implementation review loop (`IMPLEMENTATION` → `IMPL_REVIEW` →
   `REVIEW_MET` convergence; bounded by `maxImplReviewIterations`)
4. Advances to EVIDENCE_REVIEW

**Allowed in:** IMPLEMENTATION

The convergence event fired by the machine is `REVIEW_MET`; the reviewer
subagent's loop verdict is `accept` / `changes_requested` (the human
EVIDENCE_REVIEW gate separately uses `approve` / `changes_requested` / `reject`).
See `docs/phases.md#review-loop` for the loop semantics.

### /resolve-implementation-challenge

Record advisory `NOT_VERIFIED` evidence that a prior implementation challenge was addressed.

**Allowed in:** IMPL_REVIEW

Provide the challenge ID from the prior implementation review and one or more passing
post-implementation validation attempt IDs for the current implementation digest. This
does not accept the review, resolve the challenge by itself, or bypass EVIDENCE_REVIEW.

### /reconcile-mutation-episode

Resolve a host mutation episode whose outcome can never be observed (the host process
died between the Before- and After-hook). Appends an append-only resolution record
(`reconciled_after_unknown_outcome`, basis `worktree_recapture`).

After resolution, **all** prior implementation, validation, and review evidence is
unreliable: re-apply the work, record it with `/implement`, re-run the checks, and
submit a fresh review. Never use this command for a host call with a known outcome.

**Allowed in:** any phase with an unresolved `dispatch_authorized` host mutation episode.

### /architecture

Create or revise an Architecture Decision Record (ADR).

Two modes:

- **Mode A (submit ADR):** Provide `title`, `adrText`. ADR ID is auto-generated (`ADR-001`, `ADR-002`, ...). Records ADR and starts the **independent subagent review loop**.
- **Mode B (ADR review):** Provide `reviewVerdict` plus `reviewFindings` from the `flowguard-reviewer` subagent. On convergence, advances to ARCH_REVIEW.

ADR must include `## Context`, `## Decision`, and `## Consequences` sections (MADR format).

ADR review is **subagent-driven by default** in solo, team, and regulated profiles, parity with `/plan` and `/implement`. The plugin invokes the reviewer deterministically; manual self-review is rejected in strict mode (fail-closed). The reviewer applies ADR-specific criteria (Context completeness, Decision concreteness, Consequences honesty, MADR structure) defined in the `flowguard-reviewer` agent body.

**Allowed in:** READY (starts flow), ARCHITECTURE (revise after changes_requested)

### /review

Start the standalone review flow. Supports content-aware review (PR, branch, URL, text) with subagent-attested findings and an obligation-bound lifecycle.

**Allowed in:** READY
**Arguments (all optional):**

- `text` (optional): Direct text blob to review.
- `prNumber` (optional): GitHub PR number — loads PR diff via `gh` CLI.
- `branch` (optional): Git branch name. FlowGuard resolves and freezes the local or remote branch at exact base/head commits, then loads the canonical diff. No remote is required when both refs exist locally.
- `url` (optional): URL content to review.
- `inputOrigin` (optional): Where the content originated — `pr`, `branch`, `external_reference`, `mixed`, `manual_text`, etc.
- `references` (optional): Array of external references with audit provenance. Same structure as `/ticket` references with types like `pr`, `branch`, `commit`, etc.
- `reviewFindings` (optional): Complete `ReviewFindings` object from `flowguard-reviewer` subagent. Required when content-aware fields are provided.

**Examples:**

- `/review` — plain compliance report (no external content)
- `/review prNumber=42` — content-aware review with PR diff (blocked, agent invokes subagent)
- `/review prNumber=42 reviewFindings=<ReviewFindings>` — submit subagent findings

**Produces:**

- `requiredReviewAttestation` (blocked response with obligation UUID — content-aware only)
- `reviewCard` (markdown, display verbatim)
- Evidence completeness matrix
- Four-eyes status
- Validation summary
- Findings
- External references (if provided)
- `flowguard-review-report.v1` artifact

### /continue

Universal routing command. Inspects current phase and does the next appropriate action.

- At user gates: returns "waiting" (use /review-decision)
- At PLAN: runs one independent subagent review iteration
- At ARCHITECTURE: runs one ADR review iteration
- At IMPL_REVIEW: runs one independent implementation review iteration
- At VALIDATION: runs all validation checks
- At other phases: evaluates and auto-advances if evidence is present

### /abort

Emergency session termination. Bypasses the topology and directly sets phase
to `COMPLETE` with `error.code = 'ABORTED'`. Irreversible. Allowed in any
non-terminal phase, **including the architecture and review flows**: aborted
sessions always land in `COMPLETE`, not `ARCH_COMPLETE` or `REVIEW_COMPLETE`.
Compliance consumers filtering for the natural terminal of each flow should
therefore include `phase === 'COMPLETE' && error?.code === 'ABORTED'` as a
distinct case. Aborting from a terminal phase (`COMPLETE`, `ARCH_COMPLETE`,
`REVIEW_COMPLETE`) is an idempotent no-op that preserves state. Aborted
sessions remain identifiable post-mortem via `state.error.code === 'ABORTED'`.

## Operational Tools

These tools operate on session artifacts but don't drive workflow.

### flowguard_status

Read-only status tool used by `/status` and other slash commands to inspect
session state. Exported as a top-level OpenCode tool — operators and scripts
may invoke it directly with the same fail-closed semantics as `/status`.

In addition to phase and evidence summary, status now surfaces:

- `detectedStack` — compact stack evidence derived from discovery
- `verificationCandidates` — advisory, evidence-backed verification command candidates

`verificationCandidates` are planner outputs only (never auto-executed by FlowGuard).

### /archive

Archive a completed session as a `.tar.gz` file with integrity verification.

**Phase:** COMPLETE
**Creates:**

- `{workspace}/sessions/archive/{sessionId}.tar.gz`
- `{sessionId}.tar.gz.sha256`

Regulated clean completion stores its mandatory raw-evidence package separately
as `regulated-{sessionId}.tar.gz`; later sharing exports cannot overwrite it.

- `archive-manifest.json`
- `audit/decision-receipts.v1.json`
- `reports/review-report.json` (when review report exists)

Archive Layout v2 defaults to a redacted sharing archive (`basic`,
`includeRaw=false`). It reports `not_verifiable` because canonical state and the
audit chain are intentionally omitted. A confidential raw export requires
`archive.redaction.allowRawExport=true` and `redactionMode=none, includeRaw=true`;
it records `rawIncluded: true` with the `raw_audit_evidence_export` risk flag and
is eligible for `verifyArchive()`.

External references recorded via `/ticket` remain raw in the canonical
`state/session-state.json` and `reports/review-report.json` of a raw-evidence
archive. Redacted sharing archives contain only their redacted projections.

**Verification:** `verifyArchive()` (defined in
`src/adapters/workspace/archive.ts`) validates integrity. Possible finding
codes are enumerated in `docs/archive.md#verification-finding-codes` and the
source enum in `src/archive/types.ts` (`AUDIT_CHAIN_*`, `MANIFEST_*`,
`FILE_DIGEST_*`, `CONTENT_DIGEST_*`, `ARCHIVE_CHECKSUM_*`,
`TIMESTAMP_UNANCHORED`, `TSA_VERIFICATION_FAILED`, plus per-artifact binding
codes).

**Regulated mode:** In regulated mode, clean completion (`EVIDENCE_REVIEW → APPROVE → COMPLETE`) triggers
synchronous archive creation + verification. The `archiveStatus` field on session state tracks the lifecycle
(`pending` → `created` → `verified` or `failed`). Checksum sidecar failure is fatal in regulated mode. Manual redacted sharing exports use `not_verifiable`, never `failed`, when raw evidence was intentionally excluded.

**Note:** This is an operational export action. The original session is preserved.

### `flowguard inspect` — Session Compliance Reporting

Read-only CLI command that surfaces existing audit and compliance data without mutation.

**Usage:**

```bash
flowguard inspect                      # List all sessions in the workspace
flowguard inspect --session <id>       # Full compliance report for one session
flowguard inspect --session <id> --json # ComplianceSummary as JSON
```

**Modes:**

| Mode           | Output                                                        |
| -------------- | ------------------------------------------------------------- |
| List (no args) | Session ID, event count, phase progression, last event age    |
| Single session | Check-by-check pass/fail with statistics and chain integrity  |
| `--json`       | Direct `ComplianceSummary` object from `src/audit/summary.ts` |

**Data sources (delegated, no duplicate logic):**

- `src/audit/summary.ts:generateComplianceSummary()` — 6 compliance checks
- `src/audit/query.ts` — session discovery, event filtering, statistics
- `src/audit/integrity.ts:verifyChain()` — hash chain verification
- `src/adapters/persistence-audit.ts:readAuditTrail()` — JSONL audit trail loading

**Fail-closed behavior:**

| Scenario           | Output                                                |
| ------------------ | ----------------------------------------------------- |
| No workspace found | `No FlowGuard sessions found.` (exit 0)               |
| Session not found  | `Session <id> not found in this workspace.` (exit 1)  |
| Empty audit trail  | `No audit events recorded for this session.` (exit 1) |
| Unreadable trail   | `Cannot read audit trail: <error>` (exit 1)           |

**Non-Goals:** No state mutation, no schema changes, no new audit capabilities, no OpenCode slash command — CLI-only projection of existing audit data.
