# Integration Layer Contributor Notes

## Scope

This file adds instructions for files in this directory subtree.

## Authority

`src/integration/` consumes canonical authorities and exposes the runtime-facing
API. It must never become a provider of new authorities for lower layers.

## Module Boundary

- Directions are enforced, not redefined here: the positive authority is
  `src/architecture/__tests__/module-dependency-policy.ts`
  (`MODULE_DEPENDENCY_POLICY`), and changes in this subtree must satisfy
  `npm run test:architecture`.

## Plugin Lifecycle

- Plugin entrypoints live in `plugin.ts` and `plugin-*.ts`. These wire the
  runtime hooks (beforehooks, afterhooks, audit, compaction, discovery-health,
  enforcement-tracking, events, host-task-diagnostics, logging, modules,
  orchestrator, policy, risk, workspace).
- When adding a new hook, register it in the plugin orchestrator and add
  corresponding contract tests.

## Tools

- Tools are the FlowGuard command surface exposed to the host agent. All tools
  live in `src/integration/tools/`.
- New tools must:
  - validate inputs against canonical schemas;
  - route through the state machine before mutating state;
  - return typed results (never bare `throw` at the tool boundary);
  - be registered in the tool index.

## Review Pipeline

- The review pipeline orchestrates independent review obligations through
  `src/integration/review/`.
- Evidence binding, obligation tracking, and findings validation are managed
  by the enforcement subsystem in `src/integration/review/enforcement/`.

## Error Boundaries

At persistence, Git, IDP, config, policy, CLI, and tool boundaries, use typed
errors with a `code` field:

- `PersistenceError`
- `GitError`
- `IdpError`

For blocked tool results, use the discriminated union pattern:

```ts
{ kind: 'blocked', code: string, reason: string, recovery?: string }
```

Never use bare `throw new Error(...)` at these boundaries.

## Test Placement

- Contract tests: `sdk-contract-*.test.ts`, `cli-contract.test.ts`,
  `runtime-flow-e2e-contract.test.ts`, `review-modeb-contract.test.ts`,
  `review/orchestrator-dispatch-authorization.test.ts`,
  `review/durable-dispatch.test.ts`, `review-dispatch-replay-guard.test.ts`,
  `tools/review-tool/structured-evidence-consumption.test.ts`,
  `policy-matrix.test.ts`.
- Real host wire contract: `src/cli/opencode-reviewer-structured-live.test.ts`
  (smoke project; runs in the CI smoke job with the pinned host, locally with
  `OPENCODE_LIVE=1`).
- Use `--project integration` for all runtime-facing behavior that crosses
  module boundaries.

## Additional Verification for This Subtree

Apply the repository-wide verification rules first. In addition:

```sh
npm run check
npm run lint:strict
npm run test:architecture
npx vitest run --project integration
```

For tool changes, also run the owning contract tests.
