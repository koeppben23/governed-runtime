# OpenCode Host Boundary Attack Matrix

Status: first forensic pass, review ledger only. This document records scenarios,
existing test coverage, and findings. It does not fix findings and does not claim
runtime guarantees that are not backed by evidence.

The matrix treats the OpenCode host as an external, adversarial protocol
boundary: the host may drop hooks, redeliver calls, emit different payloads,
upgrade its SDK, run multiple sessions in parallel, or fail mid-call. FlowGuard
internals are already fail-closed; this ledger makes the host edge reviewable.

---

## Purpose

- Define the attack surface between the OpenCode host and the FlowGuard plugin
  (hooks, SDK event union, tool calls, reviewer child sessions, compaction,
  adapter lifecycle).
- Map each scenario to existing evidence or to a gap.
- Keep gaps visible and CI-guarded instead of relying on prose.
- Provide the scenario basis for the next pass: executable real-host contract
  tests and the remediation order in this document.

---

## Scope And Threat Model

In scope:

- `src/integration/plugin.ts` and the `plugin-*.ts` hook handler modules, plus the
  `FlowGuardAuditPlugin` composition root.
- `src/integration/opencode-host-adapter.ts` and the HAI contract in
  `src/adapters/host-adapter.ts`.
- OpenCode SDK contract surfaces consumed by the plugin: `Hooks`, hook payloads,
  the `Event` union, `PluginInput`, agent registry responses.
- `.sdk-baselines/opencode/` and the scripts that maintain it.
- Reviewer child sessions spawned through the host client.

Out of scope (residual risk, not preventable here):

- A malicious host runtime that fabricates tool results, ignores hook throws, or
  rewrites FlowGuard state on disk. This is documented as outside the prevention
  boundary in `docs/trust-boundaries.md`.
- OS-level compromise, filesystem permissions, network isolation.

Assumed adversary: an honest-but-buggy or drifting host. The host may:

- deliver hooks late, out of order, once, never, or with unexpected payloads;
- retry tool calls with the same or new call identities;
- change SDK event names or payload shapes between versions;
- run concurrent sessions and worktrees against one plugin instance;
- abort or delete sessions while a mutation or review is in flight.

Expected FlowGuard posture: fail closed on the governance decision, keep
audit/state consistent with what was observed, and never substitute an
unverified host claim for canonical state.

---

## How To Read The Matrix

Each row states:

- **Scenario / vector** — the host behavior or drift under test.
- **Expected fail-closed behavior** — what must hold.
- **Coverage** — repo-local evidence (`path:line`), or the explicit absence of
  it.
- **Status** — `Covered`, `Partial`, `Gap`, or `Residual`.
- **Finding** — `F-xx` reference into the findings section, or `—`.

References are repo-relative and CI-checked by
`src/documentation/__tests__/opencode-host-boundary-attack-matrix.test.ts`.

---

## Hook Failure Semantics

