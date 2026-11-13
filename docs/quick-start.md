# Quick Start (OpenCode)

This Quick Start applies to OpenCode, the primary V2 host, on the `develop`
command surface. The V2 port and the native Desktop Workbench (#1207) are
merged; remaining product/accessibility acceptance is tracked in #1196. Desktop
commands and the read-only ComposerPill are documented in the
[Desktop GUI Companion](./desktop.md); GUI evidence remains bound to its
installed bundle hash. The bounded OpenCode 2.2.4 CLI/server parity matrix
remains historical evidence (65/65 on Linux, macOS and Windows); see the
[P0-00 evidence](./host-probes/opencode-v2/p0-00-inactive-parity.md).
R4 is a documented `NOT_SUPPORTED` trusted-plugin limitation: untrusted
co-installed plugins are outside the supported V2 security boundary, and no
receipt claims tool-result-byte attestation. Use this guide for evaluation, not
as a GA release claim.

## Prerequisites

- Node.js 20+
- OpenCode
- `git` (FlowGuard requires running inside a git worktree; missing git BLOCKs
  `/start`)

## Installation

1. Download the latest release from [GitHub Releases](https://github.com/koeppben23/governed-runtime/releases)
2. Follow the [Installation Guide](./installation.md)

## Start a Session

Open OpenCode and start a governed session:

```
/start
```

`/start` is a native plugin command. Run it in the root session (not in a delegated
subagent session); it prepares the workflow and activates governance for that
session only. Until then OpenCode behaves natively. An optional single argument
selects a policy mode, for example `/start team`.

A fresh successful start enters the **READY** phase. Choose one of three flows.
Native `/start` uses the canonical profile precedence: configured default,
repository detection, then baseline fallback (an explicit `/hydrate` profile
selection takes precedence when used). The existing
status card labels the actual selection source; repository discovery alone is
not evidence that a configured profile was auto-detected. The host is instructed
to reproduce this card in full, not replace it with a waiting sentence; visual
delivery still depends on the host/model and needs live verification.
Repeating `/start` in an ACTIVE root reuses its bound workflow; it does not reset
the phase or establish a new implementation baseline. `/hydrate` reloads an
already authorized session and cannot activate governance or repair missing
authority. Terminal workflows remain terminal: new work requires a distinct
host session and explicit activation, with a trustworthy pre-change worktree
when recovering implementation evidence.

A successful `/export` does not commit the implementation changes. If you start
another FlowGuard session on the same worktree, those uncommitted files are
captured as the new session's baseline and cannot become implementation
evidence, even if you clean and re-apply them. Commit or stash them outside the
session before a new `/start`, or use a clean worktree.

Upgrading an existing installation? Follow the
[manual configuration recovery](./configuration.md#breaking-change-manual-configuration-recovery)
for retired keys; `install --force` does not migrate them.

## Ticket Flow (Full Development Lifecycle)

### 1. Record the Task

```
/task Fix the authentication bug in the login flow
```

Or reference an external Jira ticket:

```
/task https://jira.example.com/browse/PROJ-123
```

The agent adopts the ticket content it can read: title, description and — only for an explicitly
named risk field such as `Risk` with a value of `TRIVIAL`, `STANDARD` or `HIGH-RISK` — that class as
its own `Risk:` line. A bare URL or issue ID is never ticket content, unreadable content (or an
unreadable explicit risk field) fails closed, and `Priority`/`Severity`/`Impact` are never
interpreted as risk classes. Comments, attachments and provider state are not part of this contract.

### 2. Generate a Plan

```
/plan
```

The LLM generates a detailed plan. **The plan then enters an iterative
independent-review loop**: the parent follows the returned invocation using the
native `subagent` tool. FlowGuard authorizes the exact pending dispatch, binds
the actual `flowguard-reviewer` child and validates same-child terminal findings
before they can satisfy review. The primary agent reads the findings and either submits an
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

### 4. Validate (Automatic)

FlowGuard runs the baseline validation checks automatically when the plan is
approved and the phase advances. No command is required; `/check` remains
available as a compatibility surface if checks need to be re-run explicitly.

### 5. Implement

```
/implement
```

`/implement` is end-to-end: it records implementation evidence, auto-runs the
post-implementation validation checks (`IMPL_VALIDATION`), and enters the iterative
independent-review loop (parity with `/plan`): the reviewer subagent is invoked
against the recorded code changes; the agent revises and re-records on
`changes_requested`; convergence advances to `EVIDENCE_REVIEW` — ready for
approval.

### 6. Final Review

```
/approve
```

### 7. Export the Audit Package

```
/export
```

Materializes the required verifiable export and completes the workflow once
export evidence is persisted. Canonical verification requires an authorized raw
auditor package.

The workflow commands (`/ticket`, `/review-decision`, `/validate`,
`/architecture`, `/review`, `/export`, `/archive`, `/abort`, `/continue`) remain
supported for scripts, CI, and advanced workflows. `/hydrate` is a legacy
compatibility command; it is **not** a V2 activation path and must not be used
in place of `/start` or an authorized autonomous `StartGovernance` call.

## Architecture Flow (ADR Creation)

Create an Architecture Decision Record. The flow is symmetric to `/plan`: ADR
authoring runs through the same independent-subagent review loop (F13 parity).

```
/architecture title="Use PostgreSQL for primary storage" adrText="## Context
…
## Decision
…
## Consequences
…"
```

The ADR must include `## Context`, `## Decision`, and `## Consequences` sections
(MADR format). After submission, the reviewer subagent evaluates the ADR against
ADR-specific criteria (Context completeness, Decision concreteness, Consequences
honesty, MADR structure). The agent revises and re-submits on
`changes_requested`. On convergence, the workflow advances to `ARCH_REVIEW`,
where the approval authority selected by the frozen policy decides:

```
/approve
```

(`/approve` at `ARCH_REVIEW` accepts the ADR and writes the MADR artifact;
`/request-changes` returns to `ARCHITECTURE` for further revision; `/reject`
returns the session to `READY`.)

## Peer Review Flow

Generate a peer review report from READY:

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

| Command               | Description                                       |
| --------------------- | ------------------------------------------------- |
| `/start`              | Activate governance for this root session → READY |
| `/task <text or URL>` | Record task (supports external URLs)              |
| `/approve`            | Approve at the current review gate                |
| `/request-changes`    | Request changes at the current review gate        |
| `/reject`             | Reject at the current review gate                 |
| `/check`              | Native scoped check/review turn                   |
| `/export`             | Materialize the verifiable export                 |
| `/why`                | Diagnostic: explain the current next-action       |
| `/status`             | Read-only session view                            |

**Canonical commands:**

| Command                              | Description                                            |
| ------------------------------------ | ------------------------------------------------------ |
| `/hydrate`                           | Reload authorized session; not activation or restart   |
| `/ticket <text or URL>`              | Record task (supports external URLs)                   |
| `/plan`                              | Generate plan                                          |
| `/architecture`                      | Create/revise ADR                                      |
| `/implement`                         | Execute approved plan                                  |
| `/validate`                          | Run validation                                         |
| `/review <PR-URL or branch>`         | Start peer review flow                                 |
| `/continue`                          | Read-only next-action routing                          |
| `/review-decision approve`           | Approve                                                |
| `/review-decision changes_requested` | Request changes                                        |
| `/review-decision reject`            | Reject                                                 |
| `/archive`                           | Archive completed session                              |
| `/abort`                             | Terminate session                                      |
| `/reconcile-mutation-episode`        | Resolve an unobservable host mutation episode          |
| `/resolve-implementation-challenge`  | Record evidence addressing an implementation challenge |

**Native operator/diagnostic commands:**

| Command             | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `/check`            | Run the canonical scoped verification/review turn      |
| `/debug-export`     | Write a bounded, redacted diagnostic snapshot          |
| `/diagnostics`      | Read-only Explorer, review, log and notification views |
| `/recover-capacity` | Release a proven terminal reviewer capacity lock       |
| `/end-governance`   | End governance after safe workflow and audit closure   |

The optional TUI companion adds `/choose-workflow`.

**Desktop companion commands:**

| Command               | Description                                                                   |
| --------------------- | ----------------------------------------------------------------------------- |
| `/choose-workflow`    | Shared TUI/Desktop chooser for workflows and review decisions.                |
| `/flowguard-ui-probe` | Open the read-only Desktop Workbench. Experimental; requires `Panel`/`Slot`.  |
| `/flowguard-inline`   | Refresh the read-only composer status. Experimental; requires `ComposerPill`. |

The Desktop-only commands `/flowguard-ui-probe` and `/flowguard-inline` are not
available on TUI, headless or MCP hosts. See
[Desktop GUI Companion](./desktop.md) for the read-only ComposerPill, optional
API degradation and installed evidence scope.
