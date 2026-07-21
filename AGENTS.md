# Governed Runtime Contributor Notes

This repository builds FlowGuard, but working in this repository is not itself a
FlowGuard-governed runtime session.

## Local Agent Behavior

- Do not call FlowGuard workflow tools merely because this file exists.
- Treat FlowGuard commands, sessions, evidence, and audit artifacts as product
  behavior to inspect or modify, not as the mandatory control plane for ordinary
  repository edits.
- Use the normal development tools available in this workspace unless the user
  explicitly asks you to exercise FlowGuard runtime behavior.
- If a product test requires FlowGuard artifacts, run the repository test or
  command that owns that behavior; do not invent governance evidence in chat.

## Product Mandates

- Installed FlowGuard agent mandates are owned by `src/templates/mandates.ts`.
- The root `AGENTS.md` is local contributor guidance only and must not be used as
  the canonical source for installed mandate text.
- Keep product mandate changes aligned with their renderer, hash guards, install
  tests, and documentation contracts.

## Engineering Rules

- Make the smallest correct change that satisfies the user request.
- Preserve canonical authorities, schemas, state transitions, and fail-closed
  behavior in product code.
- Do not hide failures with silent fallbacks; surface errors explicitly.
- Do not claim tests or verification passed unless they were run.
- Mark unexecuted or unproven claims as `NOT_VERIFIED`.

### Assumptions and Evidence

- Do not present assumptions as established repository or runtime facts.
- Mark necessary unverified assumptions explicitly as `ASSUMPTION`.
- Verify assumptions before implementation when verification is reasonably
  available.
- Do not encode unverified assumptions into contracts, schemas, state
  transitions, migrations, policy, security boundaries, or externally
  observable behavior.
- For safety-relevant or high-risk ambiguity, ask one precise question or
  return `BLOCKED`.

- For trust-boundary reviews, use `docs/trust-boundaries.md` as the canonical
  review contract.
- Respect the file-size budget: 750 LOC is a review blocker for production
  files unless explicitly justified; 2000 LOC for test files. New files near
  the limit must not be further inflated. Prefer refactoring when a touched
  file already exceeds budget.

### Error Conventions

- In production code, do not introduce bare `throw new Error(...)` at
  persistence, Git, IDP, config, policy, CLI, or tool boundaries. Use typed
  errors with a `code` field (`PersistenceError`, `GitError`, `IdpError`).
- For blocked tool results, use the discriminated union pattern:
  `{ kind: 'blocked', code: string, reason: string, recovery?: string }`.

### Naming Conventions

- Files: kebab-case (`install-steps.ts`, `error-serialize.ts`).
- Classes: PascalCase (`PersistenceError`, `FlowGuardConfig`).
- Constants: SCREAMING_SNAKE_CASE (`DEFAULT_RETENTION_DAYS`,
  `REVIEWER_SUBAGENT_TYPE`).

## Canonical Authorities

Before implementing a change, identify whether the touched concern has a
canonical authority. Change the authority, not a local duplicate.

- State transitions: `src/machine/`
- Canonical serialization and digests: `src/shared/canonical-json.ts`
- Review mode classification: `src/integration/tools/review-validation-mode.ts`
- Reason codes: `src/config/reasons.ts`
- Installed mandates: `src/templates/mandates.ts`
- Runtime config schema: `src/config/flowguard-config.ts`
- Logging config schema: `src/config/logging-config.ts`

Do not introduce parallel registries, local enum copies, ad-hoc serializers,
or inline reason/mandate definitions.

- Before creating a new module, verify no existing canonical authority already
  covers the concern. If unsure, check this file and `docs/trust-boundaries.md`.

## Module Boundaries

These import rules must stay aligned with `npm run test:architecture`:

| Layer              | May Import                                             | Must NOT Import                                 |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------- |
| `src/state/`       | `src/shared/`                                          | `src/config/`, `src/rails/`, `src/integration/` |
| `src/machine/`     | `src/state/`, `src/shared/`                            | `src/config/`, `src/rails/`                     |
| `src/rails/`       | `src/machine/`, `src/state/`, `src/shared/`            | `src/integration/`, `src/adapters/`             |
| `src/config/`      | `src/shared/`, `src/logging/log-level.ts`              | `src/state/`, `src/rails/`, `src/integration/`  |
| `src/adapters/`    | `src/state/`, `src/config/`, `src/shared/`             | `src/integration/`                              |
| `src/integration/` | Consumes canonical authorities and runtime-facing APIs | Must not become a provider for lower layers     |