| ID    | Scenario / vector                                                                       | Expected fail-closed behavior                                                           | Coverage                                                                                                                                       | Status  | Finding |
| ----- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| HS-01 | `tool.execute.before` throws for a denied mutation; the host must not execute the tool. | Thrown enforcement error aborts the host tool call; no mutation occurs.                 | Handler/root block tests: `src/integration/plugin-bootstrap.test.ts:408`, `src/integration/plugin.test.ts:1341`; no real-host execution proof. | Partial | F-08    |
| HS-02 | Malformed before payload (`output`/`input` null, missing identity, non-object).         | Deny with structured enforcement error; never default-allow.                            | `src/integration/plugin.test.ts:1561`, `src/integration/plugin-beforehooks.test.ts:174`, `src/integration/sdk-contract-runtime.test.ts:30`.    | Covered | —       |
| HS-03 | After hook is never delivered (host drop, or process killed between before and after).  | Mutation episode stays unresolved; next mutating tool is blocked until reconciliation.  | `src/integration/mutation-episode-e2e.test.ts:176`, `src/integration/plugin-bootstrap.test.ts:482`.                                            | Partial | F-11    |
| HS-04 | After hook throws.                                                                      | Error surfaces in audit/diagnostics; no silent completion; subsequent mutation blocked. | `src/integration/plugin-enforcement-tracking.test.ts:89`, `src/integration/plugin-bootstrap.test.ts:1096`.                                     | Covered | —       |
| HS-05 | Host tool throws or aborts during execution after the before hook allowed it.           | Failure is audited; no success evidence; recovery path remains.                         | `src/integration/plugin-integration.test.ts:799`, `src/integration/mutation-episode-e2e.test.ts:254`.                                          | Partial | —       |
| HS-06 | Host retries the same tool call (same or new `callID`).                                 | No duplicate evidence or second authority effect; deterministic call identity.          | Deterministic retry and duplicate-callID tests: `src/integration/plugin-shared.test.ts`, `src/integration/plugin-beforehooks.test.ts`.         | Covered | F-11    |
| HS-07 | Duplicate `callID` across before/after (retry, replay, identity confusion).             | Deterministic resolution or fail-closed deny; trace map cannot be poisoned.             | `src/integration/plugin-shared.test.ts` (duplicate callIDs never touch the fallback registry).                                                 | Covered | F-11    |
| HS-08 | Process crashes between before and after.                                               | Same as HS-03: unknown episode on disk; next mutation fails closed.                     | `src/integration/mutation-episode-e2e.test.ts:293`, `src/integration/plugin-bootstrap.test.ts:482`.                                            | Covered | —       |
| HS-09 | After hook arrives for a call the plugin never observed in before.                      | Ignore without corrupting trace state; no evidence fabrication.                         | Foreign after-hook test: `src/integration/plugin-afterhooks-more.test.ts`, `src/integration/plugin-shared.test.ts`.                            | Covered | F-11    |

---

## Tool Surface And Mutation Gates

| ID    | Scenario / vector                                                             | Expected fail-closed behavior                                     | Coverage                                                                                                                                                    | Status  | Finding |
| ----- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| TS-01 | Unknown host tool name.                                                       | Treated as mutating/fail-closed; never implicit read-only.        | `src/integration/phase-tool-gate.test.ts:93`, `src/integration/plugin.test.ts:1420`, `src/integration/tool-classification.test.ts:126`.                     | Covered | —       |
| TS-02 | Custom third-party tool not in the registry.                                  | Governed default-deny unless explicitly allowlisted as read-only. | `src/integration/plugin.test.ts:290`, `src/integration/plugin-integration.test.ts:465`.                                                                     | Covered | —       |
| TS-03 | MCP-prefixed tool (`mcp__...`) at the hook boundary.                          | Same classification and phase gates as native names.              | Classifier parity: `src/integration/phase-tool-gate.test.ts`; reviewer deny-rule smoke: `src/cli/opencode-reviewer-capability.test.ts:82` (smoke project).  | Covered | F-09    |
| TS-04 | `task` tool invoked without reviewer provenance.                              | Blocked before execution.                                         | `src/integration/plugin-beforehooks.test.ts:743`, `src/integration/plugin.test.ts:1371`.                                                                    | Covered | —       |
| TS-05 | `flowguard_*` name spoofing at prefix boundaries (for example `flowguardx_`). | Exact registry match; non-registered names fail closed.           | `src/integration/plugin.test.ts:774`, `src/integration/tool-classification.test.ts:108`.                                                                    | Covered | —       |
| TS-06 | Mutating tool success contract is unrecognized or malformed (`apply_patch`).  | Stays unknown/pending; no silent success evidence.                | `src/integration/mutation-episode-e2e.test.ts:176`, `src/integration/mutation-episode-e2e.test.ts:220`, `src/integration/mutation-episode-e2e.test.ts:254`. | Covered | —       |
| TS-07 | Reviewer child session attempts mutating tools or a nested `task`.            | Denied by installed reviewer agent permissions.                   | Real-host probe: `src/cli/opencode-reviewer-capability.test.ts:57`; now wired into the smoke project (`vitest.config.ts`).                                  | Covered | F-09    |

---

