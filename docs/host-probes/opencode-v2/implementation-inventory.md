# OpenCode V2: Phase-01 ownership and simplification inventory

Date: 2026-10-31. Baseline inspected: `f9f694bdf8b25fcf3ff7f879c7bf9f179b971e2c`
on `feat/1169-opencode-v2-port`, PR #1190 against `develop`.

This is a source-inspection inventory, not a host-probe result or a claim that
the production code below has already been simplified. It implements the
pre-port review required by [ADR-010](../../decisions/010-host-neutral-opt-in-governance.md).
The [gate matrix](./phase0-contract-gates.md) remains **NO-GO** for ACTIVE V2.

## Delivery boundary

- One integration branch and PR; no partial merge to `develop`.
- Phase 01 repairs contributor/CI contracts and records current owners and
  concrete removals. Production host/state/reviewer behavior is unchanged.
- Bounded P0 probes may establish feasibility. Security implementation must not
  depend on unresolved operator, preventive-control or provenance assumptions.
- No speculative Cursor/Codex/Claude adapter, alternative relaxed governance
  profile, model/provider allowlist or ProofGraph/ISO redesign.
- Four activation modules are not prescribed. Choose the fewest coherent
  responsibilities after the mechanisms are proven; do not add forwarding layers.

The [revised P0 decision](./p0-feasibility-decision.md) applies the explicit
ADR-010 product-scope correction. Continue V2 adapter porting and simplification
without a second runtime, sandbox, universal provider containment or mandatory
external identity service. Concrete operator-source acceptance and required
reviewer-proof gaps still block their affected implementation paths. The selected
operator source is a host-UI interaction distinguishable from agent/SDK calls;
the actual V2 mechanism remains NOT_VERIFIED. No old probe
becomes PASS; actual product/installed acceptance and release remain NOT_VERIFIED.

## Native entrypoint/client implementation in progress

This section describes the subsequent **work-in-progress implementation**, not the
baseline table below, a completed cutover or installed acceptance. The native
SDK dependencies are pinned to `@opencode/plugin@2.2.4` and
`@opencode/client@2.2.4`.

- `plugin.ts` now default-exports one `Plugin.define({ id, setup })` definition.
  Setup registers tool before/after, session context/compaction and one canonical
  tool transform, then subscribes to native events. There is no callable V1
  factory, returned V1 hook object, wrapper chain or command-origin approval hook.
- Runtime lookup starts with exact native session metadata and its actual
  directory, then delegates to `resolveSessionAuthority`; worktree runtimes are
  lazy and owned by setup. A subsequent session move is re-resolved. Lifecycle
  availability is checked both before and after asynchronous scope resolution.
  Cleanup aborts the subscription, disposes registrations, drains owned hook and
  notification operations, then disposes runtime logging; failures are surfaced.
- `OpenCodeHostAdapter` owns native agent/session/context/interrupt mechanics.
  `OrchestratorClient` now names semantic operations rather than V1 SDK request
  and response envelopes. Agent resolution is per session/location with no
  process-global capability cache. Recovery removes session-list fallback and
  part-id/call-id interchangeability. Native history is passed through, never
  rewritten to synthesize assistant `parentID` or completion provenance.
- Events use native `type/data`; deletion uses `data.sessionID`, and execution
  failure uses structured `error.type/message`. Error diagnostics and nested
  supplementary context are sanitized before raw audit emission. Tool failures
  are wakeups for fresh history reads, not terminal evidence themselves.
- V1 `app.log` envelopes and the `maxOutputTokens` rewrite are removed from
  production. UI logging is an explicit optional sink; the unavailable V2 sink
  is reported. Native host budgeting is untouched; explicit numeric reviewer
  overrides fail until native headroom and final-wire proof exist.

**Unsupported authority/evidence paths remain blocked.** Hydrate cannot create
activation through either a tool hook or its registered executor; caller
arguments do not establish operator UI origin. Reviewer subagent release and
reviewer context requests are blocked. The adapter advertises no review
transport, returns unknown quiescence and refuses unproved release mapping or
serialization execution. Admission, idle, `wait()` and terminal-looking native
responses do not become capture proof. The existing transport-v5 and
`review-assurance.v7` contracts are not advanced or silently normalized.

