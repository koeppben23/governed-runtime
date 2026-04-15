# Commands

FlowGuard distinguishes between **Workflow Commands** (drive session state) and **Operational Tools** (operate on session artifacts).

## Workflow Commands

These commands drive the session through the workflow phases.

### /hydrate

Bootstrap or reload the FlowGuard session. Idempotent — safe to call repeatedly.

**Creates:**
- Session state in workspace registry
- Discovery results (repository metadata, stack, topology)
- Profile resolution

**Arguments:** `policyMode` (optional): `solo`, `team`, or `regulated`

### /ticket

Record the task description. Required before planning.

**Phase:** TICKET
**Arguments:** Task description text (required)
**Advances to:** PLAN

### /plan

Generate an implementation plan with self-review loop.

1. LLM generates plan text
2. Self-review loop starts
3. Plan refined until convergence
4. Advances to PLAN_REVIEW

### /review-decision

Record a human verdict at a User Gate.

**Verdicts:**
- `approve` → advance to next phase
- `changes_requested` → return to previous phase
- `reject` → restart from TICKET

**Four-eyes:** In regulated mode, reviewer must differ from session initiator.

### /validate

Run validation checks against the approved plan.

**Phase:** VALIDATION
**Checks:** Defined by active profile
**ALL_PASSED** → advance to IMPLEMENTATION

### /implement

Execute the implementation plan.

1. LLM implements using OpenCode tools
2. Changed files recorded
3. Self-review loop
4. Advances to EVIDENCE_REVIEW

### /continue

Universal routing command. Inspects current phase and does the next appropriate action.

### /review

Generate a standalone compliance report. Read-only.

**Includes:**
- Evidence completeness matrix
- Four-eyes status
- Validation summary
- Findings

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

**Verification:** `verifyArchive()` validates integrity (10 finding codes).

**Note:** This is an operational export action. The original session is preserved.