## Session Lifecycle

| ID    | Scenario / vector                                                          | Expected fail-closed behavior                                                                                | Coverage                                                                                                                                                               | Status  | Finding |
| ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| SL-01 | Host emits a session termination event.                                    | Cleanup runs for the terminated session.                                                                     | Canonical union pin + runtime cleanup: `src/integration/sdk-contract-events.test.ts`, `src/integration/plugin-events.test.ts:73`.                                      | Covered | F-02    |
| SL-02 | Termination payload uses `properties.info.id` (SDK `EventSessionDeleted`). | Session id resolves from the real payload.                                                                   | Compile-time `info.id` pin and runtime cleanup: `src/integration/sdk-contract-events.test.ts`; production: `src/integration/plugin-events.ts:31`.                      | Covered | F-02    |
| SL-03 | `session.error` carries an object error (SDK union).                       | Audit captures meaningful error detail without crashing.                                                     | SDK error-union matrix: `src/integration/sdk-contract-events.test.ts`; extraction: `src/integration/plugin-events.ts:120`.                                             | Covered | F-02    |
| SL-04 | Session termination must clear all session-scoped ephemera.                | `activeCommandScopes`, `checkReworkContinuations`, trace ids, and chain state are removed deterministically. | Central `cleanupSessionRuntime`: `src/integration/plugin-shared.ts`; tests: `src/integration/plugin-shared.test.ts`, `src/integration/plugin-afterhooks-more.test.ts`. | Covered | F-06    |
| SL-05 | Session directory disappears between hooks (TOCTOU).                       | Fail closed with a structured error; no state guess.                                                         | `src/integration/plugin-bootstrap.test.ts:688`, `src/integration/plugin-bootstrap.test.ts:707`.                                                                        | Covered | —       |
| SL-06 | Host restarts with stale in-memory state.                                  | Persisted state remains authority; hydrate/status reconstruct from disk.                                     | `src/integration/tools-execute-hydrate.test.ts:229`, `src/integration/session-state-upgrade.test.ts:60`.                                                               | Covered | —       |

---

## Concurrency And Isolation

| ID    | Scenario / vector                                                       | Expected fail-closed behavior                                                        | Coverage                                                                                                                         | Status  | Finding |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| CI-01 | Two sessions in one workspace with interleaved tool calls.              | Session-scoped state and audit separation.                                           | `src/integration/e2e-workflow.test.ts:727`, `src/integration/tools-execute-hydrate.test.ts:918`.                                 | Covered | —       |
| CI-02 | Two plugin instances or worktrees.                                      | No shared mutable state; independent chain state.                                    | `src/integration/plugin.test.ts:766`, `src/integration/plugin-integration.test.ts:819`.                                          | Covered | —       |
| CI-03 | Interleaved sessions A/B on one instance read mutable `getSessionId()`. | No cross-session authority; session id is call-scoped.                               | Mutable session-id state removed from the HAI: `src/adapters/host-adapter.ts`, `src/integration/plugin.ts`; no resolver remains. | Covered | F-07    |
| CI-04 | Parallel calls in one session with distinct `callID`s.                  | Unique decision ids; correct trace correlation.                                      | `src/integration/plugin-integration.test.ts:739`, `src/integration/plugin-beforehooks.test.ts:1511`.                             | Covered | —       |
| CI-05 | Duplicate `callID` concurrently.                                        | No double evidence or double authority; deterministic reject or idempotent handling. | Duplicate-callID determinism: `src/integration/plugin-shared.test.ts`.                                                           | Covered | F-11    |
| CI-06 | Concurrent workspace mutation (lease/fencing).                          | Second writer blocked fail-closed; generations strictly advance.                     | `src/integration/runtime-lease.test.ts:38`, `src/integration/mutation-episode-e2e.test.ts:502`.                                  | Covered | —       |

---

## Compaction

