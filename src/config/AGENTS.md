# Config Layer Contributor Notes

## Scope

This file adds instructions for files in this directory subtree.

## Authority

`src/config/` is the canonical authority for FlowGuard configuration schemas,
reason codes, and the policy API surface. Executable policy shapes are authored
as Zod schemas in `src/state/evidence-policy.ts` (they are part of
`PolicySnapshot`); config re-exports their inferred types. It defines schemas,
not runtime state.

## Reason Codes

- Reason codes are the canonical structured error catalog. Each code has a
  `messageTemplate`, `recoverySteps`, and optional `quickFixCommand`.
- New reason codes are added in category files (`reasons-precondition.ts`,
  `reasons-validation.ts`, `reasons-infra.ts`, `reasons-validation-review.ts`).
- All codes are re-exported through the barrel at `reasons.ts`.
- After adding or removing a reason code, run the completeness test:

```sh
npx vitest run --project unit src/config/reasons-completeness.test.ts
```

## Config Schema

- `flowguard-config.ts` defines the runtime config schema using Zod.
- Every nested object must have `.default()`.
- `schemaVersion` is the literal `"v1"`.

## Policy Types

- Executable policy shapes (`AuditPolicy`, `TimestampAssurancePolicy`,
  `ChallengePolicy`, `ReviewBudget`, `DiscoveryHealthPolicy`,
  `ValidationEvidencePolicy`) are authored once as Zod schemas in
  `state/evidence-policy.ts`; `policy-types.ts` re-exports the inferred types
  and derives the mode vocabularies from them. Do not re-declare a shape here.
  The exported types are the deep-readonly, exact-optional projection of the
  inferred shapes; do not widen them with casts, and pin the contract in
  `architecture/__tests__/policy-snapshot-parity.test.ts` (P5).
- `CHALLENGE_POLICY_VERSION` is owned by `state/evidence-policy.ts` and
  re-exported through `policy-types.ts`/`policy.ts`. Do not re-declare the
  literal.
- Policy resolution logic is split across `policy-resolver.ts`, `policy-central.ts`,
  `policy-ci.ts`, and `policy-snapshot.ts`.
- `PolicySnapshot` parity: every executable `FlowGuardPolicy` field must be
  frozen by `createPolicySnapshot()` and reconstructed by
  `resolvePolicyFromSnapshot()`; optional executable fields follow the same rule
  with absence as the frozen semantic. Enforced by compile-time `keyof`
  coverage assertions (`architecture/__tests__/policy-snapshot-parity.test.ts`)
  and the strict round-trip contract (`policy-snapshot.test.ts`). Do not hide a
  parity mismatch with a cast — fix the authority.

## Profiles

- Profile definitions live in `profile.ts` and `profile-types.ts`.
- Profile content files are in `profiles/content/`.
- Built-in profiles must never reference `AGENTS.md`.

## Module Boundary

- Top-level module directions are owned exclusively by
  `src/architecture/__tests__/module-dependency-policy.ts`
  (`MODULE_DEPENDENCY_POLICY`). Changes in this subtree must comply with that
  policy and pass `npm run test:architecture`.
- Subtree-specific: `src/config/` must not derive runtime state — it defines
  schemas, not behavior.

## Do Not Introduce

- Parallel registries for reason codes or error categories.
- Local enum copies of canonical types.
- Ad-hoc serializers that duplicate `src/shared/canonical-json.ts`.
- Inline reason or mandate definitions outside the owning barrel.

## Additional Verification for This Subtree

Apply the repository-wide verification rules first. In addition:

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
