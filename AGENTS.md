# Governed Runtime Contributor Notes

This repository builds FlowGuard, but working in this repository is not itself a
FlowGuard-governed runtime session.

## Scope and Precedence

* This file applies repository-wide.
* Nested `AGENTS.md` files in subdirectories ADD rules for files in their
  subtree. A nested file MUST NOT weaken repository-wide safety, evidence, or
  Git rules stated here.
* If two applicable instructions conflict and neither defines an explicit
  override, stop before the conflicting action and report the conflict.
* Nested instructions are read after root instructions.

## Enforcement Boundary

These instructions guide repository work but do NOT enforce policy by
themselves. Architecture tests, type checks, CI, hooks, schemas, and runtime
guards are the enforcement authorities. Never replace an enforceable check with
an instruction-only rule.

## Capability Awareness

* Do not assume that shell, network, Git write access, PR APIs, or interactive
  clarification are available.
* When a required capability is unavailable, do not simulate the result.
  Continue with safe read-only work where possible, or stop the action as
  `BLOCKED`.
* Resolve ambiguity from repository evidence first. If an unresolved ambiguity
  would materially change safety-sensitive or irreversible behavior, request
  clarification when the host supports interaction; otherwise stop that part as
  `BLOCKED`.

## Normative Terms

* **MUST** / **MUST NOT**: required for correctness or repository policy.
* **SHOULD** / **SHOULD NOT**: default unless repository evidence justifies an
  exception.
* **MAY**: optional.

## Repository vs. Product Behavior

* Do not call FlowGuard workflow tools merely because this file exists.
* Treat FlowGuard commands, sessions, evidence, and audit artifacts as product
  behavior to inspect or modify, not as the mandatory control plane for ordinary
  repository edits.
* If a product test requires FlowGuard artifacts, run the repository test or
  command that owns that behavior; do not invent governance evidence.

## Product Mandates

* Installed FlowGuard agent mandates are owned by `src/templates/mandates.ts`.
* The root `AGENTS.md` is local contributor guidance only and MUST NOT be used
  as the canonical source for installed mandate text.
* Keep product mandate changes aligned with their renderer, hash guards,
  install tests, and documentation contracts.

## Engineering Rules

* Make the smallest correct change that satisfies the user request. Preserve
  canonical authorities, schemas, state transitions, and fail-closed behavior
  in product code.
* Do not hide failures with silent fallbacks; surface errors explicitly.
* Do not claim tests or verification passed unless they were run.
* Respect the file-size budget: 750 LOC production, 2000 LOC test files.
  Exceeding is a review blocker.
* Lockfile discipline: use `npm install` (not `npm audit fix` alone) for
  dependency changes.

### Assumptions and Evidence

Use these markers in contributor output:

* `ASSUMPTION`: necessary and plausible, but not verified from repository
  artifacts.
* `NOT_VERIFIED`: not executed, tested, or proven with evidence.
* `BLOCKED`: safe implementation cannot continue with the available evidence.

Rules:

* Do not present assumptions as established facts.
* Verify assumptions before implementation when reasonably available.
* Do not implement behavior that depends on an unresolved high-risk assumption.
* Do not encode unverified assumptions into contracts, schemas, state
  transitions, migrations, policy, security boundaries, or externally
  observable behavior.

### Error Conventions

* In production code, do not introduce bare `throw new Error(...)` at
  boundaries. Use typed errors with a `code` field (`PersistenceError`,
  `GitError`, `IdpError`).
* For blocked tool results, use the discriminated union pattern:
  `{ kind: 'blocked', code: string, reason: string, recovery?: string }`.

## Canonical Authorities

Before implementing a change, identify the canonical authority. Change the
authority, not a local duplicate.

* State transitions: `src/machine/`
* Canonical serialization and digests: `src/shared/canonical-json.ts`
* Reason codes: `src/config/reasons.ts`
* Installed mandates: `src/templates/mandates.ts`
* Runtime config schema: `src/config/flowguard-config.ts`

Do not introduce parallel registries, local enum copies, ad-hoc serializers,
or inline reason or mandate definitions.

## Verification

Run the checks applicable to the touched surface and risk class. Do not claim
unexecuted checks passed. Area-specific checks are documented in the nearest
applicable `AGENTS.md` or in `docs/`.

* **Baseline**: narrowest relevant test, `npm run check:format`.
* **Source-code changes**: `npm run check`, `npm run lint:strict`, targeted unit
  / integration tests, `npm run build` (distribution changes).
* **Architecture-sensitive**: `npm run test:architecture`.
* **High-risk**: `npm run mutation`. Mark `NOT_VERIFIED` if skipped.

## Git Conventions

* Branches: `fix/<name>`, `feat/<name>`, `chore/<name>`.
* Commits: conventional commit format (`feat`, `fix`, `docs`, `test`, `refactor`,
  `chore`, `perf`, `ci`).
* Never commit unless explicitly asked. Never force-push without explicit
  instruction. Use `--force-with-lease`, never `--force`.

## Scoped Instructions

For layer-specific rules, follow the nearest applicable `AGENTS.md`:

* `src/machine/AGENTS.md` — state transitions, guard ordering, invariants
* `src/config/AGENTS.md` — reason code registry, policy types, config schema
* `src/integration/AGENTS.md` — plugin lifecycle, tool authoring, review
  pipeline

For PR metadata, commands, module boundaries, and naming conventions, see
`CONTRIBUTING.md`.