| ID    | Scenario / vector                                             | Expected fail-closed behavior                                          | Coverage                                                                                          | Status  | Finding |
| ----- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------- | ------- |
| CP-01 | Compaction while a review obligation is pending.              | Mandatory pending-obligation context is injected.                      | `src/integration/plugin-compaction.test.ts:97` plus the in-flight review case below.              | Covered | F-12    |
| CP-02 | Compaction hook receives null, throws, or a missing snapshot. | Fail-safe context build; the plugin never crashes.                     | `src/integration/plugin-compaction.test.ts:150`, `src/integration/plugin-compaction.test.ts:194`. | Covered | —       |
| CP-03 | Compaction during an active review attempt or challenge loop. | Attempt and obligation state survive; context never claims completion. | In-flight review compaction case: `src/integration/plugin-compaction.test.ts`.                    | Covered | F-12    |

---

## Plugin And Adapter Lifecycle

| ID    | Scenario / vector                                                         | Expected fail-closed behavior                                               | Coverage                                                                                                                                        | Status  | Finding |
| ----- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| PL-01 | Plugin boot with a broken SDK client (`session.create`/`prompt` missing). | Fail closed before hooks are exposed.                                       | Composition root boot test: `src/integration/plugin.test.ts` (HOST_ADAPTER_INIT_FAILED); adapter unit: `src/adapters/host-adapter.test.ts:153`. | Covered | F-01    |
| PL-02 | Capability mismatch at boot (for example agent registry unavailable).     | Fail closed or enter an explicit degraded mode before governance hooks run. | Composition root boot test: `src/integration/plugin.test.ts` (HOST_CAPABILITY_MISMATCH).                                                        | Covered | F-01    |
| PL-03 | Advertised capabilities versus what is actually probed.                   | Only verified capabilities may be claimed; the rest are marked unverified.  | `runtimeVerified`/`contractAttested` result: `src/adapters/host-adapter.test.ts`, `src/integration/plugin.test.ts`.                             | Covered | F-04    |
| PL-04 | Dispose must shut down the adapter and logging.                           | Composed shutdown; no leaked resources.                                     | Composed dispose (`adapter.shutdown()` + logging): `src/integration/plugin.ts`; dispose test: `src/integration/plugin.test.ts`.                 | Covered | F-01    |
| PL-05 | Plugin reload or repeated init.                                           | No leaked listeners, duplicate state, or stale caches.                      | Repeated init: `src/integration/plugin.test.ts:1672`.                                                                                           | Partial | —       |
| PL-06 | Hook output mutation (`output.args`, `output.output`, `output.context`).  | Single host-adapter authority for host mutation semantics.                  | No-op adapter methods: `src/integration/opencode-host-adapter.ts:159`; hook code mutates references directly.                                   | Gap     | F-04    |

---

## Host Contract Drift

| ID    | Scenario / vector                                                | Expected fail-closed behavior                                                         | Coverage                                                                                                                                              | Status  | Finding |
| ----- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| HD-01 | SDK `Event` union changes (name or variant).                     | The baseline gate covers the actual contract source.                                  | Derived event-contract baseline: `.sdk-baselines/opencode/plugin-event-contract.d.ts`, `scripts/__tests__/sdk-type-snapshot.test.ts`.                 | Covered | F-03    |
| HD-02 | Event payload shape changes (`properties.info`, object `error`). | Compile-time or runtime pin, or a compatibility adapter.                              | Compile-time derivations from `Hooks['event']`: `src/integration/sdk-contract-events.test.ts`; production pin: `src/integration/plugin-events.ts:31`. | Covered | F-02    |
| HD-03 | Plugin `Hooks` surface changes (added or removed hooks).         | Compile-time assertions fail.                                                         | `src/integration/sdk-contract.test.ts:81`, `src/integration/sdk-contract-plugin.test.ts:63`.                                                          | Covered | —       |
| HD-04 | Hook payload runtime shape drift.                                | Runtime schema validation rejects unknown or missing fields.                          | `src/integration/sdk-contract-runtime.test.ts:30`.                                                                                                    | Covered | —       |
| HD-05 | Agent registry contract drift (`opencode debug agent`).          | The real-host probe runs in the default test pipeline.                                | Wired into the smoke project: `vitest.config.ts`; probe: `src/cli/opencode-reviewer-capability.test.ts:19`.                                           | Covered | F-09    |
| HD-06 | Host version outside the tested range.                           | Explicit compatibility matrix; unknown host contract fails closed or warns by policy. | Host-contract matrix: `src/cli/opencode-runtime-compat.test.ts`; doctor detail: `src/cli/install-doctor.test.ts`.                                     | Covered | F-05    |
| HD-07 | Baseline/update scripts regress or are bypassed.                 | CI-enforced tests for snapshot, update, and drift scripts.                            | Script tests: `scripts/__tests__/sdk-type-snapshot.test.ts`; explicit bypass warning: `src/integration/sdk-contract-plugin.test.ts`.                  | Covered | F-10    |

