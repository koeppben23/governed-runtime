# Development Guide

This guide is the contributor entry point. It routes to the developer
authorities; it does not define workflow, architecture, or verification rules
itself.

## First 30 minutes

1. Clone the repository.
2. Use the pinned Node version from `.node-version`.
3. Install exactly from the lockfile: `npm ci`.
4. Type-check: `npm run check`.
5. Run the default suite: `npm test`.
6. Read the [Developer Architecture Map](./architecture-map.md).
7. Work through [Your First Change](./first-change.md).

Local setup details, debugging, and dogfooding live in
[Development and Debugging](./debugging.md) — this page intentionally does not
duplicate them.

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

## Develop And Debug

- [Development and Debugging](./debugging.md) is the canonical local setup,
  debugging, dogfood-installation, and isolated-playground guide.
- [Following a State-Changing Operation](./state-changing-operation.md) traces
  persisted workflow behavior and its evidence.

## Contribution Workflow

[CONTRIBUTING.md](../../CONTRIBUTING.md) owns branch naming, pull-request,
release, and contributor verification guidance. Repository-local requirements
remain in [AGENTS.md](../../AGENTS.md).
