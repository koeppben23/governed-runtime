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

## Follow the Workflow

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

## Next Steps

- [Learn about Phases](./phases.md)
- [Understand Policies](./policies.md)
- [Configure FlowGuard](./configuration.md)

## Common Commands

| Command | Description |
|---------|-------------|
| `/hydrate` | Bootstrap session |
| `/ticket <text>` | Record task |
| `/plan` | Generate plan |
| `/continue` | Auto-advance |
| `/review-decision approve` | Approve |
| `/review-decision changes_requested` | Request changes |
| `/abort` | Terminate session |
