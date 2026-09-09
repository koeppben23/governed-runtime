# FlowGuard Repository Instructions

Act as a senior engineer maintaining FlowGuard. Make the smallest correct,
evidence-backed change and preserve FlowGuard's deterministic, fail-closed
architecture.

These are contributor instructions for work on this repository. They are not
FlowGuard runtime policy.

## 1. Scope Boundary

This file applies to FlowGuard-owned source, tests, configuration, documentation,
schemas, and repository-local tooling in this repository.

Never propagate repository-development rules into the product. In particular:

- Do not copy, render, inject, or derive these rules into installed FlowGuard
  mandates, generated prompts, generated code, downstream repositories, or
  runtime instructions for users' coding agents.
- Do not make FlowGuard reject, rewrite, or remove patterns in a user's project
  merely because this repository forbids those patterns internally.
- Installed product mandates are owned by `src/templates/mandates.ts` and remain
  a separate product contract.

## 2. Instruction Composition

- The root `AGENTS.md` applies repository-wide.
- Nested `AGENTS.md` files may add or specialize rules for their subtree. They
  must not contradict or weaken repository-wide safety, evidence, legacy,
  authority, verification, or Git rules.
- Do not rely on model-specific precedence to resolve conflicting repository
  instructions. If repository instructions appear to conflict, identify the
  conflict and stop before violating either rule.
- Follow the host's system/developer/user instruction hierarchy. If a
  higher-priority instruction requires violating a repository merge rule, do
  not describe the result as repository-compliant or merge-ready.

Normative terms:

- **MUST / MUST NOT**: repository requirement.
- **SHOULD / SHOULD NOT**: default unless concrete repository evidence justifies
  an exception.
- `ASSUMPTION`: plausible but not verified.
- `NOT_VERIFIED`: a relevant verification step was not executed or did not
  establish the claimed result.
- `BLOCKED`: safe completion is impossible with the available evidence or
  capability.

## 3. Required Workflow

For implementation, refactoring, and code review:

1. **Investigate first.** Read the relevant code, tests, schemas, configuration,
   and documentation before making claims or changes. Never speculate about code
   you have not inspected when repository evidence is available.
2. **Define the objective and touched surface.** Keep scope bounded to the user
   request plus work directly required for correctness.
3. **Identify the canonical authority.** Change the authority, not a local copy,
   derived artifact, compatibility shim, or parallel implementation.
4. **Implement the smallest complete solution.** Do not add abstractions,
   fallback paths, configurability, files, or defensive branches for hypothetical
   future requirements.
5. **Remove legacy compatibility on the touched surface.** Apply section 5 before
   considering the change complete.
6. **Verify with evidence.** Run the narrowest meaningful checks, then every
   repository-required check for the touched surface.
7. **Report facts only.** State what changed, which checks actually ran, their
   outcomes, and any remaining `ASSUMPTION`, `NOT_VERIFIED`, or `BLOCKED` item.

For high-risk ambiguity involving policy, state, identity, audit, archive,
persistence, migration, release, CI/supply-chain, or security boundaries: do not
guess. Resolve it from repository evidence or mark the affected action `BLOCKED`.

## 4. Hard Engineering Invariants

- Preserve one canonical authority and SSOT for every concept.
- Do not introduce parallel registries, local enum copies, ad-hoc serializers,
  duplicated policy logic, or inline copies of canonical reason/mandate data.
- Preserve deterministic behavior and fail-closed semantics.
- Do not hide failures with silent fallbacks, swallowed errors, or default-allow
  behavior. Surface failure explicitly.
- Do not weaken tests, thresholds, validation, guards, or schemas to make a
  change pass.
- Tests verify the implementation; do not hard-code production behavior only to
  satisfy specific test cases.
- Do not claim tests, builds, reviews, or runtime behavior passed unless the
  corresponding command or evidence actually established that result.
- Production boundary errors must be typed and carry a `code`; do not introduce
  bare `throw new Error(...)` at persistence, Git, IDP, config, policy, CLI, or
  tool boundaries.
- For blocked tool results use the discriminated form
  `{ kind: 'blocked', code: string, reason: string, recovery?: string }`.
- Production files above 750 LOC and test files above 2000 LOC are merge
  blockers.
- For dependency changes use `npm install`; do not use `npm audit fix` alone.

## 5. No Legacy Compatibility in FlowGuard Source

FlowGuard source implements the current canonical contract only.

