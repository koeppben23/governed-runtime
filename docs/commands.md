# Commands

FlowGuard distinguishes between **Workflow Commands** (drive session state) and **Operational Tools** (operate on session artifacts).

## Command Surface

FlowGuard uses a two-level command surface:

| Level           | Syntax              | Example                                 | Purpose                |
| --------------- | ------------------- | --------------------------------------- | ---------------------- |
| **User-facing** | `/command`          | `/hydrate`, `/ticket`                   | OpenCode chat commands |
| **Internal**    | `flowguard_command` | `flowguard_hydrate`, `flowguard_ticket` | OpenCode tool bindings |

The `/command` syntax invokes the corresponding `flowguard_command` tool internally.

### Interactive vs Non-Interactive Execution

- Interactive chat sessions may ask one precise follow-up question when required inputs are missing.
- Non-interactive/headless execution (`flowguard run`, `flowguard serve`, OpenCode API automation) does not rely on follow-up questions.
- In headless mode, missing safety-critical input returns `BLOCKED` with required values and recovery guidance.

## Flows

After `/hydrate`, the session starts in the **READY** phase. Three standalone flows are available:

| Flow             | Command         | Phases                                                                                                       | Purpose                                      |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Ticket**       | `/ticket`       | READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE | Full development lifecycle                   |
| **Architecture** | `/architecture` | READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE                                                           | Create an Architecture Decision Record (ADR) |
| **Review**       | `/review`       | READY → REVIEW → REVIEW_COMPLETE                                                                             | Generate a compliance review report          |

## Product Commands

Product commands invoke canonical FlowGuard tools. Runtime enforcement remains in the canonical command policy or in the target tool's fail-closed checks.

| Product command    | Canonical command                    | Description                                               |
| ------------------ | ------------------------------------ | --------------------------------------------------------- |
| `/start`           | `/hydrate`                           | Start a governed session                                  |
| `/task`            | `/ticket`                            | Capture a governed task                                   |
| `/plan`            | `/plan`                              | Generate an implementation plan (same name)               |
| `/approve`         | `/review-decision approve`           | Approve the current review gate                           |
| `/request-changes` | `/review-decision changes_requested` | Request changes at the current review gate                |
| `/reject`          | `/review-decision reject`            | Reject the current review gate                            |
| `/implement`       | `/implement`                         | Execute the approved plan (same name)                     |
| `/check`           | `/validate`                          | Run validation checks                                     |
| `/export`          | `/archive`                           | Export a verifiable audit package                         |
| `/status`          | `/status`                            | Show current phase, evidence, and next action (same name) |
| `/why`             | `/status --why-blocked`              | Show why the workflow is blocked                          |
| `/review`          | `/review`                            | Generate a compliance review report (same name)           |
| `/architecture`    | `/architecture`                      | Create an ADR (same name)                                 |

Product commands are the recommended surface for daily use. Advanced/canonical commands are documented below and remain fully supported for scripts, CI, and power users.

## Workflow Commands (Advanced/Canonical)

These are the canonical commands that drive the session through the workflow phases. All governance assertions, audit records, and reason codes use canonical command names.

### /status

Read-only orientation surface for the current session.

Use `/status` to inspect where the workflow is, what is allowed, and what happens next.
It does not mutate state and is safe to call at any time.

Optional focused views:

- `/status --why-blocked` — blocker analysis from evaluator/completeness truth
- `/status --evidence` — slot-by-slot evidence detail
- `/status --context` — actor/policy/archive context projection
- `/status --readiness` — compact operational readiness projection

When multiple flags are provided simultaneously, flag precedence is deterministic: `--why-blocked` > `--evidence` > `--context` > `--readiness`. Only the highest-precedence matching flag is applied.

`/status` maps internally to `flowguard_status`.

### /hydrate

Bootstrap or reload the FlowGuard session. Idempotent — safe to call repeatedly.

**Creates:**

- Session state in workspace registry
- Discovery results (repository metadata, stack, topology)
- Profile resolution

