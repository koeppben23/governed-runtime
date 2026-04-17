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
/hydrate
```

After hydration, FlowGuard enters the **READY** phase. Choose one of three flows.

## Ticket Flow (Full Development Lifecycle)

### 1. Record the Task

```
/ticket Fix the authentication bug in the login flow
```

### 2. Generate a Plan

```
/plan
```

### 3. Get Approval

```
/review-decision approve
```

### 4. Validate

```
/validate
```

### 5. Implement

```
/implement
```

### 6. Final Review

```
/review-decision approve
```

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

## Next Steps

- [Learn about Phases](./phases.md)
- [Understand Policies](./policies.md)
- [Configure FlowGuard](./configuration.md)

## Common Commands

| Command                              | Description                    |
| ------------------------------------ | ------------------------------ |
| `/hydrate`                           | Bootstrap session → READY      |
| `/ticket <text>`                     | Record task, start ticket flow |
| `/plan`                              | Generate plan                  |
| `/architecture`                      | Create/revise ADR              |
| `/review`                            | Start compliance review flow   |
| `/continue`                          | Auto-advance                   |
| `/review-decision approve`           | Approve                        |
| `/review-decision changes_requested` | Request changes                |
| `/abort`                             | Terminate session              |
