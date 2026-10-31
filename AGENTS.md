# Governed Runtime Contributor Notes

This repository builds FlowGuard, but working in this repository is not itself a
FlowGuard-governed runtime session.

## Scope and Precedence

- Applies repository-wide; nested `AGENTS.md` files ADD subtree rules.
- Apply rules cumulatively. Overrides must explicitly name the replaced rule;
  nested rules MUST NOT weaken repository-wide safety, evidence, or Git rules.
- Without an explicit override, stop before a conflicting action and report it.

## Enforcement Boundary

Instructions do NOT enforce policy. Architecture tests, type checks, CI, hooks,
schemas, and runtime guards do. Never replace an enforceable check with prose.

## Capability Awareness

- Do not assume shell, network, Git writes, PR APIs, or clarification are available.
- Never simulate an unavailable capability: continue safe read-only work or mark
  the affected action `BLOCKED`.
- Resolve ambiguity from repository evidence first. For material high-risk
  ambiguity, do not guess. Resolve it through repository evidence or
  clarification; otherwise mark the affected action `BLOCKED`.

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
- File-size budget: 650 LOC production, 2000 LOC test. Exceeding is a review
  blocker.
- Lockfile discipline: use `npm install` (not `npm audit fix` alone) for dependency changes.

### Assumptions and Evidence

Contributor evidence markers:

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
  `{ kind: 'blocked', code: string, reason: string, recovery?: readonly string[] }`.

### No Legacy Compatibility in FlowGuard Source

This rule applies only to FlowGuard-owned source, tests, config, local tooling,
schemas, and APIs while implementing, reviewing, or refactoring this repository.
It MUST NOT enter installed mandates, generated prompts/code, downstream repos,
or runtime agent instructions. FlowGuard MUST NOT reject, rewrite, or remove
legacy patterns in a user's project merely because this repository rule exists.

FlowGuard source MUST implement only the current canonical contract. Do not
introduce or preserve compatibility shims, deprecated aliases, legacy fallbacks,
dual-read/dual-write paths, obsolete-format adapters, read-time synthesis or
normalization for superseded FlowGuard shapes, or migration layers whose only
purpose is to keep obsolete FlowGuard behavior alive.

When a current contract replaces an old FlowGuard contract, remove the old
implementation rather than maintaining both. Unsupported old inputs or formats
must fail explicitly at the current validation or trust boundary instead of
being silently migrated or normalized.

Remove compatibility code encountered on touched or reviewed FlowGuard paths in
the same change, including directly affected call sites, tests, schemas, and docs.
Age is no exemption. Bound cleanup to touched/directly dependent surfaces unless
correctness requires wider removal.

Tests and fixtures MAY represent obsolete inputs when their purpose is to prove
that the current boundary rejects them. Historical documentation MAY describe
removed behavior. Reviewers MUST treat newly introduced or knowingly retained
production compatibility code on the touched FlowGuard surface as a review
blocker.

## Mandatory Changelog and Documentation Consistency

- **Every PR MUST change `CHANGELOG.md` under `[Unreleased]`**, including docs,
  refactors, tests, CI and cleanup. No exemption; describe completed behavior.
- Synchronize ALL impacted docs, examples, help, ADRs, schemas/config, support
  matrices, install/recovery guides and artifacts with code in the same PR.
  Unaffected docs need no cosmetic edits. Manually review semantic drift.
- Run `npm run check:doc-drift` for docs/generated changes and
  `npm run check:pr-documentation` against the PR base for every PR.
  Missing changelog or stale affected docs blocks merge even with green tests.
- [ADR-010](docs/decisions/010-host-neutral-opt-in-governance.md) owns governance
  architecture; [#1169](https://github.com/koeppben23/governed-runtime/issues/1169)
  owns the V2 port. Do not inject contributor rules into ungoverned sessions.

## Canonical Authorities

Before implementation, identify the canonical authority. Change it, not a duplicate.

- State transitions: `src/machine/`
- Module direction policy: `src/architecture/support/module-dependency-policy.ts`
- Test placement/classification: `src/architecture/support/module-classification.ts`
- Canonical serialization: `src/shared/canonical-json.ts`
- Hash/digest primitives: `src/shared/hashing.ts`
- Archive content digest formula: `src/archive/content-digest.ts`
- Actor assurance vocabulary/schema: `src/shared/actor-assurance.ts`
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

- Branch naming and targets are owned by `CONTRIBUTING.md`.
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
