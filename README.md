# FlowGuard for OpenCode

Deterministic, fail-closed workflow engine for AI-assisted software delivery.

> **Version:** 1.2.0-rc.2 | TypeScript | OpenCode-native

---

## Installation

FlowGuard is distributed as a pre-built proprietary release artifact via GitHub Releases.
Release publication is tag-driven (`v*`): if no release tag has been published yet, the Releases page can be empty for that snapshot.

1. Download `flowguard-core-{version}.tgz` from the [Releases page](https://github.com/koeppben23/governed-runtime/releases)
2. Install: `npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball ./flowguard-core-{version}.tgz`
3. Restart OpenCode (plugins are loaded once at startup)
4. Verify: `npx --package ./flowguard-core-{version}.tgz flowguard doctor`

See [docs/installation.md](./docs/installation.md) for full instructions.

In headless/non-interactive execution, FlowGuard does not rely on follow-up questions: missing safety-critical inputs fail closed with explicit blocked reasons.

> [!NOTE] > **Headless operation is separate from the interactive plugin:**
> The interactive plugin (`flowguard_*` tools inside OpenCode) is stable.
> The standalone CLI wrappers (`flowguard run`, `flowguard serve`) are experimental.
> For production headless workflows, use OpenCode directly (`opencode run`, `opencode serve`).

## In 30 Seconds

Three governed flows are available after `/start` (or `/hydrate`):

**Ticket flow** — full development lifecycle:

1. `/start` — bootstrap the session
2. `/task "description"` — capture your governed task
3. `/plan` — generate an implementation plan (subagent-reviewed iteratively)
4. `/approve` — approve the plan (or `/request-changes` to revise)
5. `/check` — run validation checks
6. `/implement` — execute the approved plan (subagent-reviewed iteratively)
7. `/approve` — approve the implementation evidence
8. `/export` — create a verifiable audit package

**Architecture flow** — record an Architecture Decision Record (ADR):

1. `/start`
2. `/architecture title="..." adrText="..."` — record the ADR (MADR format,
   subagent-reviewed iteratively for Context completeness, Decision concreteness,
   Consequences honesty, MADR structure)
3. `/approve` — accept the ADR

**Compliance / Content review flow** — review session compliance or external content:

1. `/start`
2. `/review` — plain compliance report (no external content)
   OR `/review prNumber=42` / `branch=feature` / `url=https://...` /
   `text="diff"` → blocked with `requiredReviewAttestation` (obligation UUID)
3. When plugin orchestration is active, FlowGuard may invoke the reviewer
   subagent and inject `pluginReviewFindings`; otherwise the blocked response
   instructs manual subagent invocation.
4. `/review prNumber=42 analysisFindings=<complete object>` →
   REVIEW_COMPLETE, receives structured `reviewCard`

**Diagnostic commands:** `/status` — current phase, next action, evidence summary.
`/why` — explain and resolve blockers.

**Advanced/canonical commands** (`/hydrate`, `/ticket`, `/review-decision`,
`/validate`, `/architecture`, `/review`, `/archive`, `/abort`, `/continue`)
remain fully supported for scripts, CI, and power users.

See [docs/commands.md](./docs/commands.md) for the complete command reference and
[docs/independent-review.md](./docs/independent-review.md) for review obligations,
subagent attestation, and the `/review` evidence model.

## Product Facts

| Feature                           | Description                                                                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Policy Modes**                  | Solo (auto), Team (human-gated), Team-CI (CI auto, local degrade), Regulated (mandatory review)                                                                                                                                                                  |
| **Independent Subagent Review**   | Mandatory plugin-orchestrated `flowguard-reviewer` subagent for `/plan`, `/architecture`, `/implement`. Fail-closed at four enforcement layers (subagent invoked, session ID match, prompt context, findings integrity). Self-review never accepted as evidence. |
| **Profiles**                      | Auto-detect tech stack (TypeScript, Java, Angular)                                                                                                                                                                                                               |
| **Python/Rust/Go Detection**      | Detects root-level Python, Rust, and Go ecosystem signals from manifest/toolchain files                                                                                                                                                                          |
| **Database Detection**            | Detects repo database engines (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, H2, SQLite, Oracle, SQL Server) from manifest evidence                                                                                                                                |
| **Audit Trail**                   | Hash-chained, tamper-evident                                                                                                                                                                                                                                     |
| **Decision Receipts**             | Append-only `decision:DEC-xxx` events for every `/review-decision`                                                                                                                                                                                               |
| **Review Cards**                  | Structured markdown cards (Plan Review Card, Architecture Review Card, Review Report Card) injected at review gates. Derived presentation artifacts — `session-state.json` remains SSOT                                                                          |
| **Content-Aware /review**         | Single `/review` call supports text, PR number, branch name, or URL input with subagent-attested content analysis                                                                                                                                                |
| **Derived Evidence Artifacts**    | Append-only `artifacts/ticket.v*.{md,json}` and `artifacts/plan.v*.{md,json}` with content-digest versioning and `sourceStateHash` provenance                                                                                                                    |
| **Archive**                       | Session archival with integrity verification + redacted export artifacts by default                                                                                                                                                                              |
| **Code Surface Analysis**         | Bounded heuristic detection of endpoints/auth/data/integration surfaces                                                                                                                                                                                          |
| **Headless Fail-Closed Behavior** | Non-interactive execution (`flowguard run`, `flowguard serve`, OpenCode automation) returns explicit `BLOCKED` outcomes for missing safety-critical input rather than guessing                                                                                   |

---

## Documentation

| Document                                                        | Description                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Installation](./docs/installation.md)                          | Install and configure FlowGuard                                        |
| [Commands](./docs/commands.md)                                  | Command reference                                                      |
| [Phases](./docs/phases.md)                                      | Workflow phases and gates                                              |
| [Policies](./docs/policies.md)                                  | Solo, Team, Team-CI, Regulated modes                                   |
| [Independent Review](./docs/independent-review.md)              | Review obligations, subagent attestation, and `/review` evidence model |
| [Profiles](./docs/profiles.md)                                  | Tech stack profiles                                                    |
| [Archive](./docs/archive.md)                                    | Session archiving                                                      |
| [Enterprise Readiness](./docs/enterprise-readiness.md)          | Consolidated threat model and control boundaries                       |
| [Configuration](./docs/configuration.md)                        | Configuration reference                                                |
| [Troubleshooting](./docs/troubleshooting.md)                    | FAQ and error handling                                                 |
| [Testing Strategy](./docs/testing-strategy.md)                  | Test tiers, CI jobs, performance budgets                               |
| [API Reference](https://koeppben23.github.io/governed-runtime/) | TypeScript API reference (TypeDoc, GitHub Pages)                       |

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

| Job                 | Script                                         | What It Proves                                         |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| **unit**            | `npm run test:unit`                            | Pure logic correctness                                 |
| **integration**     | `npm run test:integration`                     | Governance chain fidelity                              |
| **smoke**           | `npm run build && npm run test:smoke`          | Built CLI starts, ACP works                            |
| **install-verify**  | `npm run build && npm run test:install-verify` | Tarball install + doctor (cross-platform)              |
| **mutation**        | `npm run mutation`                             | StrykerJS mutation testing for security-critical paths |
| **actions-pinning** | `npm run check:actions-pinned`                 | GitHub Actions are pinned to immutable refs            |

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