Additional rules:

- `src/config/` must not derive runtime state — it defines schemas, not behavior.
- `src/templates/mandates.ts` is the sole mandate authority.
- `src/logging/` is diagnostic only — it must not become a governance authority.
- Integration and CLI may consume authorities but must never duplicate them.

## Test Placement

- Use `--project unit` for pure logic, validation, serializers, and mocked IO.
- Use `--project integration` for runtime/plugin/adapter behavior that crosses
  module boundaries.
- Use `--project smoke` for CLI, packaging, install, and end-to-end sanity checks.
- Use `npm run test:architecture` for dependency boundaries, file-size limits,
  and module rules.
- Co-locate tests with the touched source unless the existing package uses a
  dedicated `__tests__/` layout.

## Generated Guards and Digests

Some source files are protected by generated digests or guard tests. When
changing mandates, schemas, generated contracts, or serialized evidence
formats, run the owning guard tests:

- Mandate content changes: run the mandate hash guard
  (`src/cli/templates-hash.test.ts`) and the install contract tests
- Schema changes: run the relevant schema, default parsing, and version
  consistency tests
- Generated documentation or version placeholders: run `npm run generate-docs`

Do not hand-edit generated hashes or digests. When a guard test fails because
the content has intentionally changed, update the guard's expected value
**explicitly** as part of the same change — the guard must never be
blindly suppressed.

## Local Commands

- `npm test` — full unit + integration suite.
- `npx vitest run --project unit <file>` — run a focused unit test file.
- `npx vitest run --project integration <file>` — run a focused integration test file.
- `npx vitest run --project smoke <file>` — run a focused smoke test file.
- `npm run check` — Production + test TypeScript compilation; use `check:prod` or `check:tests` individually.
- `npm run lint:strict` — ESLint with `--max-warnings=0` as a CI gate.
- `npm run check:format` — Prettier formatting check.
- `npm run build` — production build to `dist/`.
- `npm run test:architecture` — dependency rules and file-size enforcement.
- `npm run check:unused-dependencies` — Knip stale dependency/module check.

## Verification Checklist

Before marking any task complete:

1. Run `npm run check` — zero type errors.
2. Run `npm run lint:strict` — zero warnings.
3. Run the narrowest relevant test command for the touched surface.
4. Run `npm run test:architecture` for dependency, module-boundary, file-size, or architecture-sensitive changes.
5. Run `npm run build` for CLI, package, runtime entrypoint, or distribution changes.
6. Run `npm run check:unused-dependencies` when imports, exports, packages, or module boundaries change.
7. For state, policy, archive, audit, review, or enforcement authority changes, run `npm run mutation` when mutation scope changed or the touched authority is mutation-covered. If not run, mark `NOT_VERIFIED` with the recovery command.
8. For new reason codes, verify `npx vitest run --project unit src/config/reasons-completeness.test.ts`.
9. For documentation contract changes, run the relevant docs drift or contract tests for the touched area; if no such test exists, state that explicitly in the verification notes. Reason-code or reason-doc changes must include:
   ```
   npx vitest run --project unit src/config/reasons-completeness.test.ts src/documentation/__tests__/reasons-doc-drift.test.ts
   ```
10. Coverage thresholds: 80% across branches, lines, functions, and statements.
    Run `npm run test:coverage:ci` to verify.
11. Before pushing, run `npm run check:format`; the CI pre-push hook requires clean Prettier output.

## Pull Request Metadata

Use `.github/PULL_REQUEST_TEMPLATE.md` as the canonical source for PR
metadata fields. Before submitting a PR, classify:

- **Touched Surface**: Docs, CLI, Policy, State, Audit, Release, Security,
  Tests.
- **Risk Class**: `TRIVIAL`, `STANDARD`, or `HIGH-RISK`. HIGH-RISK triggers
  extended verification (mutation, negative-path tests, SSOT checks).

## Git Conventions

- Branches: `fix/<name>`, `feat/<name>`, `chore/<name>`.
- Commits: conventional commit format. Allowed types: `feat`, `fix`, `docs`,
  `test`, `refactor`, `chore`, `perf`, `ci`. Use `(scope):` where applicable.
- Never commit unless explicitly asked by the user.
- Never force-push without explicit user instruction.
- Push with `--force-with-lease` when rebasing; never use plain `--force`.
