# Config Layer Contributor Notes

## Authority

`src/config/` is the canonical authority for FlowGuard configuration schemas,
reason codes, and policy type definitions. It defines schemas, not runtime
state.

## Reason Codes

* Reason codes are the canonical structured error catalog. Each code has a
  `messageTemplate`, `recoverySteps`, and optional `quickFixCommand`.
* New reason codes are added in category files (`reasons-precondition.ts`,
  `reasons-validation.ts`, `reasons-infra.ts`, `reasons-validation-review.ts`).
* All codes are re-exported through the barrel at `reasons.ts`.
* After adding or removing a reason code, run the completeness test:

```sh
npx vitest run --project unit src/config/reasons-completeness.test.ts
```

## Config Schema

* `flowguard-config.ts` defines the runtime config schema using Zod.
* Every nested object must have `.default()`.
* `schemaVersion` is the literal `"v1"`.

## Policy Types

* Core policy types are defined in `policy-types.ts`.
* Policy resolution logic is split across `policy-resolver.ts`, `policy-central.ts`,
  `policy-ci.ts`, and `policy-snapshot.ts`.
* Policy must not import from `src/state/`, `src/rails/`, or `src/integration/`.

## Profiles

* Profile definitions live in `profile.ts` and `profile-types.ts`.
* Profile content files are in `profiles/content/`.
* Built-in profiles must never reference `AGENTS.md`.

## Module Boundary

* `src/config/` may import from `src/shared/` and `src/logging/log-level.ts` only.
* `src/config/` must not import from `src/state/`, `src/rails/`, or
  `src/integration/`.
* `src/config/` must not derive runtime state — it defines schemas, not behavior.

## Do Not Introduce

* Parallel registries for reason codes or error categories.
* Local enum copies of canonical types.
* Ad-hoc serializers that duplicate `src/shared/canonical-json.ts`.
* Inline reason or mandate definitions outside the owning barrel.

## Verification

Run these checks for all config-layer changes:

```sh
npm run check
npm run lint:strict
npx vitest run --project unit src/config/
```

For schema changes, also run schema, default-parsing, and version consistency
tests.

For reason-code changes, also run:

```sh
npx vitest run --project unit src/config/reasons-completeness.test.ts src/documentation/__tests__/reasons-doc-drift.test.ts
```