---

## Reviewer Child-Session Lifecycle

| ID    | Scenario / vector                                                | Expected fail-closed behavior                                                 | Coverage                                                                                                                                                    | Status  | Finding |
| ----- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| RC-01 | Reviewer child creation or prompt fails transiently.             | Fresh child per attempt, bounded retry with backoff; no duplicate evidence.   | `src/integration/review/orchestrator-retry-core.test.ts:99`, `src/integration/review/orchestrator-invoke-errors.test.ts:15`.                                | Covered | —       |
| RC-02 | In-flight abort of a reviewer child.                             | Typed aborted outcome; unsupported abort fails closed.                        | Timeout abort tests: `src/integration/review/orchestrator-timeout.test.ts`; fake probe: `src/integration/review/__tests__/parallel-host-probe.test.ts:175`. | Covered | F-13    |
| RC-03 | Reviewer child exceeds its time budget.                          | Deterministic timeout classification; no hang; parent remains resumable.      | Bounded prompt timeout and retry classification: `src/integration/review/orchestrator-timeout.test.ts`.                                                     | Covered | F-13    |
| RC-04 | Parent session is deleted or crashes while the child is running. | No orphan authority; late callbacks from superseded sessions add no evidence. | Best-effort abort: `src/integration/review/orchestrator-timeout.test.ts`; logical coverage: `src/integration/attempt-lifecycle-e2e.test.ts:553`.            | Partial | F-13    |
| RC-05 | Duplicate child binding or stale callback.                       | Second bind refused; no duplicate evidence.                                   | `src/integration/plugin-afterhooks-host-task.test.ts:587`, `src/integration/plugin-task-evidence.test.ts:140`.                                              | Covered | —       |

---

## Positive Controls

These behaviors are intentionally strong and must not be weakened while
addressing findings:

- Unknown tools are governed default-deny, never implicit read-only (TS-01,
  TS-02, TS-05).
- Runtime lease and fencing serialize concurrent workspace mutation (CI-06).
- Mutation episodes keep unknown host outcomes from becoming success evidence
  (HS-03, HS-05, HS-08, TS-06).
- Reviewer provenance, attempt lifecycle, and bounded child concurrency are
  contract-tested (TS-04, RC-01, RC-05).
- The reviewer agent permission surface is verified against the real
  `opencode` binary (once the orphaned test is wired back in, F-09).
- Hook payload runtime shapes are validated with runtime schemas (HD-04).

---

## Findings

Severity reflects blast radius on the governance boundary, not effort.

### F-01 — Host adapter lifecycle is dead code in the composition root

**Severity:** P1. **Status:** Fixed — `initialize()`, `validateCapabilities()`, and `shutdown()` are composed in `src/integration/plugin.ts`; boot tests in `src/integration/plugin.test.ts`. **Scenarios:** PL-01, PL-02, PL-04.

`OpenCodeHostAdapter` implements `initialize()` (fail-closed on a broken SDK
client), `validateCapabilities()`, and `shutdown()`, and
`src/adapters/host-adapter.ts` documents boot-time validation as a lifecycle
invariant. The composition root creates the adapter
(`src/integration/plugin.ts:93`) but never calls `initialize()` or
`validateCapabilities()`; `hooks.dispose` is assigned only `disposeLogging`
(`src/integration/plugin.ts:140`), so `adapter.shutdown()` is never composed.

