# OpenCode V2 contract gates — explicit parity revision (2026-11-02)

- **Release status:** NO-GO for supported ACTIVE V2 integration and merge; the
  revised product contract is not implemented/installed-tested.
- **Work status:** Phase-02 bounded evidence collection and the local native
  entrypoint/client API/test/tooling step are complete. Native boundary/domain
  regressions and bounded mutation checks pass, but installed/product acceptance
  remains unverified; see the [inventory](./implementation-inventory.md#native-entrypointclient-implementation-in-progress).
  Adapter porting and simplification may proceed against the revised contract;
  unresolved authority/reviewer assumptions block their affected operations,
  not all V2 work. No broad containment-probe campaign is required.
- **Authority:** [ADR-010 scope amendment](../../decisions/010-host-neutral-opt-in-governance.md#explicit-scope-amendment-2026-10-31),
  [mandatory parity/autonomous-activation amendment](../../decisions/010-host-neutral-opt-in-governance.md#explicit-parity-and-autonomous-activation-amendment-2026-11-02),
  [decision report](./p0-feasibility-decision.md),
  [ownership/removal inventory](./implementation-inventory.md).
- **Target:** pinned Desktop and CLI/server V2.2.4, independently verified on
  each required surface. No Desktop certification follows from CLI probes.

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

| Gate                                      | Revised required result                                                                                                                                                                                                                                                                                                            | Current evidence / remaining decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-00 Native parity                       | Absent and installed-but-INACTIVE native operation, catalogue/variants, permissions and context; no implicit hydrate or mandates                                                                                                                                                                                                   | BLOCKED: actual loaded product vetoes unstarted native shell/edit calls and adds tools on the provider wire. Workspace-built native-host comparisons reproduce the violations; packed-install/Desktop parity remains NOT_VERIFIED                                                                                                                                                                                                                                                                                               |
| P0-01 Authorized activation and decisions | Prove both explicit interactive and authorized autonomous activation, with actual source/action/scope/policy/generation, canonical actor/policy validation, durable audit and replay/concurrent-use protection. Human-source proof only for actual policy-required human decisions; start grants no implicit approval/recovery/end | Interactive `/start` uses `host_command`; explicit autonomous `StartGovernance` RPC uses canonical config/actor/policy authorization and the same locked lifecycle, audit and confirmation gate. Native `/approve`, `/override-approve`, `/request-changes`, `/reject` and `/review-decision` execute the canonical decision rail; `/recover-capacity` and `/end-governance` use exact capacity-lineage and safe activation closure. Installed-host acceptance remains NOT_VERIFIED; the command channel does not prove a human |
| P0-02-H Host scope/lifecycle              | Exact canonical worktree/session, authorized child/call and restart/history mechanisms needed for governance                                                                                                                                                                                                                       | Bounded native-child/restart observations; parent claims, movable locations, race/corruption gaps remain. Required complete host mapping NOT_VERIFIED                                                                                                                                                                                                                                                                                                                                                                           |
| P0-03 Controlled local paths              | Pre-effect denial and correct audit for file/shell/custom/Code Mode operations intercepted and claimed by FlowGuard, including concurrency/reload/failure                                                                                                                                                                          | Loaded-hook bounded support only; actual ACTIVE product coverage NOT_VERIFIED. No claim of universal OS containment                                                                                                                                                                                                                                                                                                                                                                                                             |
| P0-04 MCP, hosted and native coverage     | Test advertised/intercepted MCP and visible request gates; enumerate bypass/unobservable paths; no false prevention/audit claims or invalid approvals                                                                                                                                                                              | Bounded MCP deny + executable control and visible hosted-definition denial available. Native pre-prompt shell gap and unproved remote actions are documented limits, not blanket cutover blockers. Complete required product evidence/coverage reporting NOT_VERIFIED                                                                                                                                                                                                                                                           |
| P0-05 Reviewer assurance                  | Preserve V1-equivalent mandatory independent AI review, fully automatable without a human reviewer. Frozen subject, actual independent visible child, exact request/terminal/model/effort, uncontaminated same-child JSON, full completion and fail-closed recovery; no new policy exceptions                                      | Partial native proof at `b9a41e5b`: all four required reviewer contracts and independent-review-e2e pass in reviewed CI. R2 native restart, settlement races, R4 residuals and full reviewer parity remain unaccepted; see the breakdown below                                                                                                                                                                                                                                                                                  |
| P0-06 Native models/variants              | Entire native selection passes through; effective parent/reviewer/serialization choices and native budgeting verified representatively                                                                                                                                                                                             | Mock `chosen`/`high` observation only; full selection/default/wire contract NOT_VERIFIED. No model/provider filters                                                                                                                                                                                                                                                                                                                                                                                                             |
| P0-07 Mixed sessions/resources            | No ACTIVE policy/context leakage into INACTIVE; shared-resource drift invalidates stale evidence                                                                                                                                                                                                                                   | Product NOT_VERIFIED. No exclusive write-control claim or independent OS isolation requirement                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P0-08 Failure/unknown outcomes            | Formerly ACTIVE missing/corrupt authority, unknown reviews and plugin loss cannot yield valid approval/export; durable lock/quarantine and explicit recovery                                                                                                                                                                       | Partial: native fresh-attempt recovery and persisted-evidence continuation pass at `b9a41e5b`; native restart and adversarial settlement acceptance remain open. `wait()`/idle/timeout alone cannot authorize recovery. No claim hooks prevent host activity after unload                                                                                                                                                                                                                                                       |
| P0-09 Build/docs/distribution             | New truthful current proof contract, package/install/doctor/docs agreement; historical bytes preserved                                                                                                                                                                                                                             | NOT_VERIFIED for the actual V2 product; checkpoint CI is not installed acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P0-10 Portability/simplicity              | Host SDK/mechanics at adapter boundary; same host-neutral conformance suite with minimal independent test adapter; V1/duplicate layers removed                                                                                                                                                                                     | WS2 HAI/plugin removals and a minimal independent second-host contract fixture are verified; complete V2 cutover and all-host conformance NOT_VERIFIED. No general security framework                                                                                                                                                                                                                                                                                                                                           |

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
