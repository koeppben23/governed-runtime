# FlowGuard for OpenCode

Deterministic, fail-closed workflow engine for AI-assisted software delivery.

> **Version:** 1.1.0 | TypeScript | OpenCode-native

---

## Installation

FlowGuard is distributed as a pre-built proprietary release artifact via GitHub Releases.
Release publication is tag-driven (`v*`): if no release tag has been published yet, the Releases page can be empty for that snapshot.

1. Download `flowguard-core-{version}.tgz` from the [Releases page](https://github.com/koeppben23/governed-runtime/releases)
2. Install: `npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball ./flowguard-core-{version}.tgz`
3. Install dependencies: `cd ~/.config/opencode && npm install`
4. Verify: `npx --package ./flowguard-core-{version}.tgz flowguard doctor`

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
/architecture <title, adrText>
/review-decision approve
```

### Review Flow (Compliance Report)

```
/review
```

### Flow Overview

```
                         ┌──────────┐
                         │ /hydrate │
                         └────┬─────┘
                              │
                         ┌────▼────┐
                         │  READY  │
                         └┬───┬───┬┘
              ┌───────────┘   │   └───────────┐
         /ticket         /architecture     /review
              │               │               │
              ▼               ▼               ▼
         ┌────────┐    ┌─────────────┐   ┌────────┐
         │ TICKET │    │ARCHITECTURE │   │ REVIEW │
         └───┬────┘    └──────┬──────┘   └───┬────┘
             ▼          self- ▼ review        ▼
         ┌────────┐    ┌─────────────┐   ┌────────────────┐
         │  PLAN  │◄┐  │ ARCH_REVIEW │   │REVIEW_COMPLETE │ ■
         └───┬────┘ │  └──┬──┬──┬────┘   └────────────────┘
   self-     ▼      │     │  │  └──► READY (reject)
   review┌──────────┤  ◄──┘  └──► ARCHITECTURE
    loop │PLAN_     │  approve     (changes_requested)
         │REVIEW    │     ▼
         └┬──┬──┬───┘  ┌───────────────┐
          │  │  └──► TICKET (reject)
          │  │      │  │ ARCH_COMPLETE  │ ■
   approve│  └──► PLAN └───────────────┘
          ▼  (changes_requested)
     ┌────────────┐
     │ VALIDATION │
     └──┬─────┬───┘
        │     └──► PLAN (CHECK_FAILED)
        ▼
  ┌────────────────┐
  │IMPLEMENTATION  │
  └───────┬────────┘
          ▼
  ┌────────────────┐
  │  IMPL_REVIEW   │ ◄── self-review loop
  └───────┬────────┘
          ▼
  ┌────────────────┐
  │EVIDENCE_REVIEW │
  └─┬─────┬────┬───┘
    │     │    └──► TICKET (reject)
    │     └──► IMPLEMENTATION (changes_requested)
    ▼
 ┌──────────┐
 │ COMPLETE │ ■
 └──────────┘

■ = Terminal   ◄ = Backward transition   ► = Reject/revise path
```

See [docs/phases.md](./docs/phases.md) for full phase details.

---

## Features

| Feature | Description |
|---------|-------------|
| **3 Flows** | Ticket (full dev lifecycle), Architecture (ADR), Review (compliance report) |
| **14 Phases** | READY entry point with three independent flow paths |
| **Evidence Gates** | Every phase produces verifiable artifacts |
| **Verification Planner** | `flowguard_status.verificationCandidates` provides repo-native, evidence-backed verification command candidates (advisory only) |
| **Verification Output Contract** | `/plan` requires Source citation; `/implement` distinguishes Planned vs Executed; `/review` flags generic command usage as defect |
| **Module-Scoped Detection** | Monorepo nested manifests surface as `detectedStack.scopes` without globalizing root facts |
| **Knowledge Pack Policy (ADR)** | External documentation authority is defined in `docs/adr/ADR-0001-knowledge-packs-and-external-docs.md` as advisory-only, provenance-stamped, and non-SSOT |
| **Central Policy Authority (P29)** | Optional central minimum policy via `FLOWGUARD_POLICY_PATH`; explicit weaker mode is blocked, repo/default weaker mode is elevated with auditable resolution evidence |

---

## CLI Commands

FlowGuard provides these CLI commands:

```bash
# Installation (stable)
npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball ./flowguard-core-{version}.tgz
npx --package ./flowguard-core-{version}.tgz flowguard uninstall
npx --package ./flowguard-core-{version}.tgz flowguard doctor

# Headless operation (EXPERIMENTAL)
flowguard run -- "Run /hydrate"
flowguard serve --detach --port 4096
```

**Note:** Headless features are experimental. For production, use OpenCode directly:
`opencode run` and `opencode serve`. See [docs/installation.md](./docs/installation.md).
| **Policy Modes** | Solo (auto), Team (human-gated), Team-CI (CI auto, local degrade), Regulated (mandatory review) |
| **Profiles** | Auto-detect tech stack (TypeScript, Java, Angular) |
| **Python/Rust/Go Detection** | Detects root-level Python, Rust, and Go ecosystem signals from manifest/toolchain files |
| **Database Detection** | Detects repo database engines (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, H2, SQLite, Oracle, SQL Server) from manifest evidence |
| **Audit Trail** | Hash-chained, tamper-evident |
| **Decision Receipts** | Append-only `decision:DEC-xxx` events for every `/review-decision` |
| **Derived Evidence Artifacts** | Append-only `artifacts/ticket.v*.{md,json}` and `artifacts/plan.v*.{md,json}` with content-digest versioning and `sourceStateHash` provenance |
| **Archive** | Session archival with integrity verification + redacted export artifacts by default |
| **Code Surface Analysis** | Bounded heuristic detection of endpoints/auth/data/integration surfaces |

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
| [Enterprise Readiness](./docs/enterprise-readiness.md) | Consolidated threat model and control boundaries |
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

# Lint
npm run lint

# Run tests
npm test

# Run coverage gate (global thresholds enforced)
npm run test:coverage

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