Impact: boot-time capability validation never runs. An incompatible host is
discovered later, if at all, on a reviewer or SDK path.

Remediation: call `await adapter.initialize()`, then
`validateCapabilities()`, and fail closed with a typed
`HostCapabilityMismatchError` before exposing hooks; compose
`adapter.shutdown()` into `dispose`; add an integration test that drives
`FlowGuardAuditPlugin()` with a broken client and asserts boot failure.

### F-02 — Event contract drift: `session.delete` versus `session.deleted`

**Severity:** P1. **Status:** Fixed — contract pinned in `src/integration/plugin-events.ts`, verified by `src/integration/sdk-contract-events.test.ts`. **Scenarios:** SL-01, SL-02, SL-03, HD-02.

Original defect: production handled `session.delete` and read
`properties.sessionID` (`src/integration/plugin-events.ts:70`,
`src/integration/plugin-events.ts:145`). The pinned SDK 1.18.29 event union
defines `EventSessionDeleted` with `type: "session.deleted"` and
`properties.info: Session` (`id`), and `EventSessionError` with
`properties.error` as an object union
(`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:505`,
`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:518`). Existing
tests replicated the wrong event name and payload shape, so the suite stayed
green while the handler was unreachable.

Impact before the fix: session-scoped cleanup never ran on a real host, and real
session errors lost their error detail (the string coercion produced the
placeholder `unspecified session error`).

Resolution:

- `HANDLED_EVENT_TYPES` and `handleEvent` now match `session.deleted`; the set
  literal is pinned to `Extract<Event, ...>['type']` derived from
  `Hooks['event']`, so an SDK rename fails compilation.
- `session.deleted` resolves the session id from `properties.info.id` and
  ignores missing or non-string ids fail-safe.
- `session.error` extracts `data.message` and `name` from every SDK error union
  member; the error discriminant is recorded as `errorName` in the audit detail.
- `src/integration/sdk-contract-events.test.ts` derives the real event union and
  payload paths from the pinned SDK, exercises the canonical payloads at
  runtime, and asserts that the API command name `session.delete` stays ignored.

The remaining baseline gap (the transitive `Event` surface is still not part of
the snapshot) is tracked as F-03.

### F-03 — SDK baseline does not cover the transitive `Event` contract

**Severity:** P1. **Status:** Fixed — derived event-contract baseline plus script tests. **Scenarios:** HD-01, HD-02.

`scripts/sdk-type-snapshot.mjs:40` snapshots only
`@opencode-ai/plugin/dist/index.d.ts` and `.../tool.d.ts`. Both reference
`Event` transitively from `@opencode-ai/sdk`
(`.sdk-baselines/opencode/plugin-index.d.ts:1`). The SDK package can change the
event union while the plugin declaration file stays byte-identical, so the
baseline stays green while the runtime contract breaks. F-02 is the live
instance of this blind spot.

Remediation: snapshot the SDK event/types surface, or generate a small
machine-readable contract schema (events, payload shapes, hook inputs/outputs,
client methods) and diff that. Keep the schema reviewable instead of dumping
large generated files.

### F-04 — Capability claims exceed what capability validation verifies

**Severity:** P1. **Status:** Partially fixed — verification is now honest (`runtimeVerified` vs `contractAttested`); host mutation still lives in hook code outside the adapter (PL-06). **Scenarios:** PL-03, PL-06.

`OpenCodeHostAdapter.capabilities` claims `preToolBlock`, `argMutation`,
`outputReplacement`, `contextInjection`, `reviewerSpawn`, and
`compactionInjection` (`src/integration/opencode-host-adapter.ts:56`), but
`validateCapabilities()` probes only `client.app.agents()` and can only report
`reviewerSpawn` (`src/integration/opencode-host-adapter.ts:122`). At the same
time `deliverArgMutation` and `mutateToolResult` are no-ops because the hook
code mutates host references directly, so the HAI abstraction does not own
mutation.

Impact: "capability validation" overstates assurance, and the adapter boundary
is leaky: some host semantics live in OpenCode-specific hook code.

