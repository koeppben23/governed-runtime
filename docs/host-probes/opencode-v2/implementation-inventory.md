# OpenCode V2: Phase-01 ownership and simplification inventory

Date: 2026-10-31. Baseline inspected: `f9f694bdf8b25fcf3ff7f879c7bf9f179b971e2c`
on `feat/1169-opencode-v2-port`, PR #1190 against `develop`.

This is a source-inspection inventory, not a host-probe result or a claim that
the production code below has already been simplified. It implements the
pre-port review required by [ADR-010](../../decisions/010-host-neutral-opt-in-governance.md).
The [gate matrix](./phase0-contract-gates.md) remains **NO-GO** for ACTIVE V2.

**2026-11-01 implementation update:** the activation/scope implementation now
precedes workflow authority and uses one canonical journal, enrollment markers
and lifecycle guards. Native catalogue filtering, scoped event fences and exact
ordinary-subagent receipt enrollment replace the reviewed defects in Findings
2–4/8. The current contract and verification limits are in
[Activation and scope](./activation-scope-contract.md). Older dated snapshots
below describe their inspected commits, not the current implementation. Root
operator decisions and complete reviewer provenance remain blocked;
PR #1190 stays Draft and ACTIVE V2 remains NO-GO.

**Finding 7 follow-up:** the [version-bound native edit-error contract](./edit-error-terminality.md)
now connects exact regular local failures to the existing completion writer and
preserves the runtime identity across actual plugin reload. The two retained MUT4
positives and a real delegated-child regression exercise the product hooks with
explicit component-only activation, not UI authority. Earlier dated descriptions
of the unobserved error stub and failed MUT4 runs below remain historical results.

## Delivery boundary

