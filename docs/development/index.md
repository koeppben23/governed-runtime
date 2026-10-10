# Development Guide

This guide and [Your First Change](./first-change.md) are the only required
reading for a first contribution. Everything else on this page is reference.

## First 15 minutes

1. Clone the repository.
2. Use the pinned Node version from `.node-version`.
3. Install exactly from the lockfile: `npm ci`.
4. Type-check and run the default suite once: `npm run check && npm test`.
5. Work through [Your First Change](./first-change.md) — owning file, test,
   placement rule, checks, and the pull-request workflow for one small additive
   change.

The repository-wide `AGENTS.md` rules (root and nested) remain binding
regardless of this short path; see [AGENTS.md](../../AGENTS.md#verification).

## Reference (not required for a first contribution)

| Document                                                              | Owns                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Developer Architecture Map](./architecture-map.md)                   | Change-type checklists, exact authorities, placement/zone/mutation procedure |
| [Development and Debugging](./debugging.md)                           | Local setup, debugging, dogfood installation, isolated playgrounds           |
| [Following a State-Changing Operation](./state-changing-operation.md) | Persisted workflow tracing and evidence                                      |
| [Testing Strategy](../testing-strategy.md)                            | Test layers and the executable verification surface                          |
| [CONTRIBUTING.md](../../CONTRIBUTING.md)                              | Branch naming, PR process, commit and verification contracts                 |

## Repository map

| Area                          | Meaning                                 |
| ----------------------------- | --------------------------------------- |
| `src/state/`                  | persisted domain and evidence contracts |
| `src/machine/`                | transitions and guards                  |
| `src/rails/`                  | workflow orchestration                  |
| `src/adapters/`               | I/O, persistence, Git, archive boundary |
| `src/integration/`            | host, tool, and review composition      |
| `src/audit/`                  | audit event and integrity semantics     |
| `src/presentation/`           | derived human presentation              |
| `src/architecture/__tests__/` | executable architecture rules           |
| `src/architecture/support/`   | architecture test-support authorities   |
| `docs/`                       | product and developer documentation     |
| `scripts/`                    | build, verification, release tooling    |

The table is navigation, not a second ownership authority. Canonical
authorities live in
[`AGENTS.md` § Canonical Authorities](../../AGENTS.md#canonical-authorities)
and the executable architecture rules.

## Change routing

First decision:

- Persisted state or evidence contract → `src/state/` plus the state
  persistence checklist.
- Transition or guard → `src/machine/`.
- Host tool or command → `src/integration/tools/`.
- Independent review → `src/integration/review/`.
- Presentation only → `src/presentation/`.
- Git, file, or archive I/O → `src/adapters/`.

Then follow the [Developer Architecture Map](./architecture-map.md), which owns
the change-type checklists and the exact authorities.

## Mental model

Four terms are enough to start:

- **Authority** — the single canonical owner of a contract or decision.
- **Persisted evidence** — bytes written to disk that later decisions bind to.
- **Derived projection** — a display or status view computed from authority,
  never a second source of truth.
- **Trust boundary** — a place where untrusted input is validated or fails
  closed.