Remediation: distinguish statically attested from runtime-probed capabilities,
mark unverified ones explicitly, and either discharge the mutation capabilities
through the adapter or stop claiming them there.

### F-05 — Host compatibility is open-world (deny-list only)

**Severity:** P1/P2. **Status:** Fixed — explicit `verified`/`compatible-unverified`/`known-incompatible` matrix, surfaced by doctor. **Scenarios:** HD-06.

`KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES` is empty by design, unknown runtimes
classify as `not-classified`, and only `known-unsupported` is blocked
(`src/cli/opencode-runtime-compat.ts:60`). The module is honest about this for
instruction-source resolution, but the host hook contract has no equivalent
gate, while the product claims OpenCode "fully supported" enforcement.

Impact: untested host versions can run with claimed synchronous, hook-gated
enforcement.

Remediation: introduce an explicit compatibility matrix (`verified`,
`compatible-unverified`, `known-incompatible`) and decide fail-closed policy
for unknown host contract versions, at least when hook generation changes.

### F-06 — Session cleanup is incomplete

**Severity:** P2. **Status:** Fixed — central `cleanupSessionRuntime`. **Scenarios:** SL-04.

`cleanupSession` is wired to `ws.invalidateChainState(sessionId)` only
(`src/integration/plugin-afterhooks.ts:483`). The runtime also holds
`toolTraceIds`, `activeCommandScopes`, and `checkReworkContinuations`
(`src/integration/plugin.ts:100`), and two of them are unbounded and
semantically relevant.

Impact: terminated sessions leak memory and leave session-scoped semantic state
behind.

Remediation: one `cleanupSessionRuntime(runtime, sessionId)` SSOT that clears
every session-scoped map, called from the termination handler.

### F-07 — Mutable `currentSessionId` is a loaded gun

**Severity:** P2. **Status:** Fixed — mutable session-id state removed from the HAI. **Scenarios:** CI-03.

The adapter resolves the session id from a mutable closure that before and after
hooks both write (`src/integration/plugin.ts:93`,
`src/integration/plugin-beforehooks.ts:72`,
`src/integration/plugin-afterhooks.ts:97`). No current production authority path
calls `adapter.getSessionId()`, so this is not an active bypass.

Impact: any future authority path that reads `getSessionId()` can observe a
different session's id under interleaving.

Remediation: remove `getSessionId()` from the adapter until needed, or pass the
session id per call (or via `AsyncLocalStorage`) instead of shared mutable
state.

### F-08 — No real-host proof that a before-hook throw prevents tool execution

**Severity:** P1. **Status:** Partial — gated real-host E2E added (`src/cli/opencode-host-boundary-live.test.ts`, smoke project); live execution is `NOT_VERIFIED` until run with `OPENCODE_LIVE=1`. **Scenarios:** HS-01.

Blocked-mutation tests assert the throw at handler and composition-root level,
but no test loads the real plugin into OpenCode and proves that a blocked tool
never executes.

Impact: the central synchronous enforcement premise is unverified at the host
boundary.

Remediation: gated real-host E2E: real `opencode` process, installed plugin,
blocked mutation (assert no side effect), allowed mutation (assert side
effect), after-hook observation, session deletion event, and dispose ordering.

### F-09 — Real-host reviewer capability test is orphaned from all vitest projects

**Severity:** P2. **Status:** Fixed — wired into the smoke project. **Scenarios:** TS-03, TS-07, HD-05.

`src/cli/opencode-reviewer-capability.test.ts` spawns the real `opencode` binary
and asserts reviewer agent permissions, but it is excluded from the `unit`
project (`vitest.config.ts:60`) and missing from the `smoke` include list
(`vitest.config.ts:83`), so `test:opencode-reviewer-capabilities` collects zero
tests.

Impact: the strongest real-host assurance test silently never runs in CI.

Remediation: wire the file into a project and add a meta-test that the file
collects at least one test.

### F-10 — Baseline, update, and doc-drift scripts are untested; compatibility bypass is implicit

