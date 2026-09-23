# Your First Change

A guided, additive change through the whole loop: owning file, test, placement
rule, and the checks that must pass. The example extends the `flowguard_run_check`
response with one derived field. Nothing here is applied in this repository yet —
follow the steps locally to make it real.

## 1. Goal

Add `remainingCheckCount` to the `flowguard_run_check` response so callers can
read how many active checks still need to pass without inspecting the
`remainingChecks` array length themselves.

## 2. Make the change in the owning file

The response is assembled in
[`src/integration/tools/validation/run-check-presentation.ts`](../../src/integration/tools/validation/run-check-presentation.ts)
by `formatRunCheckResponse`. The data already exists there as `remainingChecks`:

```ts
const remainingChecks = input.finalState.activeChecks.filter(
  (checkId) =>
    !finalValidation.some(
      (result) => result.checkId === checkId && result.passed,
    ),
);
```

Extend the response literal next to `remainingChecks` (the added line is the
last one):

```ts
        derivedRepairGuidance: input.derivedRepairGuidance,
        remainingChecks,
        remainingCheckCount: remainingChecks.length,
```

The tool entry (`run-check-tool.ts`) calls `formatRunCheckResponse` and returns
its value; the function serializes the response itself, so no adapter change is
required.

## 3. Know what you are and are not changing

- **Changed:** the public, host-visible tool response — an additive field. Agents
  that ignore it keep working; agents that read it get the derived count.
- **Not changed:** the persisted `ValidationResult` schema in
  `src/state/evidence-validation.ts`, the session state shape, and the
  `state digest` mirrored in the response (`committedStateDigest` hashes
  `finalState`, not the response object).
- **Why this matters:** response evolution is cheap; authority evolution is not.
  If a field ever needs to outlive the response or bind decisions, it belongs in
  `src/state/` and needs the schema/replay treatment instead.

## 4. Prove it with a deterministic test

The existing case in
[`src/integration/tools/run-check-tool.test.ts`](../../src/integration/tools/run-check-tool.test.ts)
only asserts when exactly one active check exists, so its central assertion can
be skipped. Use an explicit fixture instead (the parallel-checks test in the same
file shows the state-write pattern):

```ts
it('returns the remaining checks and their count', async () => {
  await driveToValidation();
  const sd = await getSessDir();
  const state = await readState(sd);
  await writeState(sd, {
    ...state!,
    activeChecks: ['typecheck', 'lint'],
    verificationCandidates: [
      ...(state!.verificationCandidates ?? []),
      {
        assertionCapability: 'unsupported' as const,
        candidateId: 'vc_lint_first_change',
        kind: 'lint',
        command: 'npm run lint',
        source: 'discovery' as const,
        confidence: 'high' as const,
        reason: 'first-change tutorial fixture',
      },
    ],
    executionSubjectInputsByCandidateId: {
      ...(state!.executionSubjectInputsByCandidateId ?? {}),
      vc_lint_first_change: [{ kind: 'implementation' as const }],
    },
  });

  const result = parseToolResult<RunCheckResult>(
    await run_check.execute({ kind: 'typecheck' }, ctx),
  );

  expect(result.remainingChecks).toEqual(['lint']);
  expect(result.remainingCheckCount).toBe(1);
  expect(result.remainingCheckCount).toBe(result.remainingChecks!.length);
});
```

Also add `remainingCheckCount?: number;` to the test-local `RunCheckResult` type
in the same file (and replace the conditional `remainingChecks` case with this
deterministic one).

## 5. Placement and architecture rules

- No new file is added, so **no placement entry** is required. The file is owned
  by `tools-validation` in
  [`src/architecture/__tests__/integration-placement-policy.ts`](../../src/architecture/__tests__/integration-placement-policy.ts).
- No new import crosses a module boundary, so `npm run test:architecture` is not
  required for this change. Run it if you move files, add imports across
  contexts, or change review zones.
- The tool name and registration surface (`src/integration/tool-names.ts`,
  `src/integration/tools/index.ts`) stay untouched.

## 6. Run the checks

```sh
npx vitest run --project integration src/integration/tools/run-check-tool.test.ts
npm run check:format
npm run check
npm run lint:strict
```

## 7. What a reviewer looks for

- The field is genuinely additive and derived — no schema, state, audit, or
  digest authority changed.
- The test asserts an exact expected value, not a conditional one.
- The response change is documented in the PR's Touched Surface section (tool
  output) without claiming a state-model change.

See the [Developer Architecture Map](./architecture-map.md) for where larger
changes belong, and [CONTRIBUTING.md](../../CONTRIBUTING.md) for the PR contract.
