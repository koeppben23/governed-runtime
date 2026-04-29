# Quick Start

Get FlowGuard up and running in 5 minutes.

## Prerequisites

- Node.js 20+
- OpenCode

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

The LLM generates a detailed plan. When the plan is ready for review, a **Plan Review Card** is displayed with the full plan and recommended next actions.

### 3. Approve the Plan

```
/approve
```

To request changes: `/request-changes`. To reject: `/reject`.

### 4. Validate (Check)

```
/check
```

### 5. Implement

```
/implement
```

### 6. Final Review

```
/approve
```

### 7. Export the Audit Package

```
/export
```

Creates a verifiable audit package with integrity verification.

All canonical commands (`/hydrate`, `/ticket`, `/review-decision`, `/validate`, `/archive`) remain fully supported for scripts, CI, and advanced workflows.

## Architecture Flow (ADR Creation)

Create an Architecture Decision Record:

```
/architecture
```

The LLM generates the ADR with `## Context`, `## Decision`, and `## Consequences` sections (MADR format). After self-review, approve:

```
/review-decision approve
```

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

| Command                              | Description                          |
| ------------------------------------ | ------------------------------------ |
| `/hydrate`                           | Bootstrap session → READY            |
| `/ticket <text or URL>`              | Record task (supports external URLs) |
| `/plan`                              | Generate plan                        |
| `/architecture`                      | Create/revise ADR                    |
| `/review <PR-URL or branch>`         | Start compliance review flow         |
| `/continue`                          | Auto-advance                         |
| `/review-decision approve`           | Approve                              |
| `/review-decision changes_requested` | Request changes                      |
| `/abort`                             | Terminate session                    |