**Severity:** P2. **Status:** Fixed — script tests plus explicit, logged bypass. **Scenarios:** HD-07.

`scripts/sdk-type-snapshot.mjs`, `scripts/update-opencode-sdk.mjs`,
`scripts/check-opencode-host-drift.mjs`, and `scripts/docs-drift.mjs` have no
test coverage, and `FLOWGUARD_SDK_COMPAT_LATEST=1` skips the byte comparison
(`src/integration/sdk-contract-plugin.test.ts:30`).

Impact: the drift gate can regress or be bypassed without a failing test.

Remediation: fixture-based tests for the compare/update logic and an explicit,
audited bypass path.

### F-11 — Host-tool retry, duplicate `callID`, and foreign after-hook are untested

**Severity:** P2. **Status:** Fixed — deterministic retry/duplicate/foreign tests. **Scenarios:** HS-03, HS-06, HS-07, HS-09, CI-05.

Retry semantics are covered for reviewer attempts but not for host tool calls,
and there is no test for duplicated call identities or an after-hook for an
unknown call.

Impact: double evidence, blocked recovery, or trace-map poisoning could go
unnoticed.

Remediation: deterministic tests that replay before/after pairs with duplicated
and unknown `callID`s, including concurrent duplicates.

### F-12 — Compaction during an in-flight review is untested

**Severity:** P2. **Status:** Fixed — in-flight compaction case added. **Scenarios:** CP-01, CP-03.

Only pending-obligation rendering and degraded snapshot paths are covered; no
test compacts in the middle of an active review attempt or challenge loop.

Impact: a mandatory review obligation could be lost or misrepresented across
compaction.

Remediation: end-to-end test that compacts mid-attempt and asserts the
obligation survives and the context never claims completion.

### F-13 — Reviewer timeout and orphan cleanup are untested

**Severity:** P2. **Status:** Fixed — bounded prompt timeout plus best-effort child abort. **Scenarios:** RC-02, RC-03, RC-04.

Abort is modeled only in a fake probe, there is no functional timeout test, and
orphan handling is logical rather than process-level.

Impact: hangs or orphaned child authority are not covered.

Remediation: timeout/abort tests with deterministic classification, plus a
gated live test where feasible.

---

## Remediation Order

1. F-02 — fix the event contract and add a real-SDK contract test. **Done** (see F-02).
2. F-01 — activate adapter lifecycle in the composition root, compose dispose. **Done**.
3. F-04 — make capability validation honest. **Done for verification levels**; adapter-owned mutation remains open (PL-06).
4. F-03 — extend the baseline to the SDK event/type surface. **Done** (derived event-contract baseline).
5. F-05 — define the host compatibility matrix and policy. **Done** (classification + doctor).
6. F-06 — centralize session-scoped cleanup. **Done**.
7. F-07 — remove mutable session-id state from the adapter. **Done**.
8. F-08 — real-host hook lifecycle E2E. **Gated test added; live run `NOT_VERIFIED`**.
9. F-09 to F-13 — close the executable coverage gaps. **Done** (F-13 orphan cleanup remains logical-only).

---

## Next Passes

- Execute the matrix as executable tests, starting with the real-host hook
  lifecycle E2E (F-08) and the event contract tests (F-02).
- Extend the matrix to the remaining hosts (Claude Code, Codex) once the
  OpenCode slice is closed.
- Re-run this ledger after each remediation and move rows from `Gap` to
  `Covered` with evidence.

## References

- `docs/trust-boundaries.md` — Host Runtime, Plugin, Hook, And MCP Boundary.
- `src/adapters/host-adapter.ts` — HAI contract.
- `src/integration/plugin.ts` — composition root.
- `src/integration/plugin-events.ts` — event handlers.
- `src/integration/opencode-host-adapter.ts` — OpenCode adapter.
- `.sdk-baselines/opencode/` — pinned SDK surfaces.
- `https://opencode.ai/docs/plugins/` — host plugin/hook documentation.
- `https://opencode.ai/docs/commands/` — command frontmatter contract.
- `https://opencode.ai/docs/agents/` — agent permission surface.
