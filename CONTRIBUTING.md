# Contributing to FlowGuard

Thank you for your interest in contributing to FlowGuard!

## Project Overview

FlowGuard is a host-aware, deterministic, fail-closed workflow engine for AI-assisted software delivery built with TypeScript. It enforces explicit phases, evidence gates, audit trails, and policy decisions across supported host surfaces. OpenCode currently provides the strongest synchronous enforcement path; Claude Code and Codex are hook-gated and platform-limited.

## Architecture

FlowGuard follows a Clean Architecture pattern with clear layer separation:

```
integration/  -> rails/  -> machine/  -> state/
             -> adapters/ -> discovery/, archive/, config/
```

### Key Layers

| Layer          | Purpose                                         | Role                                                        |
| -------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| `state/`       | Core domain model (Zod schemas, types)          | Canonical domain primitives                                 |
| `machine/`     | State machine (topology, guards, evaluation)    | Enforces transitions; no runtime authority of its own       |
| `rails/`       | Workflow orchestrators (stateless)              | Orchestration; I/O through adapters                         |
| `adapters/`    | File I/O, git, workspace management             | Host-agnostic I/O boundary                                  |
| `integration/` | Host integration surfaces and OpenCode bindings | Runtime-facing composition; entry points compose separately |

The diagram shows the intended direction for new code, not the enforced set:
top-level module directions are owned exclusively by `MODULE_DEPENDENCY_POLICY`
(`src/architecture/__tests__/module-dependency-policy.ts`), and the observed
module graph must match that policy exactly — including zero module cycles (see
[Architecture Rules](#architecture-rules)).

## Development Setup

### Prerequisites

- Node.js — canonical version defined in `.node-version` (currently `22.22.2`).
  - `nvm install "$(cat .node-version)" && nvm use "$(cat .node-version)"`
  - `fnm use "$(cat .node-version)"`
- npm (bundled with the Node version)
- The package runtime support claim is `^20.0.0 || ^22.0.0 || ^24.0.0` (see `engines` in `package.json`); CI verifies the packed artifact on each supported major separately from the dev toolchain.
- Dev-only tooling (for example `scripts/generate-mutation-registry.mjs`, which imports TypeScript through Node type stripping) may require the pinned `.node-version` runtime; that is a development contract and does not widen the published `engines` range.

### Installation

```bash
# Install exactly from the committed lockfile
npm ci

# Type check
npm run check

# Check production or test/configuration contexts separately
npm run check:prod
npm run check:tests

# Lint (CI gate: --max-warnings=0)
npm run lint:strict

# Run tests
npm test

# Run coverage gate
npm run test:coverage

# Build
npm run build
```

## Testing

FlowGuard uses Vitest for testing. All tests must pass before submitting a PR.
Linting is enforced on `src/**/*.ts` with an additional type-aware safety profile on critical governance surfaces (`src/audit`, `src/config`, `src/redaction`, `src/adapters/workspace`).
Coverage thresholds are 80% across branches, lines, functions, and statements:

- Branches: 80%
- Lines: 80%
- Functions: 80%
- Statements: 80%

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Check code formatting (Prettier)
npm run check:format

# Format code
npm run format

# Generate changelog
npm run changelog

# Run a specific test file
npx vitest run src/state/state.test.ts

# Run architecture tests
npx vitest run src/architecture/__tests__/dependency-rules.test.ts
```

### Test Categories

| Category     | Files                              | Purpose                           |
| ------------ | ---------------------------------- | --------------------------------- |
| Unit         | `src/**/*.test.ts` (w/ exclusions) | Core logic testing                |
| Architecture | `src/architecture/__tests__/`      | Dependency rule verification      |
| Integration  | `src/integration/*.test.ts`        | OpenCode tool integration         |
| Smoke        | `src/cli/*smoke*.test.ts`          | Built CLI + ACP end-to-end        |
| Performance  | `*.test.ts` with PERF describe     | Performance regression prevention |

### Test Naming Conventions

```typescript
describe('ModuleName / Feature', () => {
  describe('Happy Path', () => {
    it('should do X when Y');
  });

  describe('Edge Cases', () => {
    it('should handle empty input');
    it('should handle null/undefined');
    it('should handle maximum size');
  });

  describe('Error Handling', () => {
    it('should throw SPECIFIC_ERROR when invalid input');
    it('should return BlockedResult when precondition fails');
  });

  describe('Performance', () => {
    it('should complete in < Xms');
  });
});
```

## Debugging

The [Development Guide](docs/development/index.md) is the contributor
navigation entry point for setup, architecture, debugging, and dogfooding.

For the canonical macOS + IntelliJ IDEA development and debugging workflow,
including Vitest, CLI, MCP, OpenCode live debugging, source maps and isolated
dogfood repositories, see [docs/development/debugging.md](docs/development/debugging.md).

## Code Style

### TypeScript

- Use strict TypeScript (`"strict": true` in tsconfig.json)
- `tsconfig.json` is the production/build authority; `tsconfig.test.json` extends
  it for the full source graph in the test/configuration compilation context.
- Keep Vitest imports explicit. Do not add ambient test globals through
  `types: ["vitest/globals"]`.
- Prefer `type` over `interface` for simple type aliases
- Use Zod schemas as the source of truth for data validation
- Use `readonly` for immutable data structures

### Naming Conventions

| Element          | Convention           | Example            |
| ---------------- | -------------------- | ------------------ |
| Files            | kebab-case           | `session-state.ts` |
| Functions        | camelCase            | `executeHydrate()` |
| Classes          | PascalCase           | `PersistenceError` |
| Constants        | SCREAMING_SNAKE_CASE | `MAX_ITERATIONS`   |
| Types/Interfaces | PascalCase           | `RailResult`       |
| Enums            | PascalCase           | `Command.HYDRATE`  |

### Import Organization

```typescript
// 1. Node built-ins
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// 2. External packages
import { z } from 'zod';

// 3. FlowGuard state/machine (domain)
import type { SessionState } from '../state/schema';
import { evaluate } from '../machine/evaluate';

// 4. FlowGuard application (rails)
import { executeHydrate } from '../rails/hydrate';

// 5. FlowGuard infrastructure (adapters)
import { readState } from '../adapters/persistence';

// 6. FlowGuard config/extension
import { defaultProfileRegistry } from '../config/profile';
```

## Clean Code And Clean Architecture Principles

Every ticket, PR, and merge MUST follow clean code and clean architecture. No exceptions.

The **Enforced by** column states how each rule is checked: an automated guard
(test/lint that fails CI) or human review. Rules with an automated guard cannot
regress silently; review-enforced rules depend on reviewer diligence.

| Principle                     | Rule                                                                      | Red Flag                                              | Enforced by                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single Responsibility**     | One reason to change per module/file/function                             | God-files; over-long/over-complex functions           | ESLint metrics for every production file: `complexity:12`, `max-lines-per-function:80`, `max-params:5`, enforced by `lint:strict` (`--max-warnings=0`) and pinned by `type-aware-lint-scope.test.ts` |
| **Layer Isolation**           | Respect `state/` `machine/` `rails/` `adapters/` `integration/`           | Upward imports, layer bypass                          | `module-dependency-policy.ts` + `dependency-rules.test.ts`; module graph must stay acyclic (zero cyclic edges)                                                                                       |
| **Extract, Don't Accumulate** | Split files along domain boundaries within the size budget                | Linear growth with every feature                      | `src/architecture/__tests__/file-size.test.ts`                                                                                                                                                       |
| **No Duplicate Authority**    | One canonical implementation per concept                                  | Near-identical functions, duplicated pipelines        | SSOT guards: `actor-assurance-ssot`, `canonical-json-ssot`, `digest-authority-ssot`, `policy-mode-ssot`, `review-acceptance-ssot`, `terminal-phase-ssot`                                             |
| **Content/Logic Separation**  | Template content in content files, assembly in renderer files             | Template strings mixed with business logic            | Review                                                                                                                                                                                               |
| **Infrastructure Isolation**  | Locking, atomic I/O, and domain logic in separate modules                 | Concurrency code inside domain persistence files      | Review                                                                                                                                                                                               |
| **Import Hygiene**            | Imports proportional to responsibility                                    | 15+ imports from 8+ modules in one file               | Review                                                                                                                                                                                               |
| **Testability**               | Every extracted module independently testable                             | Dropped coverage after extraction                     | Review (coverage gate)                                                                                                                                                                               |
| **Fail-Closed**               | Errors block; no silent fallback masks a failure                          | Swallowed errors, default-allow on missing evidence   | Review (+ negative-path tests required per AGENTS.md)                                                                                                                                                |
| **Typed Errors**              | Throw typed errors with codes, not bare `throw new Error` in control flow | Bare throws in runtime paths                          | Review                                                                                                                                                                                               |
| **Determinism**               | Same input → same output for digests/canonicalization/state               | Hidden nondeterminism (time, ordering) in hash inputs | `canonical-json-ssot`, `digest-authority-ssot`, digest byte-identity tests                                                                                                                           |
| **API Stability**             | Public surface stays intentional; no test-only utilities leaked           | Test helpers exported from the public barrel          | Review (barrel-export tests)                                                                                                                                                                         |

Maintainability limits (Single Responsibility):

- Enforced limits for every production file: `complexity:12`,
  `max-lines-per-function:80`, `max-params:5`.
- `lint:strict` (`--max-warnings=0`) is the single enforcement authority. The
  former monotonic maintainability ratchet and its baseline were removed once
  the debt reached zero; `type-aware-lint-scope.test.ts` pins the values and the
  production file-class scope against the effective ESLint config.
- Metric `eslint-disable` suppressions are not part of the model: the tree
  contains none, and a new suppression fails `lint:strict`.

### File Size Budget

Exceeding the file-size budget is a review blocker. Single source of truth for the size budget. The blocker thresholds are enforced
by `src/architecture/__tests__/file-size.test.ts` (constants `PROD_FILE_LOC_BLOCKER`
= 650, `TEST_FILE_LOC_BLOCKER` = 2000).

| Threshold (production) | Action Required                                  |
| ---------------------- | ------------------------------------------------ |
| =< 400 LOC             | Healthy - no action                              |
| 400-650 LOC            | Consider splitting at next touch                 |
| > 650 LOC              | Blocker - split required before merge (enforced) |

Test files may be broader (suites group related cases): advisory split at
1500 LOC, hard blocker above 2000 LOC (enforced).

### Definition Of "100% Clean Code"

"Clean" is a verifiable state, not an opinion. A change is clean when ALL of the
following hold:

1. `npm run check` (production and test-context TypeScript compilation) passes.
2. `npm run lint:strict` passes (`eslint --max-warnings=0`).
3. `dependency-rules.test.ts` passes (no layer violation).
4. All SSOT guards pass (no duplicate authority).
5. `file-size.test.ts` passes (no production file > 650 LOC, no test file > 2000 LOC).
6. No bare `throw new Error(...)`/native `new Error(...)` or non-null assertion in
   production source (typed errors and real narrowing only; enforced by
   `production-zero-debt.test.ts` and the production ESLint scope).
7. New behavior touching state/policy/evidence/audit has negative-path tests.

## Repository Governance

### Branch Model

- `main` is **protected** and must remain release-ready at all times. No direct commits allowed.
- `develop` is **protected** and is the integration branch for main-ready work before a release cut.
- All changes must go through Pull Requests.
- Default PR target is `develop` for normal feature, fix, docs, refactor, test, and chore work.
- PRs to `main` are reserved for release branches, urgent hotfixes, or repository-governance changes that must apply immediately.
- Branch naming is canonical here. Use one of:
  - `feat/<description>` — new features
  - `fix/<description>` — bug fixes
  - `docs/<description>` — documentation updates
  - `test/<description>` — test-only changes
  - `refactor/<description>` — behavior-preserving refactors
  - `chore/<description>` — maintenance tasks
  - `release/vX.Y.Z` — release preparation branches

### Release Branches

Release work follows the same protected-`main` PR model as all other changes.
Run this protected-main release procedure:

1. Start from current `main`: `git switch main && git pull --ff-only origin main`.
2. Create `release/vX.Y.Z` and integrate the release candidate from `develop`.
3. Prepare files without committing or tagging: `npm run release:prepare -- X.Y.Z`.
4. Update release-pinned documentation tests when the changelog cut moves entries out of `[Unreleased]`.
5. Run `npm run release:verify` and the required contributor checks.
6. Commit with hooks enabled: `git commit -m "chore(release): cut vX.Y.Z"`.
7. Open a PR to `main`, wait for required checks, and squash-merge it.
8. Refresh local `main`: `git switch main && git pull --ff-only origin main`.
9. Prove tag safety: `npm run release:assert-main-tag -- vX.Y.Z`.
10. Create and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
11. Verify the GitHub Release, checksums, SBOM, and provenance artifacts.

Use `npm run release:prepare -- X.Y.Z` to update release files. Do not use
`npm version` for FlowGuard releases because it creates local commit/tag state
before branch protection and required checks have accepted the release. Before
tagging, run `npm run release:assert-main-tag -- vX.Y.Z` to fail closed unless
the checkout is clean, on `main`, equal to `origin/main`, version-consistent, and
untagged.

If a release tag is pushed before the release commit is merged to `main`, stop
and treat the release as inconsistent. Do not overwrite or force-push the tag.
Either merge the exact tagged commit through the protected PR path or publish a
new patch/prerelease tag from the corrected `main` commit.

`npm run release:verify` is the package-defined local release verification
script. It runs `npm run lint`; required CI and contributor linting use
`npm run lint:strict` and remain separate checks. The release script definition
in `package.json` is authoritative for its exact command set.

### Conventional Commits

All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>: <description>

[optional body]

[optional footer]
```

**Allowed types:**

| Type       | Description                              |
| ---------- | ---------------------------------------- |
| `feat`     | New feature                              |
| `fix`      | Bug fix                                  |
| `docs`     | Documentation changes                    |
| `test`     | Adding or updating tests                 |
| `refactor` | Code refactoring without behavior change |
| `chore`    | Maintenance tasks, dependency updates    |
| `perf`     | Performance improvements                 |
| `ci`       | CI/CD changes                            |

**Examples:**

```bash
feat: add archive verification command
fix: correct session state validation
docs: update command reference
test: add edge case for empty repository
refactor: extract validation helpers
```

### Merge Strategy

- **Preferred:** Squash and merge
- PR title must follow conventional commit format
- All CI checks must pass before merge
- External review is recommended for high-risk changes when a second reviewer is available

### CI Status Checks

The required status checks for the protected `main` and `develop` branches are
maintained in [`.github/BRANCH-PROTECTION.md`](.github/BRANCH-PROTECTION.md).
The CI job definitions, including the `ci-gate` aggregator and its dependencies,
are maintained in [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Update
those canonical sources when check names or branch-protection requirements
change; do not maintain a second check list here.

### Change Verification Matrix

Run the baseline checks required by [AGENTS.md](AGENTS.md#verification), then
add the narrowest checks that cover the changed surface. This table is a routing
aid; scripts, tests, CI, and `AGENTS.md` remain the enforcement authorities.

| Changed surface | Additional verification |
| --- | --- |
| Documentation or Markdown links | Relevant `src/documentation/__tests__` files and `full-repo-links.test.ts` |
| TypeScript source or tests | `npm run check`, `npm run lint:strict` |
| Imports, exports, placement, or layer boundaries | `npm run test:architecture` |
| Runtime configuration, installed commands, or templates | Owning contract and install tests; `npm run build` for distribution changes |
| State, policy, audit, guards, or security boundaries | Meaningful negative paths and `npm run mutation`; verify the changed selector is admitted by `stryker.conf.json` and `scripts/mutation-profile-registry.json` |
| Dependencies or module surface | `npm run check:unused-dependencies` |

## Pull Request Process

Use `.github/PULL_REQUEST_TEMPLATE.md` as the canonical source for PR metadata.

### Ticket Readiness Contract

Tickets should be considered ready for implementation only when the following
items are explicit:

- Objective is clear
- Scope and non-goals are clear
- Risk class is set (`TRIVIAL`, `STANDARD`, or `HIGH-RISK`)
- Touched surface is identified
- Acceptance criteria are testable
- Verification expectations are stated
- Documentation expectation is stated
- Changelog expectation is stated

Recommended GitHub Project fields:

| Field                | Values                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `Risk Class`         | `TRIVIAL`, `STANDARD`, `HIGH-RISK`                                                          |
| `Touched Surface`    | `Docs`, `CLI`, `Policy`, `State`, `Audit`, `Archive`, `Release`, `Installer`, `CI`, `Tests` |
| `Docs Required`      | `Yes`, `No`, `Unknown`                                                                      |
| `Changelog Required` | `Yes`, `No`, `Unknown`                                                                      |
| `Verification Level` | `Targeted`, `Full`, `Release`                                                               |
| `Release Impact`     | `None`, `Patch`, `Minor`, `Major`, `RC`                                                     |
| `Status`             | `Backlog`, `Ready`, `In Progress`, `Review`, `Blocked`, `Done`                              |

### Documentation Contract

Documentation must stay aligned with runtime behavior, CLI output, commands,
configuration, policies, schemas, tests, and release process.

Update user-facing docs when behavior, command syntax, config fields, policy
semantics, install/upgrade/release steps, error codes, recovery guidance, or
support expectations change. Update developer docs when architecture boundaries,
SSOT ownership, test strategy, release process, or contribution workflow changes.

If docs are not updated, the PR must state why no documentation change is needed.

### Changelog Contract

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

### High-Risk Contract

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

### 1. Before Starting

- Check existing issues and PRs
- For significant changes, open an issue first to discuss the approach

### 2. Development

```bash
# Create a feature branch
git checkout -b feat/my-feature

# Make changes
# ... write code ...

# Run tests
npm test

# Run type check
npm run check

# Run architecture tests
npm run test:architecture
```

### 3. Commit Messages

See [Conventional Commits](#conventional-commits) section above.

### 4. Submit PR

- Fill out the PR template
- Link related issues
- Ensure all tests pass
- Request review from maintainers

## Architecture Rules

Import rules must stay aligned with `npm run test:architecture`.

The positive authority for top-level module direction is
`src/architecture/__tests__/module-dependency-policy.ts` (`MODULE_DEPENDENCY_POLICY`):
the exact set of governed modules each governed module may import. The observed
import graph and the policy must match in both directions, so both an unapproved
direction and a stale policy edge fail. Add a new direction to the policy file in
the same change that introduces the import.

Fine-grained boundaries are additionally enforced by
`src/architecture/__tests__/dependency-rules.test.ts`:

### Must Follow

1. **`state/`** may only import the listed shared primitives (canonicalization,
   hashing, actor assurance) and owns its evidence discriminators
2. **Leaf modules** (`archive/types`, `discovery/types`) must not import other FF modules
3. **`rails/`** must not import node built-ins directly (I/O is handled by adapters)
4. **`integration/tools/`** must not import integration composition (`plugin.ts`, `plugin-*`; `plugin-helpers.ts` is a root authority)
5. **`integration/review/`** may import `review/**`, root authorities and lower layers; it must not import `tools/**`, composition, or host/runtime wiring
6. **Production outside `integration/tools/**`** must not deep-import a tool command context; `integration/tools/index.ts` is the single external entry
7. Entry points, test-support files, and unclassified imports stay default-deny

### Cycle Debt

Module-level cycles are prohibited outright: the top-level module graph MUST have
zero cyclic directed edges and zero cyclic strongly connected components.
`dependency-rules.test.ts` fails closed on any observed cycle, and there is no
baseline to update or grandfather. File-level cycles remain prohibited outright.

## Error Handling

### Use Typed Errors

```typescript
// Good: Typed error with code
export class PersistenceError extends Error {
  readonly code: 'READ_FAILED' | 'WRITE_FAILED' | 'SCHEMA_VALIDATION_FAILED';

  constructor(code: this['code'], message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

// Bad: Generic error
throw new Error('Something went wrong');
```

### Use Blocked Results

```typescript
// Good: Structured blocked result
export function validate(input: unknown): RailResult {
  if (!isValid(input)) {
    return {
      kind: 'blocked',
      code: 'INVALID_INPUT',
      reason: 'Input does not match expected schema',
      recovery: ['Provide valid input matching the schema'],
    };
  }
  // ...
}
```

## Documentation

### When Adding New Features

1. Update `README.md` with new commands or options
2. Add JSDoc comments to new functions
3. Add tests for new functionality
4. Update `PRODUCT_IDENTITY.md` if product facts change
5. Follow the layer entry points and checklists in the
   [Developer Architecture Map](./docs/development/architecture-map.md)

### When Changing Architecture

1. Update `AGENTS.md` if developer mandates change
2. Update architecture comments in relevant files
3. Update or add architecture tests
4. Update the placement/zone authorities when files move or are added
   (see the [Developer Architecture Map](./docs/development/architecture-map.md))
5. Follow the add/move/delete checklist for production files in the
   [Developer Architecture Map](./docs/development/architecture-map.md#add-move-or-delete-a-production-file)

## Performance Guidelines

- Profile operations should complete in < 10ms for simple operations
- Heavy operations should complete in < 100ms
- Define explicit performance contracts with `PERF_BUDGETS` and benchmark helpers where applicable
- Do not use arbitrary single-invocation wall-clock smoke thresholds as correctness-test gates

```typescript
describe('Performance', () => {
  it(`should complete within the declared p99 budget`, () => {
    const { p99Ms } = benchmarkSync(doOperation, 100, 10);
    expect(p99Ms).toBeLessThan(PERF_BUDGETS.operationMs);
  });
});
```

## Questions?

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Follow the code of conduct

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