**Finding 6 mechanism checkpoint (2026-11-02):** the
[native reviewer transport prerequisite](./reviewer-transport-mechanism.md) records
five real-host mechanism positives and corrects component activation/native call
identity in the four required product fixtures. Those four contracts failed at
that historical mechanism checkpoint.
The subsequent [step-2 dispatch port](./reviewer-dispatch-authority.md) connects
the canonical ledger to native release and observed Child binding, and the
[step-3 capture port](./reviewer-capture-evidence.md) adds the V6 same-child
terminal/evidence generation. At `2acef049`, three of the four required product
contracts passed and recovery failed. The independent review verified all four
contracts plus independent-review-e2e in CI at `b9a41e5b`. The local follow-up
adds native SIGKILL/reload and settlement crash positives; complete native race,
R4 and reviewer-parity acceptance remain open (see the current
[subcontract matrix](./phase0-contract-gates.md#p0-05--p0-08-evidence-breakdown-2026-11-03)). Controlled foreground/same-child
execution is not evidence binding or safe unknown-outcome recovery. No historical
test result, policy exception or proof generation is reclassified.

- **2026-11-02 parity correction:** [ADR-010](../../decisions/010-host-neutral-opt-in-governance.md#explicit-parity-and-autonomous-activation-amendment-2026-11-02)
  requires interactive and explicitly authorized autonomous activation, preserving
  V1 capabilities and governance guarantees. Human approvals remain policy-dependent;
  the UI-source gap is not a blanket autonomous-start prohibition. Both activation
  implementations remain open. Finding 6 requires fully automatable independent AI
  review with unchanged assurance and only existing policy exceptions, not a new
  optional-review or human-substitution workaround. No runtime acceptance follows
  from this specification change.
- **2026-11-03 native command channel:** [ADR-010](../../decisions/010-host-neutral-opt-in-governance.md#native-command-channel-amendment-2026-11-03)
  withdraws the distinguishable-UI requirement for OpenCode. Operator decisions use
  the native command channel, recorded as `host_command` with the canonically
  resolved actor and never as a verified human. Interactive `/start` is connected;
  autonomous activation and the other operator decisions remain open.
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
reviewer-proof gaps still block their affected implementation paths. Human-source
proof is required for actual human decisions; autonomous activation needs its own
canonical authorization, not human relabelling. Both actual V2 mechanisms remain
NOT_VERIFIED. No old probe
becomes PASS; actual product/installed acceptance and release remain NOT_VERIFIED.

## Native entrypoint/client implementation in progress

This section describes the subsequent native API implementation and local
verification, not the baseline table below, a completed product cutover or
installed acceptance. The native
SDK dependencies are pinned to `@opencode/plugin@2.2.4` and
`@opencode/client@2.2.4`.

- `plugin.ts` now default-exports one `Plugin.define({ id, setup })` definition.
  Setup registers tool before/after, session context/compaction and one canonical
  tool transform, then subscribes to native events. There is no callable V1
  factory, returned V1 hook object, wrapper chain or command-origin approval hook.
- Runtime lookup first resolves activation, then exact native session metadata
  and delegates ACTIVE workflow lookup to `resolveSessionAuthority`; worktree runtimes are
  lazy and owned by setup. Moving an ACTIVE session outside its enrolled directory is blocked. Lifecycle
  availability is checked both before and after asynchronous scope resolution.
  Cleanup aborts the subscription, disposes registrations, drains owned hook and
  notification operations, then disposes runtime logging; failures are surfaced.
- Read-only after-hook diagnostics recheck activation, then use only an already
  scoped runtime, preserving native rich content without loading workflow authority. This cache grants no
  before-hook, mutation, approval or completion authority: those paths retain
  fresh scope resolution. Unmatched reads neither create runtimes nor state.
- `OpenCodeHostAdapter` owns native agent/session/context/interrupt mechanics.
  `OrchestratorClient` now names semantic operations rather than V1 SDK request
  and response envelopes. The HAI itself is reduced to the invoked ports
  (`initialize`, `shutdown`, `getSession`, `readHistory`, `log`); static platform,
  capability, enforcement-level, reviewer-support and transport tables are not
  adapter authority. Agent resolution is per session/location with no
  process-global capability cache. Recovery removes session-list fallback and
  part-id/call-id interchangeability. Native history is passed through, never
  rewritten to synthesize assistant `parentID` or completion provenance.
- Events use native `type/data`; deletion uses `data.sessionID`, and execution
  failure uses structured `error.type/message`. Error diagnostics and nested
  supplementary context are sanitized before raw audit emission. Tool failures
  are wakeups for fresh history reads, not terminal evidence themselves.
- V1 `app.log` envelopes and the `maxOutputTokens` rewrite are removed from
  production. UI logging is an explicit optional sink; the unavailable V2 sink
  is reported. Native host budgeting is untouched; the former
  `reviewer.outputTokenMax` key is removed and rejected (2026-11-02).

**Unsupported authority/evidence paths remain blocked.** Hydrate cannot create
activation through either a tool hook or its registered executor; caller
arguments do not establish operator UI origin. Reviewer subagent release and
reviewer context requests are blocked. The adapter advertises no review
transport, returns unknown quiescence and refuses unproved release mapping or
serialization execution. Admission, idle, `wait()` and terminal-looking native
responses do not become capture proof. The existing transport-v5 and
`review-assurance.v7` contracts are not advanced or silently normalized.

**API cutover versus acceptance.** Root/bootstrap/mutation/recovery suites now
use native registrations, id/input/result and type/data notifications. Canonical
schema binding, challenge repair, durable closure, budgets and quarantine use
explicit semantic-port/domain fixtures, not replayed V1 callbacks presented as
V2 provenance. The old SDK dependency, bootable client factory and active V1
declaration baselines are removed. Snapshot/update tooling pins native packages,
raw event/message contracts and plugin registrations; candidate checks have no
baseline bypass or silent unknown metadata. The updater does not modify host
support constants or host/docs provenance. Old-generation host/docs baselines and
installed smoke infrastructure are retained only pending their separate port,
not as V2 certification.

Native rich content is preserved for read-only tools. Authoritative rich
completions project exactly one text part through the canonical application
pipeline while retaining native attachments, ordering and other result fields;
text-free or multiple-text results are rejected rather than guessed or flattened.
Unproved regular edit-error history cannot close a mutation episode: old
message/part formats are not accepted and native errors alone do not establish
regular terminality. Successful intercepted completion and canonical fenced
recovery tests remain separate. Neither this conservative failure behavior nor
API/domain checks establish INACTIVE parity. Installer/lifecycle, operator UI
attribution and complete reviewer assurance remain unmet acceptance boundaries.
Full required regression and mutation outcomes must be recorded for the final
candidate, not inferred from focused suites or a preceding WIP commit.
Historical probe/evidence bytes are unchanged. No V2 support, merge readiness or
complete simplification is claimed.

### Local API-step verification (not installed acceptance)

The uncommitted implementation on the same integration branch was checked with:

- `npm test`: 12,466 passed, with the same two existing skips; no new exclusions.
- `npm run test:scripts`: 305 passed. SDK contracts: 195 passed; architecture:
  538 passed (the latter two are also included in their owning regression projects).
- `npm run check`, `npm run lint:strict`, `npm run check:format`,
  `npm run check:doc-drift` (including build), unused-dependency and exact SDK
  baseline checks passed. The built native definition imports successfully.
- The bounded `npm run mutation -- --mutate
'src/integration/plugin.ts,src/integration/host-mutation-observation.ts,src/integration/review/dispatch/structured-followup.ts'
--concurrency 8` run passed at 85.71%, with the unchanged 80% breaking threshold:
  `plugin.ts` 84.44%, structured follow-up 91.67%; the unsupported error-observation
  stub has no scorable mutants. Its three production-source snapshots match the
  current working tree exactly. This is not a full-repository mutation result.

The first bounded mutation run failed at 74.17%; executor, capability, metadata,
cleanup and native-result tests were strengthened rather than lowering the gate.
A concurrent regression run exceeded the existing workflow performance budget;
the final full regression without the mutation load passed the unchanged budget.
Historical probe files and retained host/docs provenance are unchanged.

These local checks complete the API/test/tooling step, not CI certification of a
new commit or the current-`develop` merge candidate. Operator UI attribution,
reviewer completion/capture and quiescence, regular native edit-error observation,
installer/lifecycle and installed Desktop/CLI INACTIVE parity remain unverified.

### CI follow-up to the published API step

[CI run 41241094244](https://github.com/koeppben23/governed-runtime/actions/runs/41241094244)
tests head `99b9c218428779fca3811bb0201ebcf3df3d24d5` on merge candidate
`632e98f57f6a01becded8a9d3b6ffa8240ed7310`. Its observed failures include
`actionlint`, `unused-exports`, `smoke` and `independent-review-e2e`; this is not
green installed acceptance.

The follow-up fixes the SDK-update workflow's ShellCheck SC2016 quoting with a
quoted JavaScript heredoc. Tests execute the actual workflow shell for a valid
Unreleased entry and reject a missing current Changed heading without editing
historical entries. Dead reviewer factories, an unused task predicate, telemetry
bootstrap and test scaffolding are removed; internally used dispatch helpers
remain private. No unused-export baseline, warning suppression, test exclusion
or coverage threshold changes are used.

The other failures expose unfinished installed-host migration, not just stale
test titles:

- `ci.yml` still installs the historical `opencode-ai@1.19.5` host; mutation and
  capture fixtures still call a V1 plugin factory. Those cannot load the native
  `Plugin.define` product. Retained host/docs provenance is not V2 certification.
- Output-cap smoke tests still demand the removed V1 65K rewrite. Native V2
  budgeting and explicit-cap rejection must be verified against an actually
  loaded native plugin, not a V1 host which ignores it.
- The independent-review verifier requires positive release and binding tests
  which the native root cannot currently satisfy. It also uses V1 config/API
  mechanics for its installed-runtime stage. Renaming the required tests to
  domain-fixture positives or fail-closed negatives would conceal missing proof.
- Native reviewer dispatch now requires the canonical ledger and observed Child;
  the [step-3 capture port](./reviewer-capture-evidence.md) adds the V6
  terminal/evidence generation and three passing product contracts. The native
  after-hook still treats unknown/interrupted outcomes as blocked, the adapter
  advertises no unknown quiescence, and native regular edit-error observations
  remain unobserved. Safe recovery therefore remains **BLOCKED** until its actual
  provenance contract is established. Distinguishable operator-UI attribution
  independently remains **NOT_VERIFIED**.

Local follow-up regression passed 12,466 tests with the same two existing skips;
the CI coverage command passed at 90.24% statements, 83.27% branches, 95.15%
functions and 91.75% lines. Actionlint, unchanged unused-export comparison,
typecheck, strict lint, format, build/doc drift, unused dependencies, 307 script
tests and 538 architecture tests passed. A local rerun of
`npm run test:independent-review-e2e` still fails on the two missing positive
contracts before installed-runtime verification. These checks do not close
either installed acceptance failure or establish certification of a new
published candidate.

## Native installer/lifecycle checkpoint (published as `1750b6b1`)

The installer now writes one native default-export directory at
`plugins/flowguard/index.ts`; `Plugin.define.setup` remains the only tool/hook
registration owner. The V1 tool wrapper and installer config merge/removal paths
are removed. Customer OpenCode JSON/JSONC remains byte-identical across install,
current-format reinstall and uninstall. The managed mandate file is passive:
installation registers no global instruction, build-agent permission rule or
governance activation.

Installer provenance now accepts only ownership manifest format 2. Obsolete
FlowGuard discovery files, explicit global mandate registrations and duplicate
configured plugins fail before writes, even with `--force`; archival/fresh-install
recovery preserves historical evidence bytes. The installer rechecks this
boundary immediately before artifact writes. This is installer provenance, not
a new runtime activation/approval authority. Reviewer frontmatter uses V2 ordered
permissions and native `provider/model#variant` selection without a variant
allowlist. The removed OpenCode effort-env translation is explicitly rejected.

An actual local macOS CLI **2.2.4** smoke installed a freshly packed artifact
with checksum verification and real dependency installation, then observed
exactly one active product plugin, reloaded it, resolved its reviewer definition,
uninstalled via the installed CLI and reloaded to an absent plugin. There was no
workspace-linked product, V1 factory or fabricated reviewer evidence. The first
two harness runs failed because `plugin.list` observes only currently activated
locations: native registry reads are required again after reload. The corrected
test exercises that native lifecycle explicitly, including after uninstall;
empty lazy catalogues are not accepted as proof of cleanup. Customer config
remained byte-identical, and catalogue/setup activity created no FlowGuard
workspace state in the isolated config root.

This proves bounded installed CLI discovery/reload/uninstall, **not complete
INACTIVE parity or lifecycle acceptance**. No native mutation/model workflow,
Desktop, all in-flight cleanup/restart behavior or Java acceptance is certified.
The canonical session authority still has no durable distinction between a
never-activated session and missing formerly ACTIVE state. Adding an installer
flag, treating `absent` as permission or creating a second activation registry
would not repair that boundary. Operator-UI provenance and full reviewer
assurance/recovery independently remain unverified; the Draft PR remains NO-GO.

### Final local installer verification (2026-11-01)

The following checks ran locally before publication. Their implementation was
subsequently committed and pushed as
`1750b6b1e31d08a979a4e12932d9d0d5f3c2fd23` on the same integration branch.
The earlier present-tense “local and uncommitted” wording was a stale pre-push
description, not the current publication state. Local outcomes alone do not
certify CI or a current-`develop` merge result. The subsequent
[published-source/CI/artifact verification](./2026-11-01-1750b6b1-checkpoint/README.md)
records the exact head, CI merge/tree identity, artifact digests and failing jobs.
Final review also tightened two failure paths: current provenance belonging to
another host/scope blocks installation before artifact writes, and package
write/unlink failures during uninstall are surfaced rather than misclassified as
malformed JSON. Failed package I/O restoration retains the ownership manifest for
recovery; uninstall is not claimed to be atomic.

- `npm test`: 696 files passed, **12,513 tests passed**, two existing skips.
  This non-instrumented run completed without concurrent mutation/coverage load;
  no performance budget was relaxed.
- `npm run test:coverage:ci`: 12,504 passed, 11 skipped, with the runner's existing
  coverage-safe PERF policy. Statements **90.41%**, branches **83.43%**, functions
  **95.29%**, lines **91.91%**; all unchanged 80% gates passed. These skips are
  separate from the non-instrumented run, not new test exclusions.
- `npm run mutation -- stryker.native-install.config.mjs --concurrency 4`:
  **98.17%**, covering `install-helpers.ts` (97.69%) and `install-ownership.ts`
  (99.00%). The final isolated run killed 268 mutants, left five survivors,
  had no uncovered mutants or timeouts, and reported 152 compile errors.
  Both report source snapshots match the final production files byte-for-byte.
  The focused configuration inherits the repository's existing mutator exclusions
  and unchanged 80% breaking threshold; it is not a full-repository mutation run.
  The first scored run failed at 67.62%; file-error, provenance, tuning and
  symlink negatives were strengthened and redundant branches removed, not gates
  lowered. An initial broad run was cancelled after source edits; an unsupported
  CLI config override also failed before the valid focused run.
- The final rebuilt artifact passed
  `OPENCODE_LIVE=1 npx vitest run --project smoke src/cli/opencode-native-install.smoke.test.ts`:
  one real installed native CLI lifecycle test, using private host 2.2.4,
  isolated config/data, packed dependencies and checksum verification. No shared
  service restart or operator configuration change was used.
- `npm run check`, `npm run lint:strict`, `npm run check:format`,
  `npm run check:doc-drift` (including build), unused dependencies and unchanged
  unused-export comparison passed. Architecture passed 538 tests and scripts
  passed 307. The owning integration envelope suite's 29 tests passed; the
  final full regression also covers config and integration obligations.
- `npm run check:pr-documentation -- origin/develop HEAD` passed for the existing
  committed PR head; the same canonical validator also passed against the local
  working-tree changelog and that PR merge base. The commit-based check for a new
  installer commit was subsequently run against `1750b6b1` and passed before its
  push. Affected documentation was reviewed semantically. Neither result proves
  runtime acceptance.

**Remaining acceptance:** complete installed INACTIVE mutation/model parity,
Desktop, all in-flight/restart behavior and Java workflow are NOT_VERIFIED.
Distinguishable operator-UI provenance remains BLOCKED. Reviewer
release/child/request/terminal/model/effort/same-child uncontaminated capture and
joint recovery quiescence remain NOT_VERIFIED; regular native edit-error history
still cannot safely close mutation episodes. The mandatory live smoke and
independent-review verifier retain unresolved V1 harness assumptions and required
positive contracts; this bounded smoke does not replace them. Re-run
`npm run test:smoke` and `npm run test:independent-review-e2e` only as their
actual native acceptance infrastructure is completed, without removing those
contracts. Historical host/docs baselines and dated probe bytes remain unchanged.
The final local `npm run test:independent-review-e2e` rerun failed explicitly on
the two missing/pending positive contracts, before installed-runtime validation:
“leaves the review-required output pending and authorizes the native Task before
release” and “records bound same-child evidence and fulfills the obligation”.
PR #1190 remains Draft. The installer checkpoint was committed and pushed;
no merge or supported ACTIVE V2 release is claimed.

## Native CI harness follow-up (2026-11-01)

This follow-up repairs test infrastructure, not the blocked ACTIVE governance
contracts. The native CLI test candidate lives separately in
`.sdk-baselines/opencode/cli-candidate.json`; historical `host-version.json`,
`docs-hashes.json` and dated evidence bytes are unchanged. CI installs
`@opencode/cli@2.2.4` and checks the exact `opencode v2.2.4` output. Explicit
`OPENCODE_CLI` overrides cannot silently select another host.

One test-only fixture starts a private native server and deterministic provider.
The actual product default export loads once; separate observers use native
registrations without wrapping the product or adding its tools a second time.
The former production-class host resolver is now correctly named
`src/cli/opencode-live-host-test-helpers.ts`, excluded from distribution by the
existing test-support classification. The production-program guard explicitly
checks both native helpers remain test-only. No coverage exclusion registry,
timeout, threshold or required positive title is weakened.

Evals now materialize canonical native templates and reject obsolete FlowGuard
registration while preserving customer config bytes. Doctor smoke distinguishes
obsolete-registration errors from native warning-only configuration. Native
capability tests exercise actual executor denials and the allowed observation
fixture. Wire tests distinguish inbox admission from completed history and never
synthesize an assistant `parentID`. Budget tests observe explicit native provider
body values and unchanged ordinary parent defaults, not the removed V1 65K cap.

Coverage CI limits competing instrumented workers to two while retaining both
complete projects, the 80% gates and the 15-second budget. The original compiler
graph test took 884 ms in the isolated non-coverage reproduction; this scheduling
mitigation is not a claim that the hosted runner's root cause is fully proven.

The independent-review verifier still requires the two original positive titles.
They now execute actual native product tests rather than disappearing from the
root plugin suite. Packed installation, native command/tool inventory, reload
and uninstall run through the existing installed lifecycle smoke. Synthetic
reports test only the verifier's rejection of absent, skipped, duplicate or
failing results; they are not product provenance. The serialization tool-denial
and interrupted-capture recovery contracts also remain mandatory.

Actual native host mutation mechanics distinguish a regular throwing edit from
an interrupted execution and show that shell return does not imply descendant
quiescence. They do not close a product mutation episode. The full native smoke
run still exposes genuine failures at reviewer recovery and regular-error
recovery: capture/evidence generation 6 is connected and three required contracts
pass, but unknown-outcome recovery and `observeEditFailure()` remain unobserved. These tests are not
replaced by successful negative guards or skipped to obtain green CI.

**BLOCKED:** exact authorized parent-call/child/request/model/terminal/capture
provenance and safe error-history/restart settlement remain unestablished.
Operator-UI attribution, complete INACTIVE parity, Desktop and end-to-end export
acceptance are unchanged. PR #1190 remains Draft and ACTIVE V2 **NO-GO**.

Local verification of this infrastructure follow-up (Node 22.22.2):

- Full CI coverage command: **12,513 passed**, 11 existing coverage-mode skips;
  **90.42% statements / 83.45% branches / 95.31% functions / 91.92% lines**.
  The real production-program guard remained in scope and did not time out.
- Evals: **104 passed**. Scripts: **318 passed**. Architecture: **538 passed**.
- Typecheck, strict lint, full format check, build/doc drift, ESM imports,
  unchanged unused-export baseline, unused dependencies and actionlint passed.
- The packed native lifecycle test passed with actual command/tool inventories;
  the full native smoke and mandatory independent-review verifier remain failing
  at the product reviewer/capture and recovery contracts described above.
- **NOT_VERIFIED:** these local results are not a green GitHub run for the new
  commit. Re-run CI on its published head before claiming hosted-runner repair.

The exact CI smoke environment additionally enabled ACP and exposed an old
process-test defect: ignored stdin caused EOF shutdown, and an assertion thrown
inside a timer callback left the returned Promise unsettled. That diagnostic run
was stopped, not counted as passed. ACP now uses the exact native pin and private
global paths, holds input open, rejects premature exits and observes actual
closure after termination. Its process-lifecycle tests do not claim ACP protocol
or governance acceptance.

The rerun with both CI flags (`FLOWGUARD_OPENCODE_HOST_E2E=1` and
`RUN_OPENCODE_ACP_TESTS=1`) completed: **103 passed, 6 failed, no skips**. All
three ACP tests and the packed native lifecycle test passed. The six failures are
the four actual reviewer/capture/recovery contracts and the two MUT4 regular-error
recovery paths; they remain product acceptance blockers, not harness-version
errors.

## Activation-boundary prerequisite observations (2026-11-01)

Findings 2–4 and 8 remain one activation/scope implementation task. Before
implementing a new trust boundary, the native fixture
`src/cli/opencode-authority-primitives.smoke.test.ts` tests actual pinned 2.2.4
mechanisms without loading FlowGuard or minting authority:

- **Session log is not a complete-history authority by default.** A newly created
  session returns only `log.synced` at sequence 0; two SDK metadata updates,
  including deletion of a caller's marker, return only `log.synced` at sequence 2.
  Reload preserves that result. Explicit `after: 0` also failed the exploratory
  complete-history assertion. No returned payload proves what happened before
  the watermark. The [pinned bus source](https://github.com/anomalyco/opencode/blob/v2.2.4/packages/core/src/bus.ts)
  defaults `persist` to false, and its
  [session-log tests](https://github.com/anomalyco/opencode/blob/v2.2.4/packages/core/test/session-log.test.ts)
  explicitly enable persistence for replay tests. The failed initial mechanism
  hypothesis is rejected, not normalized into verified nonactivation. This
  optional mechanism test is not a replacement for an activation positive.
- **Private plugin storage is durable but not implicitly scope-bound.** The same
  committed JSON survives native location reload, owned-server graceful restart
  and idle-server SIGKILL/restart. A second location using the same plugin ID reads the first
  location's value. The
  [plugin host](https://github.com/anomalyco/opencode/blob/v2.2.4/packages/core/src/plugin/host.ts)
  namespaces storage by plugin ID, not by location; the
  [KV implementation](https://github.com/anomalyco/opencode/blob/v2.2.4/packages/core/src/kv.ts)
  uses the host database, returns undefined for absent keys and propagates read
  failures. Individual writes are upserts; the API does not supply a compare-and-set
  or multi-key transaction. These facts do not prove an enrollment/generation
  transaction, safe initialization after lost authority, or safe concurrent
  read/modify/write. No new activation schema assumes them.
- **A concrete CLI keyboard-source distinction exists at the local TUI callback.**
  The real pinned TUI is driven through a POSIX PTY, not a mocked `run()` callback.
  Programmatic dispatch produces `{ name: 'command', ctrl: false, sequence: '' }`,
  even when supplied control-G as its input string. Contrary to the declaration's
  no-event wording, an event object is present. Actual control-G produces
  `{ name: 'g', ctrl: true, sequence: '\u0007' }` and no caller input. An SDK
  command using the UI slash name is rejected; SDK prompt text with an `origin`
  claim/fake event does not invoke the UI callback. The
  [pinned keymap source](https://github.com/anomalyco/opencode/blob/v2.2.4/packages/tui/src/context/keymap.tsx)
  routes named command dispatch through the keymap. This is a bounded local
  callback distinction, not person identity, remote API origin authentication or
  an accepted FlowGuard decision. Transferring caller-supplied event properties
  through ordinary RPC would not preserve this distinction.

All three probes pass locally on macOS, Node 22.22.2 and native OpenCode 2.2.4.
The fixture owns and closes its real UI/server processes and provider. Its
restart helper reconnects to the new owned server address rather than reusing
an old listener. These are source-mechanism observations, not packed-product,
Desktop or Windows acceptance. Reproduce with `OPENCODE_LIVE=1 npx vitest run
--project smoke src/cli/opencode-authority-primitives.smoke.test.ts` (Python 3
and a POSIX PTY are needed for the real TUI arm).

**Authority acceptance remains BLOCKED at the unresolved transitions.** The
UI-callback-to-canonical-decision handoff, exact server/session/worktree binding,
durable enrollment/generation commit, partial-write/restart/loss handling and
explicit deactivation are not implemented/proven by these probes. Existing
workflow state is still not activation proof; missing workflow state is still
not verified INACTIVE. Native subagent authorization must consume that same
authority before phase/reviewer enforcement. No production gate, tool catalogue,
event-failure fence, decision producer or evidence generation changes here.

The exact-head [CI run 41309804873](https://github.com/koeppben23/governed-runtime/actions/runs/41309804873)
for `2ae371282463b8632db9e45f4555a62c6b688142` is now available: Windows verifier,
critical Windows and all three host-OS install/install-verify jobs passed. Overall
CI failed. Coverage reports 12,534 passed / 4 failed / 11 existing skips: the three
known opt-in assertions plus a 15-second production-build-boundary test timeout.
The timeout is not diagnosed as a PR-caused regression and its budget is not
raised. Smoke/reviewer failures remain acceptance blockers. No installer work or
general architecture replacement is introduced by the new mechanism probes.

Local checks for this test-only follow-up pass: typecheck, strict lint, format,
build/doc drift, unused dependencies, unchanged unused-export comparison and
538 architecture assertions. Full coverage and repository mutation are not
rerun for this test-only step (`npm run test:coverage:ci`, `npm run mutation`);
they are not claimed green. Hosted CI for its eventual published head, the
Desktop/Windows UI mechanism and actual accepted activation/decision transactions
remain **NOT_VERIFIED**. Existing required product assertions remain in place.
The full smoke suite with both host/ACP CI flags executes **106 passed / 11
failed / no skips**. All three new primitive probes pass; the same five INACTIVE,
four reviewer/capture and two edit-recovery assertions remain failing. No
required acceptance title or product positive is replaced by these probes.

## Uninstall data-preservation follow-up

Finding 9 is reproduced with real filesystem install/uninstall fixtures: the
old recursive cleanup removed later-added foreign binary sentinels. Package
declaration provenance does not inventory mutable dependency contents. Cleanup
now preserves nonempty `node_modules` trees (including `@flowguard/core` contents)
and reports the unproven ownership; it only removes an empty directory with
atomic `rmdir`. It neither follows root symlinks nor swallows unexpected I/O
errors. There is no new inventory schema or ownership assumption. The packed
native lifecycle test also checks later-added foreign bytes and plugin removal.
This does not repair activation, operator/reviewer provenance or edit recovery.

The first whole-`uninstall-command.ts` mutation run measured **66.09%** and failed
the unchanged 80% breaking threshold. Its survivors prompted additional real
filesystem ownership regressions for customer package shells, dependency
declarations, native managed-file preservation and surfaced I/O errors; the
existing non-creating Codex uninstall suite is additionally selected. No
threshold is lowered and no additional exclusions or narrower production scope
are used to obtain a pass.
This bounded installer run is not a V2-governance mutation certificate.

The repeated whole-file run passed at **86.52%** (199 killed, 27 surviving,
4 uncovered, 103 compile-error and 138 inherited-ignored mutants). It used
`npm run mutation -- stryker.native-install.config.mjs --mutate
'src/cli/uninstall-command.ts' --concurrency 4` with the unchanged 80% break
threshold. The remaining mutants are not claimed eliminated. Local verification
also passed **784 CLI unit tests**, **538 architecture tests**, all **9 verifier
regression tests**, typecheck, strict lint, format, unused dependencies and
build/doc drift. The packed native lifecycle passes with binary sentinels at the
dependency root, inside `@flowguard/core` and a nested foreign package; after
uninstall/reload the product is absent and customer config is unchanged. Required
acceptance test titles are unchanged. **NOT_VERIFIED:** full-repository mutation,
renewed full coverage and hosted CI on the resulting commit; run the full
`npm run mutation`, `npm run test:coverage:ci` and required CI jobs for those
claims. The existing P0 integration and reviewer/recovery smoke failures are not
repaired by this change.

**Finding 8 remains open, not repaired by this installer change.** The current
`task` exemption in `phase-tool-gate.ts` and native `subagent` dispatch in
`plugin.ts` disagree. Simply replacing the exemption would also remove the
call from `isMutatingHostTool`-driven integrity, reconciliation and dispatch
checks in `plugin-beforehooks.ts`. The old `nativeReviewTaskBefore` transport is
not connected there; verdict enforcement is not generic subagent enforcement.
The native reviewer denial must remain, and ordinary native dispatch needs the
same activation/enrollment owner as Findings 2–4, not an alias to V1 task shapes
or an unexplained read-only exemption. The mocked forwarding test is not a
positive phase-gate or installed-subagent acceptance result.

Stand reconciliation: [CI run 41305885459](https://github.com/koeppben23/governed-runtime/actions/runs/41305885459)
on `2a2abe170d24218a296ace7b8cc18103fc55eac7` completed with both
`scripts-windows` and `critical-windows` successful. The shell-free verifier and
unchanged Windows p99 gate are therefore positively verified on that head, not
merely local assumptions. The overall run failed; PR #1190 remains Draft/NO-GO.

## Lead-architect findings against published `46671919`

The review adds confirmed defects, not additional product requirements. These
findings supersede any reading of the bounded lifecycle result as INACTIVE parity.

- **P1 / Windows verifier:** CI run `41288765542`, job `124795530365`, reports
  `'records' is not recognized` and nine failing verifier tests. Windows command
  shell parsing split the required-title regex at `|`. The fix uses Node plus
  the local Vitest manifest's declared CLI with `shell: false`; regression
  fixtures check the complete filter and use metacharacter-containing paths with
  no executable lookup through PATH. Required positives are unchanged.
- **P0 / activation boundary:** `src/adapters/session-authority.ts` is the
  canonical workflow-location/binding authority, **not an activation authority**.
  The current source has no implemented durable activation generation, enrollment
  or deactivation/recovery contract. `plugin.ts` applies workflow gates to ordinary
  native tools before a verified INACTIVE/ACTIVE/BLOCKED distinction. Existing
  absent-state/non-Git component denials therefore demonstrate a contract
  violation, not passing INACTIVE safety. This is **BLOCKED**, not merely unrun
  parity testing; the additional packed-host side-effect comparison is still
  **NOT_VERIFIED**.
- **P1 / event-failure scope:** the global `eventFailed` fence precedes activation
  resolution and can veto unrelated ungoverned callbacks. Event-stream failure
  must remain explicit, but the governance fence needs the same activation owner
  as ordinary hooks, not a second status machine or a worktree-wide opt-in flag.
- **P1 / catalogue:** setup currently publishes every FlowGuard tool before start.
  The installed inventory observation confirms that deviation. Effective provider
  wire parity still needs its own comparison; raw registry presence and actual
  model exposure are distinct observations. The pinned tool-transform API has
  no session parameter, while `session.context` exposes per-request tools. A
  global register/unregister toggle alone is not proof of mixed-session parity.
- **Windows performance:** job `124795530282` failed the existing state-roundtrip
  p99 budget (about 28.3 ms versus 10 ms). This is a CI failure, not established
  PR-caused regression. No timing budget, test scope or acceptance gate is raised
  or removed. The critical unit command now uses one worker with its full test
  set intact. **ASSUMPTION:** eliminating competing Vitest workers reduces
  scheduling-related tail latency; this is not an established root cause.
  **NOT_VERIFIED:** the same 10 ms Windows p99 gate must pass on the new CI head.

Findings 2–4 require one durable activation/scope authority before canonical
workflow gates, with loss/corruption/restart and mixed-session negatives. Missing
workflow state must not be promoted to INACTIVE, existing state must not be
promoted to trusted operator activation, and an SDK callback must not be promoted
to a host-UI decision. No such authority or source proof is fabricated by this
bounded CI fix. PR #1190 remains Draft and P0-blocked.

The follow-up adds executable conformance tests rather than relabeling the old
denials as correct INACTIVE behavior:

- `src/cli/opencode-inactive-parity.smoke.test.ts`: five real-host comparisons
  fail against the loaded product. Every absent-product shell/edit control
  succeeds, with and without Git. With the product, Git-backed calls have
  `executed: false` and `SESSION_DIR_NOT_FOUND`; non-Git prompts fail with
  `NOT_GIT_REPO` before provider dispatch. The target remains `original` instead
  of receiving the control's `native-effect`.
- The same suite confirms that ordinary parent requests actually carry additional
  FlowGuard tools on the provider wire before start, not just in the raw registry.
  Only the optional help affordance is excluded from the comparison. This is now
  an observed effective-catalogue violation.
- `src/integration/plugin-inactive-event-scope.test.ts`: one component test
  reproduces `PLUGIN_ENFORCEMENT_UNAVAILABLE` for a never-started, unrelated
  session after a global event-stream fault. It requires native pass-through;
  the current product fails. This is fault-injection evidence, not a claim about
  an installed server's loss mechanism.

These are ordinary failing assertions, never `it.fails`, skipped tests or
replacement reviewer evidence. The real-host suite uses the workspace-built
product through a native plugin entrypoint; the packed-install and operator-UI
dimensions remain separate and unverified. Production authority is unchanged;
the common activation fix remains outstanding.

The two bootstrap expectations called out in the review now require ordinary
unstarted and non-Git usage to pass, rather than passing tests for the forbidden
denial. The state-loss negatives first observe existing bound workflow state and
then remove it or its directory; they retain fail-closed and diagnostic checks
without treating a fresh unstarted session as governed. Observed workflow state
is still not labeled proof of a trusted operator activation.

Verification of the review follow-up (local Node 22.22.2):

- Scripts: **319 passed**, including all nine shell-free verifier gate tests.
- Architecture: **538 passed**. Typecheck, strict lint, format, build/doc drift,
  unchanged unused-export baseline, unused dependencies and actionlint passed.
- Full integration: **4,199 passed / 3 failed**. The failures are the two corrected
  fresh/non-Git bootstrap contracts and the unstarted-session event-fault contract.
  The state-loss and corruption negatives remain passing.
- Full smoke with both CI flags: **103 passed / 11 failed / no skips**. Five new
  native-parity failures expose the existing P0; the other six remain the known
  reviewer/capture and regular-error recovery failures.
- The actual shell-free independent-review command starts local Vitest correctly
  and still fails its four required product contracts, not shell parsing.
- The unchanged state-serialization test passes in an isolated local run with
  `CI=1`; this does not establish Windows timing or a PR-caused regression.
- **NOT_VERIFIED:** hosted Windows verifier/performance results for this follow-up;
  re-run `scripts-windows` and `critical-windows` on its published head. Full
  coverage was not re-run locally after adding the failing P0 contracts
  (`npm run test:coverage:ci`); the earlier green coverage result does not certify
  this now stricter conformance set.

## Baseline control flow and required simplification

Paths in this section are relative to the repository root. The table describes
the original inspected baseline, its directly dependent surfaces and the required final
cutover, not a permanently supported V1/V2 dual path.

| Path / owner                                                                                                                                                  | Current dependency and authority                                                                                                                                                                                                                                                     | Final action and proof                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integration/plugin.ts`                                                                                                                                   | Composition creates workspace/logger/adapter, registers V1 hooks and then wraps them for output budgets, watchdog and capture. `plugin-orchestrator.ts` is a type surface, not another registrar.                                                                                    | Replace the factory with one V2 lifecycle composition and explicit handler ordering. Remove hook-object wrapping rather than wrapping it again. Cover setup failure, disposal, reload and fence-before-effect order in plugin contracts and installed-host tests.                                                                                                                                                      |
| `src/integration/plugin-reviewer-capture.ts`, `plugin-events.ts`, `types.ts`                                                                                  | V1 hook/event shapes and nested callbacks feed capture and recovery.                                                                                                                                                                                                                 | Translate exact V2 events at the host boundary once; keep authoritative IDs intact and refuse ambiguous ACTIVE events. Remove V1 SDK imports and callback assumptions. Test delayed/duplicate/missing events.                                                                                                                                                                                                          |
| `src/adapters/host-adapter.ts`, `src/integration/opencode-host-adapter.ts`                                                                                    | HAI closes platform and review-transport vocabularies; adapter advertises static booleans and contract-attested capabilities. Argument/result/compaction methods are no-op wrappers around direct hook mutations.                                                                    | Remove no-op abstraction methods; express demonstrated semantic capabilities, scoped by build/surface/path and evidence. Keep host mechanics in the adapter. A separate minimal test adapter must satisfy the same assurance contract. Never union weak transports into fictional assurance.                                                                                                                           |
| `src/shared/hosts.ts`, `src/cli/host-resolver.ts`, `platform-trust-report.ts`                                                                                 | Shared host selection and CLI support reporting coexist with the HAI's inline host union.                                                                                                                                                                                            | Keep one owner for identities and distinguish adapter extensibility from actually certified product support. Do not add a second host/capability registry or promote an unknown adapter to supported.                                                                                                                                                                                                                  |
| `src/adapters/session-authority.ts`                                                                                                                           | Canonical session-location pipeline resolves Git root/fingerprint, reads state and validates binding. `absent` describes missing workflow state, not durable activation history.                                                                                                     | Preserve this path authority. Supply actual per-session host location and distinguish verified INACTIVE from unavailable/formerly ACTIVE activation. No caller may derive a competing authoritative session path. Test corruption, deletion, foreign binding and TOCTOU.                                                                                                                                               |
| `src/integration/plugin-workspace.ts`, `plugin-shared.ts`, `runtime-lease.ts`                                                                                 | Workspace delegates authority using plugin-load worktree and keeps chain/enforcement/queue caches. Factory forwards a class API. Runtime maps retain command scopes and failures.                                                                                                    | Replace plugin-global location authority with exact session scope; review class/factory indirection and duplicated lookups before retaining them. Runtime caches must not become durable activation/capacity authority. Preserve lease ownership and crash-safe outbox behavior.                                                                                                                                       |
| `src/integration/plugin-beforehooks.ts`, `phase-tool-gate.ts`, `tool-classification.ts`                                                                       | Host mutations without workflow state hit `SESSION_DIR_NOT_FOUND`; command hook can clear capacity lock and populate human intent. Several enforcement helpers re-read authority or collapse failed resolution to null.                                                              | Resolve activation before governance; verified INACTIVE passes through, ambiguous formerly ACTIVE blocks. Remove null-as-authority and command-origin assumptions, not safety checks. Reuse phase/policy/mutation decisions without duplicate state machines. Test no effect on denial and no inactive veto.                                                                                                           |
| `src/integration/user-decision-intent.ts`, `tools/decision/decision-tool.ts`, `installed-commands.ts`                                                         | A process-local TTL intent is populated from V1 command hooks and is not wired natively. `/start` is a native plugin command (`plugin-start-command.ts`) that hydrates, then commits the activation as `host_command`. Decision tools additionally use canonical actor/policy gates. | Interactive start is separated from hydrate; provide authorized autonomous activation. Bind actual source/action/scope/policy/generation, replay/concurrent-use protection and canonical actor/audit checks. Operator decisions use the `host_command` channel (ADR-010 amendment 2026-11-03); no callback is relabelled as human proof. Start grants no implicit recovery/end authority or automatic capacity unlock. |
| `src/integration/tools/hydrate/hydrate.ts`, `src/rails/hydrate.ts`                                                                                            | Tool owns workspace setup and locked revalidation; rail owns workflow hydration. An absent session currently enters a create path.                                                                                                                                                   | Restrict direct hydrate to existing governed scope; trusted start orchestrates initial activation/hydration without granting authority to model-supplied arguments. Preserve terminal read-only reload and lock/TOCTOU contracts.                                                                                                                                                                                      |
| `src/integration/tools/index.ts`, `helpers.ts`, `src/templates/wrappers/index.ts`                                                                             | Command catalogue exports host-discovered V1 tool objects through a separate installed tool wrapper; helpers document V1 passthrough shapes.                                                                                                                                         | Register tools from the existing surface with V2 transforms. Remove obsolete tool-file discovery and V1 DTO assumptions; derive host schemas from canonical validation rather than writing another tool/schema catalogue. Preserve all direct tools and typed blocked results.                                                                                                                                         |
| `src/integration/review/types.ts`, `review/dispatch/native-task-review*.ts`, `durable-dispatch.ts`                                                            | Structural client types still mirror V1 SDK mechanics. Native Task path authorizes frozen obligation/attempt/dispatch and binds the child.                                                                                                                                           | Replace host-mechanical client shapes with minimal semantic ports where actually consumed. Move concrete V2 transport wiring out of host-neutral decisions, preserving one dispatch and binding authority. Test child reuse, caller model overrides, background execution and cross-session callbacks.                                                                                                                 |
| `src/integration/review/dispatch/structured-followup.ts`, `reviewer-task-completion.ts`, `src/integration/reviewer-capture.ts`                                | Follow-up expects completed V1 prompt response, exact response parentID and one observed serialization step. Capture/reconciliation use V1 context and terminal records.                                                                                                             | Replace those assumptions with a proven V2 admission-to-terminal chain. Never synthesize parentID or choose latest response by timestamp/text. Keep one same-child, tool-free capture and bounded semantic-preserving repair. Test stale answers, concurrency, late tools, missing history, length continuations and forced final steps.                                                                               |
| `src/integration/reviewer-output-cap.ts`, `reviewer-execution-watchdog.ts`, `reviewer-execution-failure.ts`, related failure persisters                       | Reviewer-only cap/watchdog failures feed durable closure and retained capture fences.                                                                                                                                                                                                | Remove obsolete V1 budget workarounds; preserve native model-aware V2 budgeting and all selected reasoning variants. Keep unknown outcomes fenced, original causes, blocked obligations, stale attempts and durable capacity lock; no timer-only unlock or automatic second child.                                                                                                                                     |
| `src/state/review-message-capture.ts`, `evidence-review-invocation.ts`, `evidence-primitives.ts`, `evidence-review.ts`                                        | Transport v5 uses V1-shaped message proof; assurance state independently uses `review-assurance.v7`. Current core transport vocabulary names native Task.                                                                                                                            | Define a new current transport-proof generation only after provenance is proven. Separate transport mechanism from semantic assurance, update directly dependent validators, fixtures and recorders, and reject superseded formats explicitly. Do not conflate transport and state versions.                                                                                                                           |
| `src/integration/review/obligations/assurance.ts`, `review/enforcement/`, `review/validation/`, `review/evidence/`, `review/observations/`                    | Existing obligation, frozen subject, invocation, observations, challenge and digest authorities gate binding; some consumers explicitly require the V1 transport discriminator.                                                                                                      | Update affected consumers to the proven current assurance contract, not a parallel evidence pipeline. Preserve offered refs, observation identity, frozen revision, challenges, findings hash and atomic audit/state binding. Re-run consumption, negative and mutation contracts.                                                                                                                                     |
| `src/integration/audit-outbox.ts`, `plugin-audit*.ts`, `plugin-mutation-episodes.ts`, `plugin-mutation-reconciliation.ts`                                     | Existing write/outbox/dispatch paths persist intent, reconcile audit and detect host mutation outcomes.                                                                                                                                                                              | Extend existing authorities only where activation/evidence integration requires it. No independent audit chain or silently discarded pending intent. Test replay, audit-write failure, missing after-hook and restart.                                                                                                                                                                                                 |
| `src/cli/install-steps.ts`, `install-json.ts`, `install-helpers.ts`, `install-types.ts`, `doctor-command.ts`                                                  | Installer writes global mandate instruction sources, V1 tool/plugin wrappers and task permission shaping. Reviewer tuning uses a fixed OpenCode effort list/frontmatter.                                                                                                             | Remove always-on FlowGuard instructions and global permission rewrites for OpenCode. Install one V2 plugin and native model/variant selection; preserve unrelated customer files/settings. Use explicit archive/fresh-install recovery, not migration shims or silent audit deletion. Test install/uninstall/rollback ownership and no-start parity.                                                                   |
| `src/cli/opencode-runtime-compat.ts`, `opencode-runtime-detect.ts`, `opencode-live-host.ts`, `.sdk-baselines/opencode/`, host/SDK drift scripts and workflows | V1 pins, instruction-presence classification, CLI package/launching and wire fixtures define current support/testing.                                                                                                                                                                | Replace one baseline at cutover; report actual installed Desktop/backend/CLI artifacts independently. Unknown mandatory capabilities block governance, not native inactive work. No V1 fallback or same-user external process containment claim.                                                                                                                                                                       |
| `src/templates/mandates.ts`, `commands/hydrate.ts`, `commands/shared-review-loop.ts`, `src/rendering/mandates-renderer.ts`                                    | Mandate owner and renderer/hash guards ship V1 activation/reviewer instructions through installer and command templates.                                                                                                                                                             | Scope mandates to verified ACTIVE sessions and authorized descendants, including compaction. Update content, renderer contracts and hashes together; no contributor-only legacy rule in downstream prompts. Check end-of-governance context remnants.                                                                                                                                                                  |
| `demos/java-task-manager/run-live-matrix.mjs`, `live-host-export.mjs`, `verify-evidence-package.mjs`, `demos/lib/host-config.mjs`, `review-continuation.mjs`  | Real-host demo harness binds installed artifacts, workflow outcomes, transcript formats, export and ISO projection.                                                                                                                                                                  | Port only actual host/config/export dependencies. Do not fabricate operator approval to automate headless runs. Re-prove Java/ProofGraph/audit/export/inspect and existing ISO projection without redesigning their authorities.                                                                                                                                                                                       |

## Trust boundaries before security implementation

**Native Start follow-up (2026-11-03):** the hydrate-then-activate row above
describes fresh preparation only, now serialized with journal preflight under
the existing activation lock. ACTIVE/ACTIVATING reuse the bound workflow without
hydration. Successful activation has one idempotent `governance:activated` event
in the existing audit trail; its durable confirmation marker gates runtime
admission, so a missing audit/confirmation blocks governed operations until
`/start` repairs them. Audit-unconfirmed recovery and post-commit presentation
warnings are distinct. See the
[Start coordination contract](./activation-scope-contract.md#native-start-coordination-and-audit-2026-11-03).

Apply revised ADR-010: trusted host/OS infrastructure, untrusted model/caller
assertions, governance/evidence integrity and scoped controlled-path prevention.
These are authority questions and claim limits, not requirements to deploy a new
authentication service or OS isolation boundary.

| Actor / trusted component                  | Required treatment and blocking question                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model, parent agent, child and tool caller | Text, arguments, SDK prompts and supplied IDs are not self-authorizing. Validate explicitly authorized autonomous activation through canonical actor/policy authority; record operator decisions as `host_command`, never as human proof. Never relabel an autonomous request or callback as human consent. |
| Other process with the same OS user/rights | Do not assume a file permission, local CLI, environment token, loopback endpoint or host API credential separates it from the agent. Specify whether protection against it is required and prove an independent boundary if claimed. No such protection is certified here.                                  |
| Provider                                   | Replies are data, not provenance. Validate required execution/capture evidence; report autonomous remote effects outside interception as a prevention limit, not a universal-containment prerequisite or model/provider ban.                                                                                |
| Host and plugin runtime                    | Host-stamped identity relies on an explicitly trusted host build/runtime. A compromised host cannot independently attest its own honesty. If a claimed guarantee includes host compromise, obtain an independent authority or mark it unsupported.                                                          |
| External resources and sibling sessions    | Session identity is not exclusive resource ownership. Without a demonstrated host/OS boundary, record external/shared-worktree prevention as NOT_SUPPORTED and prove freshness invalidation separately.                                                                                                     |

Before authority-bearing acceptance, prove the applicable interactive or autonomous
authorization, human-source distinction where required, and record trust assumptions,
action/scope/policy/generation/replay/concurrent-use binding and residual risks.
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

### V1 reviewer transport removal (2026-11-02, #1169 WS1)

The V2 entrypoint never registered the V1 reviewer Task path, and the V2 host
adapter threw for every V1 reviewer call. The following V1 mechanisms had no
V2 production caller and are removed rather than kept as a dormant second path:

- Native Task transport: `review/dispatch/native-task-review.ts`; the V1
  same-child follow-up `structured-followup.ts`; the V1 message-shape completion
  classifier `reviewer-task-completion.ts`; `provider-error.ts`;
  `agent-resolution.ts`; the V1 capture fence `integration/reviewer-capture.ts`.
- Execution watchdog and persisters: `reviewer-execution-watchdog.ts`,
  `reviewer-execution-failure.ts`, `reviewer-output-cap-failure.ts`, plus the
  runtime maps `reviewerOutputCapFailures`/`reviewerExecutionFailures` and the
  `fallbackToolTraceKey`/`toolTraceIds` correlation fallback (every native hook
  supplies an exact call identity).
- Host-adapter members that always threw or had no V2 caller:
  `executeReviewerPrompt`, `reviewerCall`, `quiescence`, `interrupt`,
  `listAgents`. The review host port is now only `readHistory`. Adapter
  initialization checks the session methods FlowGuard actually calls
  (`get`, `context`, `prompt`, `wait`, `hook`).
- Reviewer configuration: `reviewer.outputTokenMax` with
  `integration/reviewer-output-cap.ts` and the V1 watchdog sub-budgets
  `toolTimeoutMs`, `reviewTimeoutMs`, `serializationTimeoutMs`. The
  former defaults written by earlier installers are dropped at read time; any
  other value fails with a concrete `CONFIG_INVALID` reason. The former cap
  check was the only fail-closed consumer of an unreadable config; ACTIVE
  runtime creation now fails with `CONFIG_INVALID` instead.
- V1 instruction-source diagnostics: `cli/opencode-runtime-detect.ts` and the
  `instructions[]` classifier in `cli/opencode-runtime-compat.ts` (no
  production importer since the global mandate instruction was removed). The
  module keeps only the old-generation exact host pin read by demos and SDK
  update tests; replacing that pin is installed-host acceptance work.
- Reason codes without a remaining emitter:
  `STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE`,
  `STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE`,
  `REVIEWER_HOST_MESSAGE_ENCODING_FAILED`, `REVIEWER_EXECUTION_TIMEOUT`,
  `REVIEWER_OUTPUT_CAP_INVALID`, `OPENCODE_INSTRUCTION_SOURCE_UNSUPPORTED`.

Live V2 residues have single owners: `native-review-findings.ts` (findings
contract, capture-gate validation, settlement audit intents),
`native-review-execution.ts` (fulfilled-review projection) and
`native-review-types.ts`. The Task-worded `transportRecoveryInstruction`,
`reviewableToolForObligationType` and the orphaned implementation-session test
seed lost their only callers and are removed.

**Retained host-neutral review policy, not yet wired into the V2 capture
(parity work, NOT_VERIFIED):** the retry/terminal classification and bounded
retry diagnostics (`capture-retry.ts`), the durable re-arm transition
(`durable-dispatch.ts` `abandonAndRearmByHostCall`) and the incoherent-verdict,
pre-bind and expired-dispatch closures in `native-review-execution.ts`.
Observation replay (`review/observations/observation-replay*.ts`), which V1 ran
after the Task, is now connected to V2 native capture before evidence binding.
The concrete V2 call-site and test obligations are tracked in
[WS2 closure and V2 reviewer-parity backlog](./ws2-closure.md);
Remaining unwired owners keep their tests. The enrolled V2 reviewer can now call
`flowguard_observe_repository` with its real child identity; the native positive
and five capture-substitution negatives exercise the canonical replay/binder.
This is not R4 or complete reviewer-parity acceptance. The V1 glue that only connected them to the Task
after-hook (`capture-failure-routing.ts`, binding-failure routing and the
unable-to-review output projection) is removed because the unused-export gate
admits no unwired production code; V2 must route through these owners anew. The
V2 capture currently closes every non-provenance capture failure terminally. The
deleted V1 plugin-level tests documented these V1 behaviors and must be
re-proven on the V2 path, not restored:

| Removed V1 test                               | V1 behavior to re-prove on V2                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `plugin-native-challenge-retry.test.ts`       | Retryable challenge-evidence failure re-arms a fresh attempt; the corrected retry binds            |
| `plugin-reviewer-bound-schema.test.ts`        | Obligation-bound schema is sent; a schema-const violation is rejected, never normalized            |
| `plugin-reviewer-budget-recovery.test.ts`     | Terminal closure grants no further budget; durable closure intent is chained through status        |
| `plugin-reviewer-step-budget.test.ts`         | Step-budget stop, truncation and abort are terminal capacity closures and are never serialized     |
| `plugin-reviewer-execution-lifecycle.test.ts` | Unknown execution outcomes persist before monitoring stops and retain quarantine and capacity lock |
| `native-task-review-bindings.test.ts` (parts) | Reviewer step-budget/truncation transcripts are never serialized for any obligation type           |

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
