# Project Governance

This document defines how FlowGuard tickets and pull requests stay execution-ready,
auditable, and aligned with protected `main`.

## Ticket Contract

Every ticket should state:

- Objective
- Scope and non-goals
- Risk class: `TRIVIAL`, `STANDARD`, or `HIGH-RISK`
- Touched surface
- Acceptance criteria
- Verification required
- Documentation required or not required with reason
- `CHANGELOG.md` required or not required with reason

## Clean Code And Clean Architecture

Every ticket MUST adhere to clean code and clean architecture. This is mandatory —
no exceptions.

- **Single Responsibility Principle** — Every module, file, and function MUST
  have exactly one reason to change. No god-files, no god-functions.
- **Layer Isolation** — Code MUST respect FlowGuard's documented layer boundaries
  (`state/` → `machine/` → `rails/` → `adapters/` → `integration/`). No upward
  imports, no layer bypass.
- **Extract, Don't Accumulate** — When a file exceeds 400–500 LOC, MUST split
  along domain boundaries. Do not let files grow unbounded.
- **No Duplicate Authority** — Every concept MUST have exactly one canonical
  implementation. No duplicated logic, no parallel pipelines with identical
  algorithms.
- **Separation Of Content And Logic** — Template content and rendering/assembly
  logic MUST live in separate modules. Content files define what; renderer files
  define how.
- **Infrastructure Isolation** — Concurrency, file I/O, and domain logic MUST
  not be mixed in a single file. Infrastructure concerns (locking, atomic write)
  belong in dedicated modules, not inside domain persistence files.
- **Import Hygiene** — No file should import from more modules than its
  responsibility demands. A god-file symptom is 15+ import statements from 8+
  modules.
- **Testability** — Every extracted module MUST be independently testable.
  Existing test coverage MUST be preserved or migrated, never dropped.

## Definition Of Done

- Clean conventional branch created from current `main`
- Change is scoped to the ticket
- Conventional commit and PR title used
- Tests added or updated where needed
- Negative-path tests added for governance or fail-closed behavior
- Documentation updated or explicitly marked not needed with reason
- `CHANGELOG.md` updated or explicitly marked not needed with reason
- Verification commands recorded in PR
- PR links or closes the issue

## Ready For Work Gate

A ticket is ready only when:

- Objective is clear
- Scope and non-goals are clear
- Risk class is set
- Touched surface is identified
- Acceptance criteria are testable
- Verification expectations are stated
- Documentation expectation is stated
- Changelog expectation is stated

## Recommended Project Fields

| Field                | Values                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `Risk`               | `TRIVIAL`, `STANDARD`, `HIGH-RISK`                                                          |
| `Touched Surface`    | `Docs`, `CLI`, `Policy`, `State`, `Audit`, `Archive`, `Release`, `Installer`, `CI`, `Tests` |
| `Docs Required`      | `Yes`, `No`, `Unknown`                                                                      |
| `Changelog Required` | `Yes`, `No`, `Unknown`                                                                      |
| `Verification Level` | `Targeted`, `Full`, `Release`                                                               |
| `Release Impact`     | `None`, `Patch`, `Minor`, `Major`, `RC`                                                     |
| `Status`             | `Backlog`, `Ready`, `In Progress`, `Review`, `Blocked`, `Done`                              |

## Documentation Contract

Documentation must stay aligned with runtime behavior, CLI output, commands,
configuration, policies, schemas, tests, and release process.

Update user-facing docs when behavior, command syntax, config fields, policy
semantics, install/upgrade/release steps, error codes, recovery guidance, or
support expectations change. Update developer docs when architecture boundaries,
SSOT ownership, test strategy, release process, or contribution workflow changes.

If docs are not updated, the PR must state why no documentation change is needed.

## Changelog Contract

Update `CHANGELOG.md` for release-relevant changes:

- user-visible behavior
- CLI, API, or config changes
- policy or governance semantics
- release, install, upgrade, or rollback behavior
- security or fail-closed behavior
- error or recovery text
- meaningful test or quality gate changes

`CHANGELOG.md` is not required for typo-only docs, formatting, internal-only
cleanup without behavior change, or test refactors without new release-relevant
coverage. If not updated, the PR must state why no changelog entry is needed.

## High-Risk Contract

Changes touching state/session lifecycle, policy/risk logic, identity, audit or
hash-chain, archive, release or installer, CI or supply chain, persistence,
migration, compatibility, or security trust boundaries are `HIGH-RISK`.

High-risk work must include:

- governing contract and owning authority
- fail-closed behavior preservation
- no duplicate runtime authority
- negative-path tests
- docs and changelog decision
- rollback or recovery notes

## Branch And PR Contract

- Start from current `main`
- Create a clean conventional branch before making changes
- Do not work directly on `main`
- Keep the change scoped to the ticket
- Use a conventional commit and PR title
- Open a PR to `main`
- Merge only after required checks pass

Branch examples:

- `fix/<short-description>`
- `feat/<short-description>`
- `test/<short-description>`
- `refactor/<short-description>`
- `docs/<short-description>`
- `chore/<short-description>`
- `release/vX.Y.Z`
