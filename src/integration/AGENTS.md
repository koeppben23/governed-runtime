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
- Production placement is enforced by the positive authority
  `src/architecture/__tests__/integration-placement-policy.ts`: every
  production file has exactly one owner/zone entry and zero placement debt. A
  new file requires an explicit placement entry in the same change.

## Plugin Lifecycle

- Plugin entrypoints live in `plugin.ts` and `plugin-*.ts`. `plugin.ts` owns the
  composition (`createFlowGuardPluginHooks`) and registers the runtime hooks
  (beforehooks, afterhooks, audit, compaction, discovery-health,
  enforcement-tracking, events, host-task-diagnostics, logging, modules, policy,
  risk, workspace). `plugin-orchestrator.ts` is only the shared
  `OrchestratorDeps` type surface and registers nothing.
- When adding a new hook, wire it in `plugin.ts` (`createFlowGuardPluginHooks`)
  and add corresponding contract tests.

## Tools

- Tools are the FlowGuard command surface exposed to the host agent. The tool
  layer lives in `src/integration/tools/`:
  - `index.ts` is the command surface composition point and the only external
    production entry into the tool layer;
  - command files live in per-command contexts (`plan/`, `architecture/`,
    `implementation/`, `validation/`, `status/`, `hydrate/`, `challenge/`,
    `decision/`, `simple/`, `contract/`, `mutation/`, `observe/`,
    `review-tool/`);
  - cross-command infrastructure stays at the tools root.
- Command contexts orchestrate and project only; they must not become a new
  domain authority. Production outside `tools/**` must not deep-import a
  command context.
- New tools must:
  - validate inputs against canonical schemas;
  - route through the state machine before mutating state;
  - return typed results (never bare `throw` at the tool boundary);
  - be registered in the tool index.

## Review Pipeline

- The review pipeline orchestrates independent review obligations through
  `src/integration/review/`.
- Review findings/evidence validation authority lives in `review/`; tool
  adapters call it, not the other way around.
- `review/` may import ONLY `review/**`, integration root authorities, and the
  frozen lower layers (`adapters`, `config`, `shared`, `state`, `templates`).
  Plugin composition, host/runtime wiring, `tools/**`, sibling integration
  contexts (`status/`, `discovery/`, `proofgraph/`, ...), and other
  top-level layers are enforced violations (`dependency-rules.test.ts`).
  Non-frozen authorities are consumed through injected structural ports:
  `review/context/discovery-port.ts` (drift/health), `review/review-logger-port.ts`
  (diagnostics), the convergence predicate in
  `review/obligations/review-loop-progress.ts`, and
  `ReviewerProofGraphAuthorities` in `review/context/proof-context.ts`
  (gate + renderer); `onFlowGuardToolAfter` receives the machine
  `isTerminalPhase` predicate.
- Review ownership is zoned: `dispatch/`, `obligations/`, `context/`,
  `observations/`, `evidence/`, `validation/`, `prompting/`, and the existing
  `enforcement/`. `review/index.ts` is the public facade and is never imported
  by production code; subzones have no barrels. The placement authority freezes
  each file's zone and growth budget, and
  `architecture/__tests__/review-zone-policy.ts` freezes the allowed zone graph
  (`observed == declared`).
- Evidence binding, obligation tracking, and findings validation are managed
  by the enforcement subsystem in `src/integration/review/enforcement/`.
- `plugin-helpers.ts` is plugin composition. The pure blocked/enforcement
  result utilities live in the root authority `blocked-result.ts`; `review/`
  consumes those instead of the plugin boundary.
- Advisory Discovery input is injected into `review/` through
  `review/context/discovery-port.ts`; `review/` never imports a discovery
  module.

## Error Boundaries

At persistence, Git, IDP, config, policy, CLI, and tool boundaries, use typed
errors with a `code` field:

- `PersistenceError`
- `GitError`
- `IdpError`

For blocked tool results, use the discriminated union pattern:

```ts
{ kind: 'blocked', code: string, reason: string, recovery?: readonly string[] }
```

Never use bare `throw new Error(...)` at these boundaries.

## Test Placement

- Contract tests: `sdk-contract-*.test.ts`, `cli-contract.test.ts`,
  `runtime-flow-e2e-contract.test.ts`, `review-modeb-contract.test.ts`,
  `review/dispatch/durable-dispatch.test.ts`,
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
