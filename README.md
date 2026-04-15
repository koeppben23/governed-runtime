# FlowGuard for OpenCode

Deterministic, fail-closed workflow engine for AI-assisted software delivery.

> **Version:** v1.3.0 | TypeScript | OpenCode-native

---

## Quick Start

### 1. Install

```bash
# Install the FlowGuard package
npm install -g @flowguard/core

# Set up OpenCode integration (creates tools, plugins, and commands)
npx @flowguard/core install
```

The installer writes:
- Thin wrappers to `~/.config/opencode/tools/` (or `.opencode/` for repo scope)
- FlowGuard mandates to the OpenCode config directory
- Command documentation for OpenCode

**Options:**
- `--install-scope global` (default): `~/.config/opencode/` — works across all projects
- `--install-scope repo`: `.opencode/` — committed to repository
- `--policy-mode solo|team|regulated`: Set default policy mode

### 2. Verify Installation

```bash
npx @flowguard/core doctor
```

### 3. Start Session

```
/hydrate
```

### 4. Follow the Workflow

```
/ticket <describe the task>
/plan
/review-decision approve
/validate
/implement
/review-decision approve
```

---

## Features

| Feature | Description |
|---------|-------------|
| **8 Phases** | TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → COMPLETE |
| **Evidence Gates** | Every phase produces verifiable artifacts |
| **Policy Modes** | Solo (auto), Team (optional review), Regulated (mandatory review) |
| **Profiles** | Auto-detect tech stack (TypeScript, Java, Angular) |
| **Audit Trail** | Hash-chained, tamper-evident |
| **Archive** | Session archival with integrity verification |

---

## Documentation

| Document | Description |
|----------|-------------|
| [Installation](./docs/installation.md) | Install and configure FlowGuard |
| [Commands](./docs/commands.md) | Command reference |
| [Phases](./docs/phases.md) | Workflow phases and gates |
| [Policies](./docs/policies.md) | Solo, Team, Regulated modes |
| [Profiles](./docs/profiles.md) | Tech stack profiles |
| [Archive](./docs/archive.md) | Session archiving |
| [Configuration](./docs/configuration.md) | Configuration reference |
| [Troubleshooting](./docs/troubleshooting.md) | FAQ and error handling |

---

## Product Documentation

| Document | Audience |
|----------|----------|
| [PRODUCT_IDENTITY.md](./PRODUCT_IDENTITY.md) | Customer-facing product overview |
| [AGENTS.md](./AGENTS.md) | AI development guidelines |

---

## Development

```bash
# Install dependencies
npm install

# Type check
npm run check

# Run tests (906 tests)
npm test

# Build
npm run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

---

## Architecture Principles

1. **Fail-closed** — ambiguity blocks, never guesses
2. **Deterministic** — same state + input = same result
3. **Pure machine** — no side effects in transition logic
4. **Evidence-first** — every phase produces verifiable artifacts
5. **LLM-agnostic** — works with any model
6. **Zero-bridge** — same process, no subprocess shell-out
7. **Immutable audit** — hash-chained, append-only, tamper-evident
8. **Policy-bound** — every decision traced to a policy version
