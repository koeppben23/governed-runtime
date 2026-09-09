# FlowGuard Repository Instructions

Act as a senior engineer maintaining FlowGuard. Make the smallest correct,
evidence-backed change and preserve deterministic, fail-closed behavior.
These are contributor instructions for this repository, not FlowGuard runtime policy.

## Scope
- Applies repository-wide to FlowGuard-owned source, tests, config, docs, schemas,
  and repository-local tooling.
- Never propagate these rules into installed FlowGuard mandates, generated prompts,
  generated code, downstream repositories, or runtime instructions for users' agents.
- Installed product mandates are owned by `src/templates/mandates.ts` and remain a
  separate product contract.
- Root `AGENTS.md` applies everywhere. Nested `AGENTS.md` files may add or specialize
  rules but must not weaken repository-wide safety, evidence, legacy, authority,
  verification, or Git rules.
- If repository instructions conflict, identify the conflict and stop before
  violating either rule.

**MUST / MUST NOT** are requirements; **SHOULD / SHOULD NOT** are defaults unless
repository evidence justifies an exception. `ASSUMPTION` means plausible but
unverified. `NOT_VERIFIED` means a relevant check did not establish the claim.
`BLOCKED` means safe completion is impossible with available evidence/capability.

## Required Workflow
1. Investigate first: read relevant code, tests, schemas, config, and docs. Never
   speculate when repository evidence is available.
2. Define the objective and touched surface. Keep scope to the request plus work
   directly required for correctness.
3. Identify the canonical authority. Change it, not a local copy, projection,
   compatibility shim, or parallel implementation.
4. Implement the smallest complete solution. Do not add abstractions, fallbacks,
   configurability, files, or defensive branches for hypothetical requirements.
5. Remove legacy compatibility on the touched surface per the rule below.
6. Verify with evidence using the narrowest meaningful checks plus all required
   repository checks for the touched surface.
7. Report facts only: changed behavior, checks run, outcomes, and any remaining
   `ASSUMPTION`, `NOT_VERIFIED`, or `BLOCKED` item.

For high-risk ambiguity involving policy, state, identity, audit, archive,
persistence, migration, release, CI/supply-chain, or security boundaries: do not
guess. Resolve it from repository evidence or mark the affected action `BLOCKED`.

## Hard Engineering Invariants
- Preserve one canonical authority and SSOT for every concept.
- No parallel registries, local enum copies, ad-hoc serializers, duplicated policy
  logic, or inline copies of canonical reason/mandate data.
- Preserve deterministic and fail-closed semantics; surface failures explicitly.
  No silent fallback, swallowed error, or default-allow behavior.
- Do not weaken tests, thresholds, validation, guards, or schemas to make a change pass.
- Implement general behavior; never hard-code production logic for specific tests.
- Never claim tests, builds, reviews, or runtime behavior passed without evidence.
- Production boundary errors must be typed and carry a `code`; no new bare
  `throw new Error(...)` at persistence, Git, IDP, config, policy, CLI, or tool boundaries.
- Blocked tool results use
  `{ kind: 'blocked', code: string, reason: string, recovery?: string }`.
- Production files >750 LOC and test files >2000 LOC are merge blockers.
- For dependency changes use `npm install`; do not use `npm audit fix` alone.

## No Legacy Compatibility in FlowGuard Source
FlowGuard source implements the current canonical contract only.
Legacy compatibility code is production behavior whose purpose is to keep an
obsolete FlowGuard API, schema, field, format, state shape, import path, or runtime
behavior working after a canonical replacement exists. This includes compatibility
shims, deprecated aliases, legacy fallbacks, old-format adapters, dual-read/write
paths, read-time normalization of obsolete shapes, and migration layers that
preserve obsolete behavior.

- MUST NOT introduce new legacy compatibility code.
- MUST NOT preserve an old implementation beside its canonical replacement.
- Unsupported obsolete inputs or persisted formats must fail explicitly at the
  current validation/trust boundary instead of being silently migrated or accepted.
- If legacy compatibility code is encountered in a FlowGuard file or execution path
  being changed or reviewed, remove it in the same change and update directly
  affected callers, schemas, tests, fixtures, and docs to the current authority.
- Do not leave discovered legacy code because it predates the task. If safe removal
  cannot be completed, the change is `BLOCKED` or `changes_requested`, not merge-ready.
- Keep cleanup bounded to the touched/directly dependent FlowGuard surface; widen
  scope only when correct removal requires it.
- Tests/fixtures may contain obsolete inputs only to prove current boundaries reject
  them. Historical docs may describe removed behavior.

Forbidden examples: forwarding aliases kept for obsolete callers; branches that
normalize retired fields. Allowed example: a fixture asserting rejection of an
obsolete schema version. Reviewers MUST treat newly introduced or knowingly retained
legacy compatibility on the touched FlowGuard production surface as a blocker.

## Canonical Authorities
- State transitions: `src/machine/`
- Canonical serialization/digests: `src/shared/canonical-json.ts`
- Reason codes: `src/config/reasons.ts`
- Installed FlowGuard mandates: `src/templates/mandates.ts`
- Runtime config schema: `src/config/flowguard-config.ts`
Do not treat generated, rendered, persisted, or compatibility projections as SSOT.

## Verification
1. Narrowest test exercising changed behavior.
2. `npm run check:format` for every change.
3. `npm run check` for TypeScript changes.
4. `npm run lint:strict` for TypeScript changes.
5. `npm run test:architecture` for import/export, placement, canonical ownership,
   or layer-boundary changes.
6. Additional checks required by applicable nested `AGENTS.md` files.
7. `npm run build` for distribution changes.
8. `npm run check:unused-dependencies` for dependency/module-surface changes.
9. For high-risk authority, transition, guard, policy, persistence, audit, or
   security-boundary changes: meaningful negative-path verification and
   `npm run mutation`.
Run checks after the final relevant change. Do not repeat broad passing checks
without reason. If required verification cannot run, report `NOT_VERIFIED` with
missing capability or recovery command when known.

## Review and Git
Review falsification-first: unhappy paths, trust boundaries, SSOT drift, silent
fallbacks, retained legacy compatibility, negative coverage, unsupported claims.
A known merge blocker requires `changes_requested`, not approval with caveats.
- Branches: `fix/<name>`, `feat/<name>`, `chore/<name>`.
- Commit types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `ci`.
- Never commit unless explicitly asked.
- Never force-push without explicit instruction; if required use
  `--force-with-lease`, never `--force`.

## Scoped Instructions
- `src/machine/AGENTS.md` — transitions, guard ordering, invariants.
- `src/config/AGENTS.md` — reason codes, policy types, config schema.
- `src/integration/AGENTS.md` — plugin lifecycle, tools, review pipeline.
- `CONTRIBUTING.md` — PR metadata, commands, module boundaries, naming.
