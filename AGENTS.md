# Governed Runtime Contributor Notes

This repository builds FlowGuard, but working in this repository is not itself a
FlowGuard-governed runtime session.

## Scope and Precedence

- This file applies repository-wide.
- Nested `AGENTS.md` files in subdirectories ADD rules for files in their
  subtree. A nested file MUST NOT weaken repository-wide safety, evidence, or
  Git rules stated here.
- Apply repository-wide and nested rules cumulatively. A nested rule overrides
  a repository-wide rule only when it explicitly names the replaced rule and
  does not weaken safety, evidence, or Git rules.
- If two applicable instructions conflict and neither defines an explicit
  override, stop before the conflicting action and report the conflict.

## Enforcement Boundary

These instructions guide repository work but do NOT enforce policy by
themselves. Architecture tests, type checks, CI, hooks, schemas, and runtime
guards are the enforcement authorities. Never replace an enforceable check with
an instruction-only rule.

## Capability Awareness

- Do not assume that shell, network, Git write access, PR APIs, or interactive
  clarification are available.
- When a required capability is unavailable, do not simulate the result.
  Continue with safe read-only work where possible, or stop the action as
  `BLOCKED`.
- Resolve ambiguity from repository evidence first. If an unresolved ambiguity
  would materially change safety-sensitive or irreversible behavior, request
  clarification when the host supports interaction; otherwise stop that part as
  `BLOCKED`.

## Normative Terms

- **MUST / MUST NOT**: required for correctness or repository policy.
- **SHOULD / SHOULD NOT**: default unless evidence justifies an exception.
- **MAY**: optional.

## Repository vs. Product Behavior

- Do not call FlowGuard workflow tools merely because this file exists.
- Treat FlowGuard commands, sessions, evidence, and audit artifacts as product
  behavior to inspect or modify, not as the mandatory control plane for ordinary
  repository edits.
- If a product test requires FlowGuard artifacts, run the repository test or
  command that owns that behavior; do not invent governance evidence.

## Product Mandates

- Installed FlowGuard agent mandates are owned by `src/templates/mandates.ts`.
- The root `AGENTS.md` is local contributor guidance only and MUST NOT be used
  as the canonical source for installed mandate text.
- Keep product mandate changes aligned with their renderer, hash guards,
  install tests, and documentation contracts.

## Engineering Rules

- Make the smallest correct change that satisfies the user request. Preserve
  canonical authorities, schemas, state transitions, and fail-closed behavior
  in product code.
- Do not hide failures with silent fallbacks; surface errors explicitly.
- Do not claim tests or verification passed unless they were run.
- File-size budget: 750 LOC production, 2000 LOC test. Exceeding is a review
  blocker.
- Lockfile discipline: use `npm install` (not `npm audit fix` alone) for dependency changes.

### Assumptions and Evidence

Use these markers in contributor output:

- `ASSUMPTION`: necessary and plausible, but not verified from repository
  artifacts.
- `NOT_VERIFIED`: a concrete verification step relevant to the change was not
  executed or could not establish the claimed result. Include the recovery
  command or required capability when known. Do not use for ordinary uncertainty
  already identified as an `ASSUMPTION`.
- `BLOCKED`: safe implementation cannot continue with the available evidence.

- Do not present assumptions as established facts.
- Verify assumptions before implementation when reasonably available.
- Do not implement behavior that depends on an unresolved high-risk assumption.
- Do not encode unverified assumptions into contracts, schemas, state
  transitions, migrations, policy, security boundaries, or externally
  observable behavior.

### Error Conventions

- In production code, do not introduce bare `throw new Error(...)` at
  boundaries. Use typed errors with a `code` field (`PersistenceError`,
  `GitError`, `IdpError`).
- For blocked tool results, use the discriminated union pattern:
  `{ kind: 'blocked', code: string, reason: string, recovery?: string }`.

## Canonical Authorities

Before implementing a change, identify the canonical authority. Change the authority, not a local duplicate.

- State transitions: `src/machine/`
- Canonical serialization and digests: `src/shared/canonical-json.ts`
- Reason codes: `src/config/reasons.ts`
- Installed mandates: `src/templates/mandates.ts`
- Runtime config schema: `src/config/flowguard-config.ts`

Do not introduce parallel registries, local enum copies, ad-hoc serializers,
or inline reason or mandate definitions.

## Verification
1. Run the narrowest test that exercises the changed behavior.
2. Run `npm run check:format` for every change.
3. Run `npm run check` for TypeScript changes.
4. Run `npm run lint:strict` for TypeScript changes.
5. Run `npm run test:architecture` when imports, exports, file placement,
   canonical ownership, or layer boundaries change.
6. Apply additional verification from every applicable nested `AGENTS.md`.
7. Mark every relevant check not run as `NOT_VERIFIED`; include the recovery
   command or missing capability when known.
Also run `npm run build` for distribution changes and
`npm run check:unused-dependencies` for dependency or module-surface changes.
For high-risk authority, transition, guard, policy, or security-boundary
changes, run `npm run mutation` and meaningful negative-path verification.
At completion, report changed behavior, changed files, executed checks and
outcomes, relevant `NOT_VERIFIED` checks, and remaining assumptions or
blockers. Omit empty categories.

## Git Conventions

- Branches: `fix/<name>`, `feat/<name>`, `chore/<name>`.
- Commits: conventional commit format (`feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `ci`).
- Never commit unless explicitly asked. Never force-push without explicit
  instruction. Use `--force-with-lease`, never `--force`.

## Scoped Instructions

For layer-specific rules, follow the nearest applicable `AGENTS.md`:

- `src/machine/AGENTS.md` — state transitions, guard ordering, invariants
- `src/config/AGENTS.md` — reason code registry, policy types, config schema
- `src/integration/AGENTS.md` — plugin lifecycle, tool authoring, review pipeline

For PR metadata, commands, module boundaries, and naming conventions, see
`CONTRIBUTING.md`.
