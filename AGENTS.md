# Governed Runtime Contributor Notes

This repository builds FlowGuard, but working in this repository is not itself a
FlowGuard-governed runtime session.

## Local Agent Behavior

* Do not call FlowGuard workflow tools merely because this file exists.
* Treat FlowGuard commands, sessions, evidence, and audit artifacts as product
  behavior to inspect or modify, not as the mandatory control plane for ordinary
  repository edits.
* Use the normal development tools available in this workspace unless the user
  explicitly asks you to exercise FlowGuard runtime behavior.
* If a product test requires FlowGuard artifacts, run the repository test or
  command that owns that behavior; do not invent governance evidence in chat.

## Product Mandates

* Installed FlowGuard agent mandates are owned by `src/templates/mandates.ts`.
* The root `AGENTS.md` is local contributor guidance only and must not be used
  as the canonical source for installed mandate text.
* Keep product mandate changes aligned with their renderer, hash guards,
  install tests, and documentation contracts.

## Engineering Rules

* Make the smallest correct change that satisfies the user request.
* Preserve canonical authorities, schemas, state transitions, and fail-closed
  behavior in product code.
* Do not hide failures with silent fallbacks; surface errors explicitly.
* Do not claim tests or verification passed unless they were run.
* Mark unexecuted or unproven claims as `NOT_VERIFIED`.
* For trust-boundary reviews, use `docs/trust-boundaries.md` as the canonical
  review contract.
* Respect the file-size budget: 750 LOC is a review blocker for production
  files unless explicitly justified; 2000 LOC for test files. New files near
  the limit must not be further inflated. Prefer refactoring when a touched
  file already exceeds budget.

### Assumptions and Evidence

Use these markers in contributor output:

* `ASSUMPTION`: necessary and plausible, but not verified from repository
  artifacts.
* `NOT_VERIFIED`: not executed, tested, or proven with evidence.
* `BLOCKED`: safe implementation cannot continue with the available evidence.

Rules:

* Do not present assumptions as established repository or runtime facts.
* Verify assumptions before implementation when verification is reasonably
  available.
* Plans may contain clearly marked assumptions, but must identify which
  assumptions require verification before implementation.
* Do not implement behavior that depends on an unresolved high-risk assumption.
* Do not encode unverified assumptions into contracts, schemas, state
  transitions, migrations, policy, security boundaries, or externally
  observable behavior.
* For safety-relevant or high-risk ambiguity, ask the minimum precise
  clarification needed or state that implementation is `BLOCKED`.

### Error Conventions

* In production code, do not introduce bare `throw new Error(...)` at
  persistence, Git, IDP, config, policy, CLI, or tool boundaries. Use typed
  errors with a `code` field (`PersistenceError`, `GitError`, `IdpError`).
* For blocked tool results, use the discriminated union pattern:
  `{ kind: 'blocked', code: string, reason: string, recovery?: string }`.

### Naming Conventions

* Files: kebab-case (`install-steps.ts`, `error-serialize.ts`).
* Classes: PascalCase (`PersistenceError`, `FlowGuardConfig`).
* Constants: SCREAMING_SNAKE_CASE (`DEFAULT_RETENTION_DAYS`,
  `REVIEWER_SUBAGENT_TYPE`).

## Canonical Authorities

Before implementing a change, identify whether the touched concern has a
canonical authority. Change the authority, not a local duplicate.

* State transitions: `src/machine/`
* Canonical serialization and digests: `src/shared/canonical-json.ts`
* Review mode classification: `src/integration/tools/review-validation-mode.ts`
* Reason codes: `src/config/reasons.ts`
* Installed mandates: `src/templates/mandates.ts`
* Runtime config schema: `src/config/flowguard-config.ts`
* Logging config schema: `src/config/logging-config.ts`

Do not introduce parallel registries, local enum copies, ad-hoc serializers,
or inline reason or mandate definitions.

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

* `src/config/` must not derive runtime state; it defines schemas, not behavior.
* `src/templates/mandates.ts` is the sole mandate authority.
* `src/logging/` is diagnostic only and must not become a governance authority.
* Integration and CLI may consume authorities but must never duplicate them.

## Verification

Run the checks applicable to the touched surface and risk class. Do not claim
unexecuted checks passed.

* **Baseline**: narrowest relevant test, `npm run check:format`, state missing
  coverage explicitly.
* **Source-code changes**: `npm run check`, `npm run lint:strict`, targeted unit
  / integration / smoke tests, `npm run build` for distribution changes,
  `npm run check:unused-dependencies` for import/export/module changes.
* **Architecture-sensitive changes**: `npm run test:architecture`.
* **Authority and high-risk changes**: `npm run mutation` when scope or
  authority changed; mark `NOT_VERIFIED` if skipped with recovery command;
  include meaningful negative-path verification.

Coverage thresholds are 80% across branches, lines, functions, and statements;
run `npm run test:coverage:ci` when required by the touched surface, risk class,
or CI contract. Area-specific checks (reason codes, documentation contracts,
generated guards) are documented in the nearest applicable `AGENTS.md` or in
`docs/`.

## Local Commands

* `npm test` — full unit and integration suite.
* `npx vitest run --project unit <file>` — focused unit test.
* `npx vitest run --project integration <file>` — focused integration test.
* `npm run check` — production and test TypeScript compilation.
* `npm run lint:strict` — ESLint with `--max-warnings=0`.
* `npm run check:format` — Prettier formatting check.
* `npm run build` — production build to `dist/`.
* `npm run test:architecture` — dependency, module, and file-size rules.

## Pull Request Metadata

Use `.github/PULL_REQUEST_TEMPLATE.md` as the canonical source for PR metadata.

Before submitting a PR, classify:

* **Touched Surface**: Docs, CLI, Policy, State, Audit, Release, Security,
  Tests.
* **Risk Class**: `TRIVIAL`, `STANDARD`, or `HIGH-RISK`.

`HIGH-RISK` requires extended verification, including negative-path tests,
SSOT checks, and mutation testing when applicable.

PR descriptions must distinguish:

* checks that were actually executed;
* checks that remain `NOT_VERIFIED`;
* assumptions that remain unresolved;
* any intentional change to an existing guard or policy budget.

## Git Conventions

* Branches: `fix/<name>`, `feat/<name>`, `chore/<name>`.
* Commits: conventional commit format.
* Allowed commit types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`,
  `perf`, `ci`.
* Use a scope where applicable: `type(scope): description`.
* Never commit unless explicitly asked by the user.
* Never force-push without explicit user instruction.
* When rebasing requires a force push, use `--force-with-lease`; never use
  plain `--force`.

## Area-Specific Guidance

For layer-specific rules, follow the nearest applicable `AGENTS.md`:

* `src/machine/AGENTS.md` — state transitions, guard ordering, invariants
* `src/config/AGENTS.md` — reason code registry, policy types, config schema
* `src/integration/AGENTS.md` — plugin lifecycle, tool authoring, review
  pipeline

These files are local contributor guidance, not installed product mandates.