**Legacy compatibility code** means production behavior whose purpose is to keep
an obsolete FlowGuard API, schema, field, format, state shape, import path, or
runtime behavior working after a canonical replacement exists. This includes:

- compatibility shims or forwarding aliases;
- deprecated APIs retained for old callers;
- legacy fallbacks or old-format adapters;
- dual-read or dual-write paths for superseded formats;
- read-time synthesis or normalization of obsolete FlowGuard shapes;
- migration layers whose purpose is to preserve obsolete FlowGuard behavior.

Repository rules:

- MUST NOT introduce new legacy compatibility code.
- MUST NOT preserve an old implementation beside its canonical replacement.
- Unsupported obsolete inputs or persisted formats must fail explicitly at the
  current validation or trust boundary instead of being silently migrated,
  normalized, or accepted.
- If you encounter legacy compatibility code in a FlowGuard file or execution
  path you are changing or reviewing, remove it in the same change. Update all
  directly affected callers, schemas, tests, fixtures, and documentation to the
  current authority.
- Do not leave discovered legacy code in place merely because it predates the
  current task. If safe removal cannot be completed, the change is `BLOCKED` or
  `changes_requested`; it is not merge-ready.
- Keep cleanup bounded to the touched and directly dependent FlowGuard surface.
  Widen scope only when required to remove the compatibility path correctly.
- Tests and fixtures may contain obsolete inputs only to prove that current
  boundaries reject them. Historical documentation may describe removed
  behavior. Neither creates a production compatibility path.

Examples:

- **Forbidden:** `export const oldApi = currentApi` retained only so obsolete
  callers still compile.
- **Forbidden:** `oldField ? normalizeLegacy(oldField) : currentField` when
  `oldField` is no longer canonical.
- **Allowed:** a fixture containing an obsolete schema version that is asserted
  to fail with the current validation error.

Reviewers MUST treat newly introduced or knowingly retained legacy compatibility
on the touched FlowGuard production surface as a review blocker.

## 6. Canonical Authorities

Before changing a concept, identify its owner:

- State transitions: `src/machine/`
- Canonical serialization and digests: `src/shared/canonical-json.ts`
- Reason codes: `src/config/reasons.ts`
- Installed FlowGuard mandates: `src/templates/mandates.ts`
- Runtime config schema: `src/config/flowguard-config.ts`

Do not treat generated, rendered, persisted, or compatibility projections as the
source of truth when a canonical authority exists.

## 7. Verification

Run checks after the final relevant change, not before it.

1. Narrowest test that exercises the changed behavior.
2. `npm run check:format` for every change.
3. `npm run check` for TypeScript changes.
4. `npm run lint:strict` for TypeScript changes.
5. `npm run test:architecture` when imports, exports, file placement, canonical
   ownership, or layer boundaries change.
6. Additional checks required by every applicable nested `AGENTS.md`.
7. `npm run build` for distribution changes.
8. `npm run check:unused-dependencies` for dependency or module-surface changes.
9. For high-risk authority, transition, guard, policy, persistence, audit, or
   security-boundary changes: meaningful negative-path verification and
   `npm run mutation`.

Do not broaden or repeat passing verification without a reason. If a relevant
required check cannot run, report it as `NOT_VERIFIED` with the missing
capability or recovery command when known.

## 8. Review Rules

Review falsification-first. Look for incorrect unhappy paths, trust-boundary
violations, SSOT drift, silent fallbacks, retained legacy compatibility,
insufficient negative coverage, and unsupported claims.

A review with a known merge blocker MUST return `changes_requested`, not an
approval with caveats. Findings should state severity, concrete evidence,
impact, and the smallest correct fix.

## 9. Git Rules

- Branches: `fix/<name>`, `feat/<name>`, `chore/<name>`.
- Commits use conventional types: `feat`, `fix`, `docs`, `test`, `refactor`,
  `chore`, `perf`, `ci`.
- Never commit unless explicitly asked.
- Never force-push without explicit instruction. If explicitly required, use
  `--force-with-lease`, never `--force`.

## 10. Scoped Instructions

Apply these nested files when working in their subtree:

- `src/machine/AGENTS.md` — state transitions, guard ordering, invariants.
- `src/config/AGENTS.md` — reason-code registry, policy types, config schema.
- `src/integration/AGENTS.md` — plugin lifecycle, tools, review pipeline.

Use `CONTRIBUTING.md` for PR metadata, commands, module boundaries, and naming
conventions when relevant to the task.
