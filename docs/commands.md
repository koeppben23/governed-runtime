# Commands

FlowGuard distinguishes between **Workflow Commands** (drive session state) and **Operational Tools** (operate on session artifacts).

## Command Surface

FlowGuard uses a two-level command surface:

| Level | Syntax | Example | Purpose |
|-------|--------|---------|---------|
| **User-facing** | `/command` | `/hydrate`, `/ticket` | OpenCode chat commands |
| **Internal** | `flowguard_command` | `flowguard_hydrate`, `flowguard_ticket` | OpenCode tool bindings |

The `/command` syntax invokes the corresponding `flowguard_command` tool internally.

## Flows

After `/hydrate`, the session starts in the **READY** phase. Three standalone flows are available:

| Flow | Command | Phases | Purpose |
|------|---------|--------|---------|
| **Ticket** | `/ticket` | READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE | Full development lifecycle |
| **Architecture** | `/architecture` | READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE | Create an Architecture Decision Record (ADR) |
| **Review** | `/review` | READY → REVIEW → REVIEW_COMPLETE | Generate a compliance review report |

## Workflow Commands

These commands drive the session through the workflow phases.

### /hydrate

Bootstrap or reload the FlowGuard session. Idempotent — safe to call repeatedly.

**Creates:**
- Session state in workspace registry
- Discovery results (repository metadata, stack, topology)
- Profile resolution

**Arguments:** `policyMode` (optional): `solo`, `team`, `team-ci`, or `regulated`

`team-ci` semantics:
- In CI context: effective mode = `team-ci` (auto-approve at user gates)
- Without CI context: degrades to `team` (human-gated), reason `ci_context_missing`
**Starts at:** READY

### /ticket

Record the task description. Starts the ticket flow from READY or updates ticket in TICKET phase.

**Allowed in:** READY, TICKET
**Arguments:** Task description text (required)

### /plan

Generate an implementation plan with self-review loop.

1. LLM generates plan text
2. Self-review loop starts
3. Plan refined until convergence
4. Advances to PLAN_REVIEW

**Allowed in:** READY, TICKET, PLAN

### /review-decision

Record a human verdict at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW).

**Verdicts:**
- `approve` → advance to next phase
- `changes_requested` → return to previous phase for revision
- `reject` → restart (TICKET for ticket flow, READY for architecture flow)

**Four-eyes:** In regulated mode, reviewer must differ from session initiator.

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
**Produces:**
- Evidence completeness matrix
- Four-eyes status
- Validation summary
- Findings
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

### /archive

Archive a completed session as a `.tar.gz` file with integrity verification.

**Phase:** COMPLETE
**Creates:**
- `{workspace}/sessions/archive/{sessionId}.tar.gz`
- `{sessionId}.tar.gz.sha256`
- `archive-manifest.json`
- `decision-receipts.v1.json` (derived from append-only audit trail)

**Verification:** `verifyArchive()` validates integrity (10 finding codes).

**Note:** This is an operational export action. The original session is preserved.
