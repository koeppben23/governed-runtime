# FlowGuard for OpenCode

Deterministic, fail-closed workflow engine for AI-assisted software delivery.

> **Version:** 1.2.0-rc.1 | TypeScript | OpenCode-native

---

## Installation

FlowGuard is distributed as a pre-built proprietary release artifact via GitHub Releases.
Release publication is tag-driven (`v*`): if no release tag has been published yet, the Releases page can be empty for that snapshot.

1. Download `flowguard-core-{version}.tgz` from the [Releases page](https://github.com/koeppben23/governed-runtime/releases)
2. Install: `npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball ./flowguard-core-{version}.tgz`
3. Install dependencies: `cd ~/.config/opencode && npm install`
4. Verify: `npx --package ./flowguard-core-{version}.tgz flowguard doctor`

See [docs/installation.md](./docs/installation.md) for full instructions.

In headless/non-interactive execution, FlowGuard does not rely on follow-up questions: missing safety-critical inputs fail closed with explicit blocked reasons.

> [!NOTE]
> **Headless operation is separate from the interactive plugin:**
> The interactive plugin (`flowguard_*` tools inside OpenCode) is stable.
> The standalone CLI wrappers (`flowguard run`, `flowguard serve`) are experimental.
> For production headless workflows, use OpenCode directly (`opencode run`, `opencode serve`).

## In 30 Seconds

Start a FlowGuard workflow from any OpenCode session after install:

1. `/hydrate` — bootstrap the session (creates the READY phase with policy binding)
2. `/ticket <description>` — record your task
3. `/plan` — generate an implementation plan
4. `/implement` — execute the plan

See [docs/commands.md](./docs/commands.md) for the complete command reference.

## Product Facts

| Feature                           | Description                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Policy Modes**                  | Solo (auto), Team (human-gated), Team-CI (CI auto, local degrade), Regulated (mandatory review)                                                                                |
| **Profiles**                      | Auto-detect tech stack (TypeScript, Java, Angular)                                                                                                                             |
| **Python/Rust/Go Detection**      | Detects root-level Python, Rust, and Go ecosystem signals from manifest/toolchain files                                                                                        |
| **Database Detection**            | Detects repo database engines (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, H2, SQLite, Oracle, SQL Server) from manifest evidence                                              |
| **Audit Trail**                   | Hash-chained, tamper-evident                                                                                                                                                   |
| **Decision Receipts**             | Append-only `decision:DEC-xxx` events for every `/review-decision`                                                                                                             |
| **Derived Evidence Artifacts**    | Append-only `artifacts/ticket.v*.{md,json}` and `artifacts/plan.v*.{md,json}` with content-digest versioning and `sourceStateHash` provenance                                  |
| **Archive**                       | Session archival with integrity verification + redacted export artifacts by default                                                                                            |
| **Code Surface Analysis**         | Bounded heuristic detection of endpoints/auth/data/integration surfaces                                                                                                        |
| **Headless Fail-Closed Behavior** | Non-interactive execution (`flowguard run`, `flowguard serve`, OpenCode automation) returns explicit `BLOCKED` outcomes for missing safety-critical input rather than guessing |

---

## Documentation

| Document                                               | Description                                      |
| ------------------------------------------------------ | ------------------------------------------------ |
| [Installation](./docs/installation.md)                 | Install and configure FlowGuard                  |
| [Commands](./docs/commands.md)                         | Command reference                                |
| [Phases](./docs/phases.md)                             | Workflow phases and gates                        |
| [Policies](./docs/policies.md)                         | Solo, Team, Regulated modes                      |
| [Profiles](./docs/profiles.md)                         | Tech stack profiles                              |
| [Archive](./docs/archive.md)                           | Session archiving                                |
| [Enterprise Readiness](./docs/enterprise-readiness.md) | Consolidated threat model and control boundaries |
| [Configuration](./docs/configuration.md)               | Configuration reference                          |
| [Troubleshooting](./docs/troubleshooting.md)           | FAQ and error handling                           |
| [Testing Strategy](./docs/testing-strategy.md)         | Test tiers, CI jobs, performance budgets         |

---

## Product Documentation

| Document                                     | Audience         | Notes                                                                                                                      |
| -------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [PRODUCT_IDENTITY.md](./PRODUCT_IDENTITY.md) | Product overview | Architecture, capabilities, limitations                                                                                    |
| [AGENTS.md](./AGENTS.md)                     | Development repo | FlowGuard mandates used by this repo's AI assistants. End users receive `flowguard-mandates.md` via the installer instead. |

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

### CI Jobs

| Job                | Script                                         | What It Proves                            |
| ------------------ | ---------------------------------------------- | ----------------------------------------- |
| **unit**           | `npm run test:unit`                            | Pure logic correctness                    |
| **integration**    | `npm run test:integration`                     | Governance chain fidelity                 |
| **smoke**          | `npm run build && npm run test:smoke`          | Built CLI starts, ACP works               |
| **install-verify** | `npm run build && npm run test:install-verify` | Tarball install + doctor (cross-platform) |

See [docs/testing-strategy.md](./docs/testing-strategy.md) for the full test tier system.

### Release Checklist

1. `npm run check` — type check clean
2. `npm run lint` — no lint errors
3. `npm test` — all tests pass (pre-existing PERF flakes acceptable)
4. `npm run build` — build succeeds
5. `npm run check:esm` — ESM imports valid
6. `npm run test:install-verify` — tarball pack/install/doctor passes
7. `npm version <patch|minor|major>` — bumps version, syncs VERSION/docs
8. `git push --follow-tags` — triggers release workflow
9. Verify GitHub Release artifact and SBOM attachment

The `release.yml` workflow handles: build, pack, naming validation, install-verify on
tarball, SHA-256 checksums, CycloneDX SBOM generation, build provenance attestation,
and GitHub Release creation with `--verify-tag`.

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
