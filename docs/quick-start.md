# Quick Start

Get FlowGuard up and running in 5 minutes.

## Prerequisites

- Node.js 20+
- OpenCode
- `git` (FlowGuard requires running inside a git worktree; missing git BLOCKs `/hydrate`)

## Installation

1. Download the latest release from [GitHub Releases](https://github.com/koeppben23/governed-runtime/releases)
2. Follow the [Installation Guide](./installation.md)

## Start a Session

Open OpenCode and start a governed session:

```
/start
```

After starting, FlowGuard enters the **READY** phase. Choose one of three flows.

## Ticket Flow (Full Development Lifecycle)

### 1. Record the Task

```
/task Fix the authentication bug in the login flow
```

Or reference an external Jira ticket:

```
/task https://jira.example.com/browse/PROJ-123
```

### 2. Generate a Plan

```
/plan
```

The LLM generates a detailed plan. **The plan then enters an iterative
independent-review loop**: the FlowGuard plugin deterministically invokes the
`flowguard-reviewer` subagent and injects the structured findings back into the
tool response. The primary agent reads the findings and either submits an
`approve` verdict (no further changes), submits a `changes_requested` verdict
with a revised plan (next iteration), or — if the reviewer cannot critique the
plan — receives a BLOCKED `SUBAGENT_UNABLE_TO_REVIEW` and must produce a
substantially-new plan.

The loop converges when the reviewer approves and the plan digest is stable, OR
when the per-mode iteration limit is reached. On convergence, a **Plan Review
Card** is displayed with the full plan, the reviewer findings, and the
recommended next actions.

### 3. Approve the Plan

The Plan Review Card footer lists the available decision commands with short explanations:

- `/approve` — approve the plan if it is complete and acceptable
- `/request-changes` — send the plan back for revision
- `/reject` — stop this task

```
/approve
```

Use `/request-changes` to revise the plan or `/reject` to stop the task.

### 4. Validate (Check)

```
/check
```

### 5. Implement

```
/implement
```

The implementation enters its own iterative independent-review loop (parity with
`/plan`): the reviewer subagent is invoked against the recorded code changes; the
agent revises and re-records on `changes_requested`; convergence advances to
`EVIDENCE_REVIEW`.

### 6. Final Review

```
/approve
```

### 7. Export the Audit Package

```
/export
```

Creates a verifiable audit package with integrity verification.

All canonical commands (`/hydrate`, `/ticket`, `/review-decision`, `/validate`,
`/architecture`, `/review`, `/archive`, `/abort`, `/continue`) remain fully
supported for scripts, CI, and advanced workflows.

## Architecture Flow (ADR Creation)

Create an Architecture Decision Record. The flow is symmetric to `/plan`: ADR
authoring runs through the same independent-subagent review loop (F13 parity).

```
/architecture title="Use PostgreSQL for primary storage" adrText="## Context\n…\n## Decision\n…\n## Consequences\n…"
```

The ADR must include `## Context`, `## Decision`, and `## Consequences` sections
(MADR format). After submission, the reviewer subagent evaluates the ADR against
ADR-specific criteria (Context completeness, Decision concreteness, Consequences
honesty, MADR structure). The agent revises and re-submits on
`changes_requested`. On convergence, the workflow advances to `ARCH_REVIEW`,
where a human approves:

```
/approve
```

(`/approve` at `ARCH_REVIEW` accepts the ADR and writes the MADR artifact;
`/request-changes` returns to `ARCHITECTURE` for further revision; `/reject`
returns the session to `READY`.)

## Review Flow (Compliance Report)

Generate a compliance review report from READY:

```
/review
```

Or review a specific GitHub pull request:

```
/review https://github.com/my-org/my-repo/pull/42
```

## Next Steps

- [Learn about Phases](./phases.md)
- [Understand Policies](./policies.md)
- [Configure FlowGuard](./configuration.md)

## Common Commands

**Product surface (recommended for daily use):**

| Command               | Description                                 |
| --------------------- | ------------------------------------------- |
| `/start`              | Bootstrap session → READY                   |
| `/task <text or URL>` | Record task (supports external URLs)        |
| `/approve`            | Approve at the current review gate          |
| `/request-changes`    | Request changes at the current review gate  |
| `/reject`             | Reject at the current review gate           |
| `/check`              | Run validation                              |
| `/export`             | Archive the session                         |
| `/why`                | Diagnostic: explain the current next-action |
| `/status`             | Read-only session view                      |

**Canonical commands:**

| Command                              | Description                          |
| ------------------------------------ | ------------------------------------ |
| `/hydrate`                           | Bootstrap session → READY            |
| `/ticket <text or URL>`              | Record task (supports external URLs) |
| `/plan`                              | Generate plan                        |
| `/architecture`                      | Create/revise ADR                    |
| `/implement`                         | Execute approved plan                |
| `/validate`                          | Run validation                       |
| `/review <PR-URL or branch>`         | Start compliance review flow         |
| `/continue`                          | Auto-advance                         |
| `/review-decision approve`           | Approve                              |
| `/review-decision changes_requested` | Request changes                      |
| `/review-decision reject`            | Reject                               |
| `/archive`                           | Archive completed session            |
| `/abort`                             | Terminate session                    |
