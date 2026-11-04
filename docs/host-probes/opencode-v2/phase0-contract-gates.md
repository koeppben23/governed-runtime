# OpenCode V2 contract gates — explicit parity revision (2026-11-02)

- **Release status:** NO-GO for supported ACTIVE V2 integration and merge.
  Installed Desktop/whole-PR acceptance and the complete product workflow remain
  open.
- **Work status:** The native V2 entrypoint, activation/lifecycle and autonomous
  decision path, reviewer retry/closure, mixed-session isolation and packed
  Linux/macOS/Windows CLI-server parity are implemented with bounded evidence.
  The current-build Windows matrix passes 65/65 as four parallel jobs; the full
  installed matrix is now a manual/nightly/label-triggered acceptance workflow,
  not a PR gate.
  The label trigger enables pre-merge execution but is not a required status
  check in the effective `develop` ruleset (read-only verification, 2026-11-04).
  Enforced acceptance of the exact final merge candidate remains an open gate;
  a label or an earlier green run does not close it.
  Documentation/diagram drift and the P0-10 ownership audit remain open; see the
  [inventory](./implementation-inventory.md#native-entrypointclient-implementation-in-progress).
  Historical failures remain historical; no broad containment-probe campaign or
  speculative V1 compatibility layer is required.
- **Authority:** [ADR-010 scope amendment](../../decisions/010-host-neutral-opt-in-governance.md#explicit-scope-amendment-2026-10-31),
  [mandatory parity/autonomous-activation amendment](../../decisions/010-host-neutral-opt-in-governance.md#explicit-parity-and-autonomous-activation-amendment-2026-11-02),
  [decision report](./p0-feasibility-decision.md),
  [ownership/removal inventory](./implementation-inventory.md).
- **Target:** pinned Desktop and CLI/server V2.2.4, independently verified on
  each required surface. No Desktop certification follows from CLI probes.
- **Latest follow-up:** the [remaining P0-10 ownership decisions](./p0-10-ownership-decisions.md)
  keep assertion porting open. The current F1/F2 patch corrects read-only
  `/continue` and native `/check` metadata without changing command execution.
  Hosted CI `41890648033` on `fd8d275f` passes all 37 jobs including coverage.
  The prior ISO concurrent-publication failure on `7d9560e2` remains
  unexplained; that later green run is not proof of a fix or a flake.
  CI `41898050988` on `27e9584b` now repeats that exact assertion failure.
  Targeted failure-output diagnostics preserve the original assertion and budgets;
  the publication cause remains unproven.
  The earlier accepted P0-00 CLI/server matrix on `2f4aa06d` remains closed.

## Explicit change, not historical reclassification

The ADR amendment replaces the former universal native/OS/provider prevention
prerequisite and mandatory independently authenticated operator-channel design.
It does **not** turn any old failed/blocked probe into PASS. The numbered gates
below now test governance integrity and the preventive coverage actually claimed
by FlowGuard. Universal prevention is a documented non-goal, not an unrun test
that must eventually pass.

Preserved evidence: [initial host report](./2026-10-30-2.2.4/README.md),
[security follow-up](./2026-10-30-2.2.4/P0_SECURITY_GATE.md),
[initial Phase 02](./2026-10-31-2.2.4-phase02/README.md),
[scope/lifecycle](./2026-10-31-2.2.4-scope-lifecycle/README.md), and
[prevention/reviewer](./2026-10-31-2.2.4-prevention-review/README.md).
Their dated facts, source/raw hashes and statuses remain unchanged. Their former
global implementation blockers are historical decisions under the old contract;
current requirements are owned here and in ADR-010.

The **2026-11-02 operator decision** additionally replaces the blanket UI-only
activation prerequisite: both explicit interactive and authorized autonomous
activation must work. Human approvals remain policy-dependent; autonomous
requests must be authorized and honestly attributed, never treated as human
consent. V1 behavioral/governance parity is mandatory without retaining V1
implementation. No new reviewer exception or weaker evidence gate may be used to
make the V2 port pass. This specification change is not an implementation PASS.

## Evidence vocabulary

- `SUPPORTED`: version-pinned positive and relevant adversarial proof of the
  specific declared property, never proof of all host behavior.
- `NOT_VERIFIED`: incomplete or absent proof of a required property; not PASS.
- `NOT_SUPPORTED`: demonstrated inability for the specified claim/path; retain
  as a limitation, without inventing a replacement guarantee.
- `BLOCKED`: an affected implementation/action cannot safely proceed because a
  material requirement or authority decision is unresolved.
- `NO-GO`: product release/approval lacks required passing evidence under the
  **revised** scope; not an automatic veto because universal containment is absent.

Each actual capability claim records host/build/surface, installed artifact,
official docs/date, inspected API/source where needed, reproducible controls,
failure semantics and limits. Documentation and static booleans are not proof.

## Current acceptance gates

| Gate                                      | Revised required result                                                                                                                                                                                                                                                                                                            | Current evidence / remaining decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-00 Native parity                       | Absent and installed-but-INACTIVE native operation, catalogue/variants, permissions and context; no implicit hydrate or mandates                                                                                                                                                                                                   | **PASS for CLI/server on Linux, macOS and Windows**, head `2f4aa06d`, acceptance run `41855491592`: 65/65 each, same checksum-verified package, exhaustive/disjoint Windows shards. Required CI `41855408259` passes on attempt 2; initial PERF failure and macOS runner-capacity cancellation remain recorded separately. Windows diagnosis is closed. The full matrix is manual/nightly/label-triggered, not a required PR gate. Desktop 2.2.4 and live remote model refresh remain NOT_VERIFIED. See [P0-00 closure](./p0-00-inactive-parity.md#final-windowscli-server-diagnostic-closure-on-2f4aa06d).                                                                                                                                                 |
| P0-01 Authorized activation and decisions | Prove both explicit interactive and authorized autonomous activation, with actual source/action/scope/policy/generation, canonical actor/policy validation, durable audit and replay/concurrent-use protection. Human-source proof only for actual policy-required human decisions; start grants no implicit approval/recovery/end | Interactive `/start` uses `host_command`; explicit autonomous `StartGovernance` RPC uses canonical config/actor/policy authorization and the same locked lifecycle, audit and confirmation gate. Native `/approve`, `/override-approve`, `/request-changes`, `/reject` and `/review-decision` execute the canonical decision rail; `/recover-capacity` and `/end-governance` use exact capacity-lineage and safe activation closure. Installed-host acceptance remains NOT_VERIFIED; the command channel does not prove a human                                                                                                                                                                                                                             |
| P0-02-H Host scope/lifecycle              | Exact canonical worktree/session, authorized child/call and restart/history mechanisms needed for governance                                                                                                                                                                                                                       | Bounded native-child/restart observations; parent claims, movable locations, race/corruption gaps remain. Required complete host mapping NOT_VERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P0-03 Controlled local paths              | Pre-effect denial and correct audit for file/shell/custom/Code Mode operations intercepted and claimed by FlowGuard, including concurrency/reload/failure                                                                                                                                                                          | Loaded-hook bounded support only; actual ACTIVE product coverage NOT_VERIFIED. No claim of universal OS containment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P0-04 MCP, hosted and native coverage     | Test advertised/intercepted MCP and visible request gates; enumerate bypass/unobservable paths; no false prevention/audit claims or invalid approvals                                                                                                                                                                              | Bounded MCP deny + executable control and visible hosted-definition denial available. Native pre-prompt shell gap and unproved remote actions are documented limits, not blanket cutover blockers. Complete required product evidence/coverage reporting NOT_VERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P0-05 Reviewer assurance                  | Preserve V1-equivalent mandatory independent AI review, fully automatable without a human reviewer. Frozen subject, actual independent visible child, exact request/terminal/model/effort, uncontaminated same-child JSON, full completion and fail-closed recovery; no new policy exceptions                                      | Four required reviewer contracts and independent-review-e2e pass at `b9a41e5b`. WS4 retry/closure and native capture/recovery are implemented with component/native coverage; R2 native restart, settlement races, late completion and full reviewer parity remain unaccepted. R4 is `NOT_SUPPORTED` under the untrusted-co-installed-plugin model and remains BLOCKED; see the breakdown below.                                                                                                                                                                                                                                                                                                                                                            |
| P0-06 Native models/variants              | Entire native selection passes through; effective parent/reviewer/serialization choices and native budgeting verified representatively                                                                                                                                                                                             | Mock `chosen`/`high` observation only; full selection/default/wire contract NOT_VERIFIED. No model/provider filters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P0-07 Mixed sessions/resources            | No ACTIVE policy/context leakage into INACTIVE; shared-resource drift invalidates stale evidence                                                                                                                                                                                                                                   | Bounded current-build proof on Linux/macOS: one real `/start` makes A ACTIVE; B stays INACTIVE across live tool publication, location reload and host restart, keeps its complete native catalogue/system context and executes a real shell effect. Full shared-resource drift, every race and ACTIVE-only resource isolation remain NOT_VERIFIED. No exclusive write-control claim or independent OS isolation requirement.                                                                                                                                                                                                                                                                                                                                |
| P0-08 Failure/unknown outcomes            | Formerly ACTIVE missing/corrupt authority, unknown reviews and plugin loss cannot yield valid approval/export; durable lock/quarantine and explicit recovery                                                                                                                                                                       | Canonical retry/closure routing, native fresh-attempt recovery and persisted-evidence continuation are implemented and covered at component/native level. Native restart, late completion, concurrent recovery and adversarial settlement acceptance remain open. `wait()`/idle/timeout alone cannot authorize recovery. No claim hooks prevent host activity after unload.                                                                                                                                                                                                                                                                                                                                                                                 |
| P0-09 Build/docs/distribution             | New truthful current proof contract, package/install/doctor/docs agreement; historical bytes preserved                                                                                                                                                                                                                             | Current-build tarball/checksum, cross-platform install and Linux/macOS/Windows CLI-server parity pass. Desktop/whole-product workflow remain NOT_VERIFIED. Historical bytes/evidence are preserved; CI is not by itself installed Desktop acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P0-10 Portability/simplification          | Host SDK/mechanics at adapter boundary; same host-neutral conformance suite with minimal independent test adapter; V1/duplicate layers removed                                                                                                                                                                                     | **Not PASS (implementation cleanup complete; acceptance open).** Type facade, unused provenance, host classifier, old settlement and four callback-driven rails are removed. Their nine/seven/purpose-level cases were mapped to executable current owners, with obsolete callback contracts explicitly retired and guarded against reintroduction. Historical V1 JSON is unchanged; no second runtime or test-only executor remains. Only deliberate `shared/product-inventory.ts` stays outside the combined shipped graph. Full live-runner/ACTIVE acceptance, default mutation, ISO publication exclusivity and final SHA/artifact-bound certification remain open. No net-complexity claim. See [ownership decisions](./p0-10-ownership-decisions.md). |

**P0-00/P0-07 reconciliation follow-up (2026-11-04):** the
[same-artifact rerun](./p0-00-inactive-parity.md#counterprobe-reconciliation-and-live-publication-follow-up)
passes 65 native contracts locally: the original seven assertions plus the
56-case matrix and two real-Start mixed-session tests. The old counterexamples
predate the product repair at `3a274edf`; their historical results remain valid.
Live FlowGuard tool publication, location reload and server restart preserve
ACTIVE A's tools/mandates and INACTIVE B's native catalogue/system context. This
does not prove remote models.dev refresh or every shared-resource race. A required
Linux/macOS/Windows matrix now runs both existing suites on one shared tarball.
Linux/macOS each pass 65/65 on `77605384`; Windows times out during bootstrap
in both attempts, each with 65 cases unexecuted. The required CI gate fails. Local
Desktop is version 2.2.5, so pinned 2.2.4 Desktop acceptance remains BLOCKED.

The [bounded bootstrap diagnostic checkpoint](./p0-00-inactive-parity.md#bounded-bootstrap-diagnostic-checkpoint)
retains npm logs and compares one Windows bootstrap alone against both suites
jointly on the original package. Hosted execution on `82a490aa` proves solo npm
completion in 267.8 seconds and two joint npm timeouts. Its seven solo cases
fail at native-control effects or installer setup; all 65 joint cases remain
unexecuted. The test job now serializes both suites and reuses one digest-bound
bootstrap; the Windows shell fixture uses a cross-shell `node -e` command and the
installer retains npm debug logs. Serialization and the shell fixture are
test-only corrections. The installer `ENOENT` is a confirmed product defect on
Windows 8.3 short-name `~` paths: `pathToFileURL` emitted `%7E` and npm opened the
literal encoded directory. Upstream `0e3568f0` now emits an unencoded
`file:../vendor/...` spec relative to the staging root; a real-npm test covers
`~`, spaces and `#`, and Windows must re-execute on the current build.
Linux/macOS each pass 65/65; the joint bootstrap
mechanism remains NOT_VERIFIED. Current-build run `41806050855` was cancelled at
the 20-minute job limit midway through the second matrix scope after four
successful installs and no assertion failure. Run `41809656855` completed six
installs and all four installed-suite scopes, then reached the final seven-case
suite but was cancelled at 35m08s by the 35-minute limit. No installer or
assertion failure and no results JSON were produced; the missing JSON is
cancellation. Current-build run `41829567943` on `d5d88a8e` then passes the
split Windows matrix: 2 mixed + 28 repo + 28 global + 7 original = **65/65,
0 failed**. The full matrix is moved to the separate manual/nightly/label-triggered
`opencode-parity.yml` workflow; the PR gate keeps the fast unit/integration/
architecture checks. No test/hook/coverage budget, case-count or assertion
changed. The intervening macOS activation failure on `a38dd3a7` is retained
separately in the [executed diagnostic results](./p0-00-inactive-parity.md#executed-hosted-diagnostic-on-82a490aa).

### P0-05 / P0-08 evidence breakdown (2026-11-03)

The independent review supplied CI evidence for exact HEAD
`b9a41e5b4193aa88b8423961bb114475bd220839`: all 12 workflows passed, including
native smoke and `independent-review-e2e`. This records that reviewed CI result,
not an independent local rerun or installed Desktop acceptance.

The local follow-up (same product code, added tests) also passes six native
capture/recovery probes on macOS/OpenCode 2.2.4: the four required contracts,
R2 SIGKILL/reload after post-commit projection failure, and a crash immediately
after the real settlement interrupt. Component tests cover concurrent reopen,
failed host operations, changing history and stale completion. These bounded
positives do not establish every native race/crash point. The R4 follow-up
additionally **reproduces** later dynamic-context and HTTP plugin replacement
while evidence fulfills; this strengthens the blocker, not assurance. See
[capture/recovery](./reviewer-capture-evidence.md#r2-restart-reconciliation-2026-11-03)
and [R4 diagnostics](./reviewer-tool-result-evidence.md#follow-up-reachable-plugin-residuals-2026-11-03)
for the exact contracts and reproduction commands.

| Subcontract                                         | Evidence at the reviewed HEAD                                                                                                                           | Remaining acceptance                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatch, V6 evidence, serialization-tool rejection | Three required native product contracts pass                                                                                                            | Preserve these contracts and verifier unchanged                                                                                           |
| Unknown-outcome recovery                            | Fourth required native contract passes through a fresh attempt after a later user turn, host interrupt/wait/idle and exact durable lineage              | Restart during settlement, late completion, concurrent recovery and old-child redispatch adversarial proof                                |
| Independent review E2E                              | Dedicated CI job passes                                                                                                                                 | Not full Desktop/CLI workflow acceptance                                                                                                  |
| R2 post-commit projection failure                   | Component test resumes the canonical verdict from persisted evidence without another reviewer                                                           | Actual native process termination/reload at the commit/projection boundary                                                                |
| R4 result replacement                               | Tail-hook rejection tests cover the previously reproduced After/Context replacements                                                                    | Later dynamic hooks, pre-observation replacement and HTTP/WebSocket/provider mutations remain unaccepted under the untrusted-plugin model |
| V1 reviewer parity                                  | Existing canonical owners and required V2 connections are inventoried in [WS2 closure](./ws2-closure.md#missing-v1-reviewer-parity-separate-workstream) | Observation replay, bounded capture retry and remaining closures are not implied by native recovery PASS                                  |

Historical red checkpoint: at `2acef049` the required recovery contract was still
failing (132 native smoke PASS / 1 FAIL / 3 conditional skips). That result is
retained as historical evidence, not the current P0-05 status. Finding 6 as a
whole remains **BLOCKED**, and PR #1190 remains **NO-GO**.

**R4 feasibility update (2026-11-04, product source `94194531`):** the
[bounded pinned-host investigation](./reviewer-tool-result-evidence.md#bounded-feasibility-conclusion-2026-11-04)
finds final-input integrity **NOT_SUPPORTED** by the public OpenCode 2.2.4 APIs
under the unchanged untrusted-co-installed-plugin contract. Six unchanged
diagnostics pass as tests, including two still-successful replacement
counterexamples. R4 remains BLOCKED; this adds no runtime exception and neither
closes P0-00 nor establishes installed Desktop/CLI acceptance.

## Governance failure versus an uncontrolled host effect

1. Keep native operation unrestricted when FlowGuard is absent or INACTIVE.
2. Resolve exact activation/scope before applying FlowGuard decisions. A corrupt
   formerly ACTIVE authority is not verified INACTIVE absence.
3. Deny prohibited operations before effect **on the intercepted paths**. Report
   all uncovered paths honestly; neither logging nor quarantine retroactively
   prevents their effects. Do not compensate with model/provider bans.
4. Validate every required governance/evidence predicate independently of model
   statements. Outside effects that stale/contaminate/invalidate evidence block
   the affected approval. Unknown effect/execution is not positive evidence.
5. A missing capability needed by a FlowGuard-owned action blocks that action.
   A missing universal host/OS/remote containment guarantee alone does not.
6. Recheck build-bound claims on host/adapter changes; no silent substitution of
   model/effort, operator origin or reviewer proof.

## Host feasibility versus product and installed acceptance

**G-P0 / P0-02-H:** host-mechanism facts only. No probe certifies an unimplemented
activation transaction, audit coupling or product recovery path.

**G-04 / P0-02-P:** actual INACTIVE/ACTIVATING/ACTIVE/BLOCKED authority, atomic
decision consumption, state/audit coupling, concurrent starts, restart,
corrupt/deleted records, child scope, capacity/quarantine and explicit deactivation.
A missing state file cannot erase prior ACTIVE history. Removing an instruction
entry does not erase conversation/compaction: prove adequate reset or require a
new native session, retaining the old audit/transcript.

**G-05:** repeat required cases using built/installed FlowGuard on Desktop and
CLI/server, including Java workflow, ProofGraph/export/inspect and existing ISO
projection. No successful inbox admission, idle event or `wait()` alone replaces
exact reviewer completion. Controlled-path negatives, failure and contamination
rejection remain required; universal provider/OS containment is not added back.

## Implementation and release order

1. Preserve V1 behavioral/governance parity. Prove the appropriate activation
   authorization for both interactive and autonomous use; require actual UI source
   for policy-required human decisions. Do not infer human consent or autonomous
   authorization from SDK/CLI/API callbacks alone.
2. Port/simplify the canonical adapter owners against documented/pinned V2 APIs;
   remove V1 and duplicate layers, without adding a sandbox/auth service/runtime.
3. For each authority-bearing or evidence-binding path, resolve its remaining
   material proof/contract gaps **before** implementing acceptance. Narrow tests
   prove the selected mechanism; no broad containment campaign is prerequisite.
4. Run product/conformance/mutation and installed Desktop+CLI acceptance with
   truthful coverage/limits, native model fidelity and real negative controls.
5. Final approval names the actual merge candidate against current `develop`
   and exact build/artifact/test provenance. Keep the single PR #1190 Draft;
   no partial merge, second implementation PR or premature V2 support claim.

This document changes acceptance scope only. It implements no runtime guard,
operator source, reviewer proof format, authentication service or isolation.