**Arguments:** `policyMode` (optional): `solo`, `team`, `team-ci`, or `regulated`.
When omitted, reads `config.json` → `policy.defaultMode`, then falls back to `solo`.

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

Generate an implementation plan with self-review loop.

1. LLM generates plan text
2. Self-review loop starts
3. Plan refined until convergence
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

**Verdicts:**

- `approve` → advance to next phase
- `changes_requested` → return to previous phase for revision
- `reject` → restart (TICKET for ticket flow, READY for architecture flow)

**Four-eyes:** In regulated mode, `approve` requires reviewer identity different from session initiator, and both identities must be known.

Every successful `/review-decision` emits a decision receipt in the audit trail (`decision:DEC-xxx`).

### /validate

Run validation checks against the approved plan.

**Allowed in:** VALIDATION
**Checks:** Defined by active profile
**ALL_PASSED** → advance to IMPLEMENTATION

### /implement

Execute the implementation plan.

1. LLM implements using OpenCode tools
2. Changed files recorded via git
3. Implementation review loop
4. Advances to EVIDENCE_REVIEW

**Allowed in:** IMPLEMENTATION

### /architecture

Create or revise an Architecture Decision Record (ADR).

Two modes:

- **Mode A (submit ADR):** Provide `title`, `adrText`. ADR ID is auto-generated (`ADR-001`, `ADR-002`, ...). Records ADR and starts self-review loop.
- **Mode B (self-review):** Provide `selfReviewVerdict`. On convergence, advances to ARCH_REVIEW.

ADR must include `## Context`, `## Decision`, and `## Consequences` sections (MADR format).

**Allowed in:** READY (starts flow), ARCHITECTURE (revise after changes_requested)

### /review

Start the standalone review flow. Generates a compliance report.

**Allowed in:** READY
**Arguments (all optional):**

- `inputOrigin` (optional): Where the review content originated — `pr`, `branch`, `external_reference`, `mixed`, `manual_text`, etc.
- `references` (optional): Array of external references with audit provenance. Same structure as `/ticket` references with types like `pr`, `branch`, `commit`, etc.

**Examples:**

- `/review` — review current workspace (no references)
- `/review https://github.com/org/repo/pull/42` — agent fetches PR, extracts info, stores URL as reference
- `/review feature/my-fix` — review based on branch reference

**Produces:**

- Evidence completeness matrix
- Four-eyes status
- Validation summary
- Findings
- External references (if provided)
- `flowguard-review-report.v1` artifact

### /continue

Universal routing command. Inspects current phase and does the next appropriate action.

- At user gates: returns "waiting" (use /review-decision)
- At PLAN/ARCHITECTURE: runs one self-review iteration
- At IMPL_REVIEW: runs one implementation review iteration
- At VALIDATION: runs all validation checks
- At other phases: evaluates and auto-advances if evidence is present

### /abort

Emergency session termination. Sets phase to COMPLETE with ABORTED marker. Irreversible.

## Operational Tools

These tools operate on session artifacts but don't drive workflow.

### flowguard_status (internal)

Read-only status tool used by `/status` and other slash commands to inspect session state.

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
- `archive-manifest.json`
- `decision-receipts.redacted.v1.json` (default)
- `review-report.redacted.json` (when review report exists)

Default export policy is redacted-only (`archive.redaction.mode=basic`, `includeRaw=false`).
If `includeRaw=true`, raw artifacts are included and manifest risk flag `raw_export_enabled` is set.

External references recorded via `/ticket` are part of authoritative runtime state and remain raw in `session-state.json` (not redacted). References in `review-report.*.json` are redacted in redacted export artifacts.

**Verification:** `verifyArchive()` validates integrity (11 finding codes, including audit chain verification).

**Regulated mode:** In regulated mode, clean completion (`EVIDENCE_REVIEW → APPROVE → COMPLETE`) triggers
synchronous archive creation + verification. The `archiveStatus` field on session state tracks the lifecycle
(`pending` → `created` → `verified` or `failed`). Checksum sidecar failure is fatal in regulated mode.

**Note:** This is an operational export action. The original session is preserved.