**Cutover is still incomplete.** Migrated registration, event, agent-resolution,
completion-reading, watchdog, budgeting and logging tests exercise mocked native
boundaries/semantic ports, not the installed host. Other V1 root-plugin and
capture fixtures, SDK contract tests/baselines/tooling and the old SDK dependency
remain unported; full typecheck/lint/regression verification is not green.
Native rich completion content is currently rejected explicitly rather than
silently flattened or dropped. This is an unresolved native-behavior surface,
not proof of INACTIVE parity. Installer/lifecycle, operator UI attribution and
complete reviewer assurance remain separate, unmet acceptance boundaries.
Historical probe/evidence bytes are unchanged. No V2 support, merge readiness or
complete simplification is claimed.

## Baseline control flow and required simplification

Paths in this section are relative to the repository root. The table describes
the current baseline, its directly dependent surfaces and the required final
cutover, not a permanently supported V1/V2 dual path.

| Path / owner                                                                                                                                                  | Current dependency and authority                                                                                                                                                                                        | Final action and proof                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integration/plugin.ts`                                                                                                                                   | Composition creates workspace/logger/adapter, registers V1 hooks and then wraps them for output budgets, watchdog and capture. `plugin-orchestrator.ts` is a type surface, not another registrar.                       | Replace the factory with one V2 lifecycle composition and explicit handler ordering. Remove hook-object wrapping rather than wrapping it again. Cover setup failure, disposal, reload and fence-before-effect order in plugin contracts and installed-host tests.                                                                                         |
| `src/integration/plugin-reviewer-capture.ts`, `plugin-events.ts`, `types.ts`                                                                                  | V1 hook/event shapes and nested callbacks feed capture and recovery.                                                                                                                                                    | Translate exact V2 events at the host boundary once; keep authoritative IDs intact and refuse ambiguous ACTIVE events. Remove V1 SDK imports and callback assumptions. Test delayed/duplicate/missing events.                                                                                                                                             |
| `src/adapters/host-adapter.ts`, `src/integration/opencode-host-adapter.ts`                                                                                    | HAI closes platform and review-transport vocabularies; adapter advertises static booleans and contract-attested capabilities. Argument/result/compaction methods are no-op wrappers around direct hook mutations.       | Remove no-op abstraction methods; express demonstrated semantic capabilities, scoped by build/surface/path and evidence. Keep host mechanics in the adapter. A separate minimal test adapter must satisfy the same assurance contract. Never union weak transports into fictional assurance.                                                              |
| `src/shared/hosts.ts`, `src/cli/host-resolver.ts`, `platform-trust-report.ts`                                                                                 | Shared host selection and CLI support reporting coexist with the HAI's inline host union.                                                                                                                               | Keep one owner for identities and distinguish adapter extensibility from actually certified product support. Do not add a second host/capability registry or promote an unknown adapter to supported.                                                                                                                                                     |
| `src/adapters/session-authority.ts`                                                                                                                           | Canonical session-location pipeline resolves Git root/fingerprint, reads state and validates binding. `absent` describes missing workflow state, not durable activation history.                                        | Preserve this path authority. Supply actual per-session host location and distinguish verified INACTIVE from unavailable/formerly ACTIVE activation. No caller may derive a competing authoritative session path. Test corruption, deletion, foreign binding and TOCTOU.                                                                                  |
| `src/integration/plugin-workspace.ts`, `plugin-shared.ts`, `runtime-lease.ts`                                                                                 | Workspace delegates authority using plugin-load worktree and keeps chain/enforcement/queue caches. Factory forwards a class API. Runtime maps retain command scopes and failures.                                       | Replace plugin-global location authority with exact session scope; review class/factory indirection and duplicated lookups before retaining them. Runtime caches must not become durable activation/capacity authority. Preserve lease ownership and crash-safe outbox behavior.                                                                          |
| `src/integration/plugin-beforehooks.ts`, `phase-tool-gate.ts`, `tool-classification.ts`                                                                       | Host mutations without workflow state hit `SESSION_DIR_NOT_FOUND`; command hook can clear capacity lock and populate human intent. Several enforcement helpers re-read authority or collapse failed resolution to null. | Resolve activation before governance; verified INACTIVE passes through, ambiguous formerly ACTIVE blocks. Remove null-as-authority and command-origin assumptions, not safety checks. Reuse phase/policy/mutation decisions without duplicate state machines. Test no effect on denial and no inactive veto.                                              |
| `src/integration/user-decision-intent.ts`, `tools/decision/decision-tool.ts`, `installed-commands.ts`                                                         | A process-local TTL intent is populated from V1 command hooks; `/start` is catalogued as a hydrate alias. Decision tools additionally use canonical actor/policy gates.                                                 | Separate start from hydrate. Prove the selected host-UI source distinction before acceptance; bind source/action/scope/generation with replay protection and canonical actor/policy/audit checks. SDK/CLI/API callbacks alone are inadmissible; no external auth service is mandatory. Recovery/end require explicit UI decisions, not automatic release. |
| `src/integration/tools/hydrate/hydrate.ts`, `src/rails/hydrate.ts`                                                                                            | Tool owns workspace setup and locked revalidation; rail owns workflow hydration. An absent session currently enters a create path.                                                                                      | Restrict direct hydrate to existing governed scope; trusted start orchestrates initial activation/hydration without granting authority to model-supplied arguments. Preserve terminal read-only reload and lock/TOCTOU contracts.                                                                                                                         |
| `src/integration/tools/index.ts`, `helpers.ts`, `src/templates/wrappers/index.ts`                                                                             | Command catalogue exports host-discovered V1 tool objects through a separate installed tool wrapper; helpers document V1 passthrough shapes.                                                                            | Register tools from the existing surface with V2 transforms. Remove obsolete tool-file discovery and V1 DTO assumptions; derive host schemas from canonical validation rather than writing another tool/schema catalogue. Preserve all direct tools and typed blocked results.                                                                            |
| `src/integration/review/types.ts`, `review/dispatch/native-task-review*.ts`, `durable-dispatch.ts`                                                            | Structural client types still mirror V1 SDK mechanics. Native Task path authorizes frozen obligation/attempt/dispatch and binds the child.                                                                              | Replace host-mechanical client shapes with minimal semantic ports where actually consumed. Move concrete V2 transport wiring out of host-neutral decisions, preserving one dispatch and binding authority. Test child reuse, caller model overrides, background execution and cross-session callbacks.                                                    |
| `src/integration/review/dispatch/structured-followup.ts`, `reviewer-task-completion.ts`, `src/integration/reviewer-capture.ts`                                | Follow-up expects completed V1 prompt response, exact response parentID and one observed serialization step. Capture/reconciliation use V1 context and terminal records.                                                | Replace those assumptions with a proven V2 admission-to-terminal chain. Never synthesize parentID or choose latest response by timestamp/text. Keep one same-child, tool-free capture and bounded semantic-preserving repair. Test stale answers, concurrency, late tools, missing history, length continuations and forced final steps.                  |
| `src/integration/reviewer-output-cap.ts`, `reviewer-execution-watchdog.ts`, `reviewer-execution-failure.ts`, related failure persisters                       | Reviewer-only cap/watchdog failures feed durable closure and retained capture fences.                                                                                                                                   | Remove obsolete V1 budget workarounds; preserve native model-aware V2 budgeting and all selected reasoning variants. Keep unknown outcomes fenced, original causes, blocked obligations, stale attempts and durable capacity lock; no timer-only unlock or automatic second child.                                                                        |
| `src/state/review-message-capture.ts`, `evidence-review-invocation.ts`, `evidence-primitives.ts`, `evidence-review.ts`                                        | Transport v5 uses V1-shaped message proof; assurance state independently uses `review-assurance.v7`. Current core transport vocabulary names native Task.                                                               | Define a new current transport-proof generation only after provenance is proven. Separate transport mechanism from semantic assurance, update directly dependent validators, fixtures and recorders, and reject superseded formats explicitly. Do not conflate transport and state versions.                                                              |
| `src/integration/review/obligations/assurance.ts`, `review/enforcement/`, `review/validation/`, `review/evidence/`, `review/observations/`                    | Existing obligation, frozen subject, invocation, observations, challenge and digest authorities gate binding; some consumers explicitly require the V1 transport discriminator.                                         | Update affected consumers to the proven current assurance contract, not a parallel evidence pipeline. Preserve offered refs, observation identity, frozen revision, challenges, findings hash and atomic audit/state binding. Re-run consumption, negative and mutation contracts.                                                                        |
| `src/integration/audit-outbox.ts`, `plugin-audit*.ts`, `plugin-mutation-episodes.ts`, `plugin-mutation-reconciliation.ts`                                     | Existing write/outbox/dispatch paths persist intent, reconcile audit and detect host mutation outcomes.                                                                                                                 | Extend existing authorities only where activation/evidence integration requires it. No independent audit chain or silently discarded pending intent. Test replay, audit-write failure, missing after-hook and restart.                                                                                                                                    |
| `src/cli/install-steps.ts`, `install-json.ts`, `install-helpers.ts`, `install-types.ts`, `doctor-command.ts`                                                  | Installer writes global mandate instruction sources, V1 tool/plugin wrappers and task permission shaping. Reviewer tuning uses a fixed OpenCode effort list/frontmatter.                                                | Remove always-on FlowGuard instructions and global permission rewrites for OpenCode. Install one V2 plugin and native model/variant selection; preserve unrelated customer files/settings. Use explicit archive/fresh-install recovery, not migration shims or silent audit deletion. Test install/uninstall/rollback ownership and no-start parity.      |
| `src/cli/opencode-runtime-compat.ts`, `opencode-runtime-detect.ts`, `opencode-live-host.ts`, `.sdk-baselines/opencode/`, host/SDK drift scripts and workflows | V1 pins, instruction-presence classification, CLI package/launching and wire fixtures define current support/testing.                                                                                                   | Replace one baseline at cutover; report actual installed Desktop/backend/CLI artifacts independently. Unknown mandatory capabilities block governance, not native inactive work. No V1 fallback or same-user external process containment claim.                                                                                                          |
| `src/templates/mandates.ts`, `commands/start.ts`, `commands/hydrate.ts`, `commands/shared-review-loop.ts`, `src/rendering/mandates-renderer.ts`               | Mandate owner and renderer/hash guards ship V1 activation/reviewer instructions through installer and command templates.                                                                                                | Scope mandates to verified ACTIVE sessions and authorized descendants, including compaction. Update content, renderer contracts and hashes together; no contributor-only legacy rule in downstream prompts. Check end-of-governance context remnants.                                                                                                     |
| `demos/java-task-manager/run-live-matrix.mjs`, `live-host-export.mjs`, `verify-evidence-package.mjs`, `demos/lib/host-config.mjs`, `review-continuation.mjs`  | Real-host demo harness binds installed artifacts, workflow outcomes, transcript formats, export and ISO projection.                                                                                                     | Port only actual host/config/export dependencies. Do not fabricate operator approval to automate headless runs. Re-prove Java/ProofGraph/audit/export/inspect and existing ISO projection without redesigning their authorities.                                                                                                                          |

## Trust boundaries before security implementation

Apply revised ADR-010: trusted host/OS infrastructure, untrusted model/caller
assertions, governance/evidence integrity and scoped controlled-path prevention.
These are authority questions and claim limits, not requirements to deploy a new
authentication service or OS isolation boundary.

| Actor / trusted component                  | Required treatment and blocking question                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model, parent agent, child and tool caller | Text, arguments, SDK prompts and supplied IDs are not governance authority. Prove the selected distinguishable host-UI source; never infer human origin from an agent/SDK callback or accept it as a substitute.                                                           |
| Other process with the same OS user/rights | Do not assume a file permission, local CLI, environment token, loopback endpoint or host API credential separates it from the agent. Specify whether protection against it is required and prove an independent boundary if claimed. No such protection is certified here. |
| Provider                                   | Replies are data, not provenance. Validate required execution/capture evidence; report autonomous remote effects outside interception as a prevention limit, not a universal-containment prerequisite or model/provider ban.                                               |
| Host and plugin runtime                    | Host-stamped identity relies on an explicitly trusted host build/runtime. A compromised host cannot independently attest its own honesty. If a claimed guarantee includes host compromise, obtain an independent authority or mark it unsupported.                         |
| External resources and sibling sessions    | Session identity is not exclusive resource ownership. Without a demonstrated host/OS boundary, record external/shared-worktree prevention as NOT_SUPPORTED and prove freshness invalidation separately.                                                                    |

Before authority-bearing acceptance, prove the selected host-UI distinction and record
trust assumptions, action/scope/generation/replay binding and residual risks.
Unverified high-risk source mechanisms or provenance block their affected paths,
not unrelated adapter simplification. Reuse existing identity/actor assurance;
authentication alone does not prove human intent. No new independent security
platform is authorized by this inventory.

## Lifecycle, evidence and final-candidate obligations

- **P0-02-H:** prove host mechanisms. **G-04/P0-02-P:** prove actual product
  transactions, durable authority and recovery. **G-05:** repeat on installed
  product artifacts and both host surfaces. Do not certify future code in P0.
- `EndGovernance` must account for pending work and old mandates in history,
  compaction and in-flight context. Removing an instruction source is not a
  context reset. Require a new session unless adequate reset is actually proven;
  never relabel the governed transcript or lose its audit.
- Keep archived bytes/digests unchanged. Test historical package integrity
  separately from current review authorization. Unsupported old state/transport
  shapes fail explicitly, without normalization or fabricated V2 proof; an intact
  old archive is not automatically valid current evidence or tampered data.
- Freeze subjects and reuse existing ProofGraph, audit, approval and archive
  authority. No unrelated rewrite. Capture failure cannot mint equivalent proof.
- Final acceptance must name current `develop`, merge-candidate SHA and installed
  artifact hashes; rerun affected checks after any relevant base/code/artifact
  change. Green older commits do not certify the final candidate.

## Reviewable simplification evidence

The final PR must compare this baseline to the actual final structure: removed
modules/dependencies/branches/registries, consolidated decisions, eliminated
duplicate lookups and DTO hops, import direction and justified remaining
complexity. LOC alone or arbitrary file splitting does not establish improvement.
Production simplification is **NOT_IMPLEMENTED** at this Phase-01 checkpoint.

### First implemented preparatory simplification (#1169)

The later branch checkpoint removes the three no-op HAI delivery methods
(`deliverArgMutation`, `mutateToolResult`, `injectCompactionContext`), their unused
`ToolResultMutation` DTO and the `createOpenCodeHostAdapter` forwarding factory.
The plugin constructs its concrete adapter directly. No production caller used
the removed methods; actual hook mutation, block delivery, initialization,
capability/reviewer checks and cleanup are unchanged. The live HAI baseline and
negative contract tests reject the removed surface; no compatibility aliases or
fallback paths remain for it.

This is actual but **partial** code simplification, not the complete V2 adapter,
installer or lifecycle port. Remaining V1 APIs, pins, closed capability/transport
contracts and installed product behavior still require the final breaking
cutover; no V2 support or operator/reviewer acceptance is certified here.

### Hook composition simplification (#1169)

`plugin.ts` now constructs reviewer services before registering handlers and
explicitly orders capture, governance and watchdog calls in one registration
site. The output-cap/watchdog attachment functions and the separate
`plugin-reviewer-capture.ts` wrapper module are removed, including its placement
entry. Before: handlers were repeatedly captured and replaced by three attachment
passes. After: no hook replacement or wrapper chain; the same canonical handlers,
exact identities and failure/terminal predicates remain in use. The capture
fence still precedes all tool handling, including downstream denial; failure
never becomes a successful completion, and idle/terminal reconciliation remains
non-blocking to avoid abort/event deadlock.

Composition-order contract tests covered positive and failing paths at that
checkpoint. It did not establish V2 hook registration, new reviewer proof or
lifecycle-disposal acceptance. The subsequent native-entrypoint working tree is
described above; installer and installed-host cutover remain open.

## Phase-01 impact matrix

| Changed contract                           | Owner / implementation                                                                | Verification and documentation                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root instruction budget                    | `AGENTS.md`; semantic rules retained, prose condensed                                 | `agents-v3.test.ts`, `check:agent-instructions`; no budget increase                                                                                                                            |
| Mandatory Unreleased entry                 | `scripts/check-pr-documentation.mjs` compares committed content at PR merge base/head | `scripts/check-pr-documentation.test.ts`: real Git revisions, dirty tree, advanced base, historical/empty/deletion/format-only negatives; CONTRIBUTING, project-governance and issue templates |
| Blocking documentation drift               | `.github/workflows/ci.yml` includes `doc-drift` in required `ci-gate`                 | `scripts/ci-gate.test.ts` executes the workflow's gate shell for success/failure/cancelled/skipped/missing results; branch-protection and testing-strategy docs                                |
| PR/issue contract and changelog categories | `.github/PULL_REQUEST_TEMPLATE.md`, issue templates, `CHANGELOG.md`                   | `project-governance.test.ts`, `changelog-unreleased.test.ts`; no reinstated exemption                                                                                                          |
| Feasibility/product distinction            | Gate matrix and this bounded inventory                                                | Documentation/link checks and semantic review; no new runtime security result                                                                                                                  |

The mutation-reconciliation concurrency test also receives an explicit two-reader
barrier: `Promise.all` alone did not guarantee both authority reads preceded the
first commit. The test retains exactly-once audit, concurrent read and subsequent
no-repeat-query assertions; production mutation code is unchanged. Verify with
the owning integration suite and full coverage.

Executed check outcomes are reported with the implementation commit in PR #1190.
Any unrun host/P0/installed-artifact checks remain **NOT_VERIFIED**. This document
does not replace ADR-010, canonical schemas, tests, or runtime enforcement.
