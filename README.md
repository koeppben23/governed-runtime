# FlowGuard for OpenCode

Deterministic, fail-closed workflow engine for AI-assisted software delivery.

> **Version:** v1.3.0 | TypeScript | OpenCode-native

---

## Installation

FlowGuard is distributed as a pre-built proprietary release artifact via GitHub Releases.

1. Download `flowguard-core-{version}.tgz` from the [Releases page](https://github.com/koeppben23/governed-runtime/releases)
2. Install: `npm install -g ./flowguard-core-{version}.tgz`
3. Initialize: `flowguard install --core-tarball /path/to/flowguard-core-{version}.tgz`

See [docs/installation.md](./docs/installation.md) for full instructions.

## Get Started

```bash
/hydrate
```

After hydration, choose one of three flows:

### Ticket Flow (Full Development Lifecycle)

```
/ticket <describe the task>
/plan
/review-decision approve
/validate
/implement
/review-decision approve
```

### Architecture Flow (ADR Creation)

```
/architecture <id, title, adrText>
/review-decision approve
```

### Review Flow (Compliance Report)

```
/review
```

---

## Features

| Feature | Description |
|---------|-------------|
| **3 Flows** | Ticket (full dev lifecycle), Architecture (ADR), Review (compliance report) |
| **14 Phases** | READY entry point with three independent flow paths |
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

| Document | Audience | Notes |
|----------|----------|-------|
| [PRODUCT_IDENTITY.md](./PRODUCT_IDENTITY.md) | Product overview | Architecture, capabilities, limitations |
| [AGENTS.md](./AGENTS.md) | Development repo | FlowGuard mandates used by this repo's AI assistants. End users receive `flowguard-mandates.md` via the installer instead. |

---

## Development

```bash
# Install dependencies
npm install

# Type check
npm run check

# Run tests
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
