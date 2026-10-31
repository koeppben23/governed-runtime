# OpenCode V2 feasibility decision — explicit product-scope correction

Date: **2026-10-31**. Authority: the operator's explicit correction, recorded in
[ADR-010](../../decisions/010-host-neutral-opt-in-governance.md#explicit-scope-amendment-2026-10-31).
This replaces the earlier **uncommitted** decision-report draft that made
independent operator/local/remote containment boundaries prerequisites for all
security-critical porting. That proposal was not architecture-approved.

**Architecture correction accepted by the operator.** Documentation publication,
V2 adapter/installation/lifecycle porting and V1 simplification are GO. Acceptance
of operator decisions without the selected source proof and reviewer evidence
without complete assurance remains BLOCKED at those boundaries.

**Decision:** return to the V2 adapter port and actual simplification under the
revised governance contract. No second runtime, OS sandbox, external identity
service or universal security framework is required. This does not certify V2
support: the product is not ported/installed-tested, the selected distinguishable
host-UI source mechanism and complete reviewer assurance are NOT_VERIFIED.
**PR #1190 remains Draft; release and merge remain NO-GO.**

## What changed, explicitly

| Retained product guarantee                                                                  | Removed prerequisite / non-goal                                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `/start` is explicit scope-bound activation; no installation/prompt/hydrate activation      | Independent human-authentication infrastructure as a mandatory porting prerequisite |
| Code owns phases, policy, actor/decision validation and evidence gates                      | Making OpenCode an unbypassable security boundary                                   |
| Actual independent review with frozen subject and exact execution/completion/capture proof  | Universal control of all autonomous provider actions                                |
| Missing/invalid/stale/contaminated evidence cannot yield a valid FlowGuard approval         | Preventing every host/OS side effect outside controlled interfaces                  |
| Preventive denial on intercepted paths, with tested coverage and honest limits              | Compensating for host gaps with a second runtime or sandbox                         |
| Host-neutral canonical owners; native model/effort fidelity; real V1 removal/simplification | Speculative frameworks, model/provider bans and parallel authorities                |

This is an architecture/acceptance-scope change, not a passing experiment.
Old NO-GO/BLOCKED observations keep their original contract and bytes. Current
acceptance is owned by the [revised gates](./phase0-contract-gates.md), not by
silently applying old universal-containment prerequisites to the new contract.

## Evidence baseline remains unchanged

- Checkpoint: `11c191447886c9058f0e8832f7acdfcbd44e59b3`,
  [forensic PR report](https://github.com/koeppben23/governed-runtime/pull/1190#issuecomment-6542734895),
  [exact-SHA CI 41197671713](https://github.com/koeppben23/governed-runtime/actions/runs/41197671713).
  This is historical checkpoint verification, not CI for this scope correction
  or the final merge candidate.
- Installed observations: macOS private CLI/server/client/plugin **2.2.4**, Node
  **22.22.2**, deterministic local provider; not Desktop/TUI/live-provider parity.
  Host binary SHA-256:
  `03fc30769f28dd346d2279baae77ef71308175cd49eb7a5be339d3860ee99ec1`.
- Dated evidence owners: [initial Phase 02](./2026-10-31-2.2.4-phase02/README.md),
  [scope/lifecycle](./2026-10-31-2.2.4-scope-lifecycle/README.md),
  [prevention/reviewer](./2026-10-31-2.2.4-prevention-review/README.md), including
  adjacent source/raw digest facts. No dated report, failed attempt or raw
  evidence is changed or reclassified by this revision.

## Official V2 documentation cross-check

Official living pages read **2026-10-31**, discovered through the
[V2 index](https://opencode.ai/v2/llms.txt). These document interfaces, not pinned
2.2.4 security certification. New interface availability/behavior remains
NOT_VERIFIED until checked where the actual port uses it. No new probe ran for
this revision.

| Official source                                                                                                                                        | Documented mechanism / limit                                                                                                                 | Consequence under the corrected contract                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Plugins](https://opencode.ai/v2/docs/build/plugins), [migration](https://opencode.ai/v2/docs/migrate-v1)                                              | V2 plugin/client contracts differ; server/TUI/GUI parts are separate                                                                         | One V2 adapter at canonical owners; no V1 wrapper/dual product                                                                                                             |
| [Commands — Shell](https://opencode.ai/v2/docs/commands#shell)                                                                                         | Expansion precedes prompt admission, outside tool permissions                                                                                | Keep the observed 3 ms pre-prompt side effect as a prevention limit; do not claim universal file prevention or require a new runtime to fix it                             |
| [Server — Shell / Hooks](https://opencode.ai/v2/docs/build/plugins/server#shell)                                                                       | `shell.create.before` modifies command/cwd/env etc.; published event lacks session/call IDs. Prompt hooks skip shell/synthetic/move controls | Candidate for a particular useful adapter gate, not proven full coverage. Never guess scope/call authority or claim all hooks impossible because another hook was bypassed |
| [Permissions](https://opencode.ai/v2/docs/permissions), [policies](https://opencode.ai/v2/docs/policies)                                               | Host checks and hard-denies exist; shell has host-user authority; policy does not sandbox plugins. `provider.use` removes selection          | Use only the necessary supported scoped mechanisms; disclose uncovered paths and mutable/invalid policy. No global INACTIVE lockdown or model/provider bans                |
| [TUI](https://opencode.ai/v2/docs/build/plugins/cli), [GUI](https://opencode.ai/v2/docs/build/plugins/gui)                                             | Dialogs/programmatic commands; experimental GUI main/IPC and bundle-loading credential                                                       | Usable presentation/integration surfaces, not automatic human attestation. IPC identifies a window, not a human; other plugins can call exposed IPC                        |
| [RPC](https://opencode.ai/v2/docs/build/plugins/rpc), [client](https://opencode.ai/v2/docs/build/client)                                               | Commands/permission replies/RPC are client-callable; events are live-only without replay/reconnect                                           | Host trust is not human origin; record actual source. Correlate reviewer request/history, never reconstruct missing proof from event silence                               |
| [Server — HTTP/WebSocket](https://opencode.ai/v2/docs/build/plugins/server#native-http), [providers](https://opencode.ai/v2/docs/providers#websockets) | HTTP hooks do not see WS frames; experimental WS hooks exist; provider-plugin HTTP hooks can keep applicable routes on HTTP                  | Verify the route used for claimed request/capture evidence, including fallbacks. No inference of universal HTTP coverage, remote containment or an observed WS bypass      |
| [Tools](https://opencode.ai/v2/docs/tools), [agents](https://opencode.ai/v2/docs/agents#steps)                                                         | Code Mode has fetch; some utilities have no permission action; children have own permissions; final enforced step removes tools              | Do not equate permission matching with full capture coverage, parent permissions with child isolation, or tool-free final text with voluntary normal completion            |
| [Models](https://opencode.ai/v2/docs/models), [network](https://opencode.ai/v2/docs/network), [SDK](https://opencode.ai/v2/docs/build/sdk)             | Variants are model-specific; proxies route traffic; embedding removes the HTTP listener                                                      | Preserve native model/default/effort semantics; proxying or embedding is not an independent security boundary and is not required as a workaround                          |

## Trust model and the selected operator-source contract

**Trusted infrastructure:** honestly executing pinned OpenCode, installed
FlowGuard validators and OS/filesystem/runtime primitives. FlowGuard does not
claim resistance to a compromised host/kernel or tamper-proof same-user local
code/state. This trust assumption does not disable schema/digest/audit checks.

**Untrusted authority inputs:** LLM text, model-written provenance, caller tool
arguments, SDK-supplied IDs and provider/MCP replies. They may describe a decision
or execution, but only canonical code and actual host facts can validate it.
Host/API calls made by an agent remain possible; they are not reclassified as
human simply because OpenCode processes them. Shared-resource changes remain
possible and require evidence-freshness validation, not an isolation claim.

**Retained decision requirements:** explicit source/action/scope/policy/generation
binding; canonical actor/policy checks; durable audit and replay/concurrent-use
protection; no model-text activation, direct-hydrate bootstrap or automatic
capacity unlock. No external signer, approval service or hardware touch is
mandatory. An SDK command callback remains NOT_SUPPORTED as independent proof of
a human; the original counterexample remains valid.

**Explicit operator decision (2026-10-31): distinguishable host UI.** Activation,
approval, override, capacity recovery and end require an attributable host-UI
interaction distinguishable from agent/SDK invocation. Source-attributed SDK/CLI/
API commands alone are not admissible, even if explicit and audited. Model text,
ordinary prompts and direct hydrate remain inadmissible. No external signer,
independent identity service or OS boundary is required by this source choice.
OpenCode/OS are trusted here; the source distinction does not require proving
that a compromised OS could never synthesize a UI interaction.

**Mechanism NOT_VERIFIED:** prove how the actual pinned V2 UI supplies that
distinction to the adapter. A dialog's existence, a main-process bundle credential
or an ordinary command callback is not that proof. Do not invent a source field
or treat application-supplied metadata as authoritative UI origin. This blocks
authority acceptance, not all adapter work.

Demonstrate actual explicit UI action and scope/audit binding plus agent/SDK/CLI,
model-text/direct-hydrate, replay, wrong-session/worktree and concurrent-use
negatives. Claims about human origin must match what the selected host surface
actually provides. A successful callback test alone cannot change that assurance.
Actual atomic state/audit consumption is a G-04 product test, not a P0 promise.

## Revised capability decisions

| Capability / fact                                             | Current consequence                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Absent/passive fixture parity                                 | Bounded evidence only; installed FlowGuard INACTIVE still NOT_VERIFIED                                                                    |
| Native scope/child/restart correlation                        | Useful adapter facts; exact canonical scope, moves, caller parent claims and product durability still need validation                     |
| Loaded-hook local tool/Code Mode denial                       | Keep as bounded preventive support; prove actual product gates on claimed controlled paths                                                |
| Advertised MCP deny + executable control                      | SUPPORTED_BOUNDED fixture, not universal MCP or installed acceptance                                                                      |
| Visible hosted-definition pre-dispatch denial                 | SUPPORTED_BOUNDED request gate; does not control autonomous remote effects                                                                |
| Native pre-prompt shell side effect                           | Document uncovered prevention path; no automatic cutover veto and no retroactive prevention claim                                         |
| Unoffered provider actions                                    | Universal containment not supported by evidence and no longer required; never count unobserved execution/effects as valid evidence        |
| Simple reviewer request/terminal chain                        | Feasibility only; frozen subject, independent identity, full completion, same-child JSON and contamination jointly NOT_VERIFIED           |
| Denied reviewer tool followed by terminal / later child reuse | Must reject contaminated/stale/wrong-request capture; do not weaken because general host containment is out of scope                      |
| Native catalogue/effort wire fixture                          | Keep native selection; prove representative actual parent/reviewer/serialization fidelity and output budgeting                            |
| Plugin loss, unknown outcomes, shared writers                 | No valid approval/export through unknown/stale authority; retain locks/quarantine and freshness checks. No plugin-less interception claim |

## Reviewer assurance is not relaxed

Before binding, prove one coherent chain from frozen subject/revision and
obligation/attempt/dispatch through authorized visible child, exact host-owned
request and terminal, effective model/effort and contamination status to validated
structured findings and atomic canonical state/audit binding. Same-child JSON is
the OpenCode target; normal-text serialization must be tool-free and fully
completed. Read-only review work is not permission for tools during serialization.

An observed attempted tool, even denied, contaminates capture; a later answer
cannot overwrite the original invocation. Reject missing history, stale/foreign
responses, extra steps, forced final-step text, truncation, abort, in-flight work
and unknown outcomes. `wait()`, idle, `stop`, text matching or a session header
alone never supplies this joint assurance. If actual required capture coverage
cannot be established, block review approval without demanding remote containment
for unrelated normal host use.

Retain lease ownership, acknowledged abort/stable terminal readbacks, capacity
closure and durable quarantine across restart. No timeout-only unlock or automatic
second child after terminal capacity failure. A new V2 proof generation follows
actual provenance proof; transport generation 5 and `review-assurance.v7` remain
different contracts. No historical normalization, fake parentID or weak transport
composition.

## Work and release decisions

1. Align ADR-010, this report, gates, trust docs and the published #1169 amendment.
   The issue wording below explicitly supersedes the old expanded prerequisites;
   it does not conceal a changed requirement in a passing test.
2. Continue canonical-owner V2 API/lifecycle/installer/adapter simplification where
   behavior does not depend on unresolved operator/reviewer assumptions. Preserve
   [the removal inventory](./implementation-inventory.md); implement actual
   simplification, not another layer around V1.
3. Prove the selected distinguishable host-UI source before authority acceptance, and exact host
   provenance/capture gaps before evidence acceptance. Use narrow mechanism and
   product tests; no broad OS/remote containment campaign or new security system.
4. G-04 proves actual activation/state/audit/recovery transactions; G-05 proves
   built/installed Desktop and CLI product behavior, controlled-path denials,
   native model fidelity, Java/ProofGraph/export/inspect and existing ISO projection.
   Conformance, mutation negatives and documentation/package agreement remain.
5. Release only on the actual merge candidate against current `develop`, exact
   artifacts and passing revised acceptance. Keep one Draft PR #1190, no partial
   merge or premature V2 support claim. Fundamental NO-GO remains possible if
   **governance/evidence correctness** cannot be met simply, not merely because
   FlowGuard cannot prevent every host or remote side effect.

## Published explicit Issue #1169 amendment

The current [issue body](https://github.com/koeppben23/governed-runtime/issues/1169)
was replaced with the corrected contract and directly reconciled implementation/
acceptance checklists on **2026-10-31T16:15:09Z**. The published body was read back
and compared with the prepared text (SHA-256
`940c67a781499084ff3bbdd86708b0890e939850045c22835d4ef28547e4bf2a`).
Title/state were not intentionally changed; old comments remain historical.

The operator's 2026-10-31 scope correction replaces the issue's earlier
“Non-negotiable invariants” item 1 / universal interpretation, “Host execution-path
trust while ACTIVE”, “Release gate”, Phase-0 hosted/native prevention prerequisites
and any acceptance rows that make out-of-interface prevention or independent
human-authentication infrastructure mandatory. It also replaces the universal
independent-authorization prerequisite in “EXPLICIT OPT-IN” and host-neutral
activation intent with revised ADR-010 D3: only a source-attributed host-UI
interaction distinguishable from agent/SDK invocation is an admissible operator
decision. SDK/CLI/API callbacks alone are not admissible. This selected source
contract is not yet proven by the installed V2 evidence.

FlowGuard controls its own authorized governance workflows. Retain explicit
activation, deterministic policy/evidence/approval gates, real independent review,
audit/recovery, native model freedom, host-neutral conformance and actual V1
removal/simplification. Require pre-effect denial on the intercepted paths claimed
by the adapter and honest documentation of uncontrolled native/OS/provider paths.
No universal host/remote containment, second runtime, OS sandbox or separate
authentication service is a migration prerequisite. Outside effects cannot yield
valid stale/contaminated/unproved evidence. SDK callbacks do not prove a human.
Prior probe bytes and statuses remain historical; no old gate is relabelled PASS.
All other requirements, installed Desktop+CLI acceptance, one Draft PR #1190 and
no partial merge remain unchanged. The affected checklists now use this explicit
scope, rather than retaining contradictory universal-prevention requirements
as current release gates.

## Open stability and verification limits

The earlier CI observed two concurrent successful ISO publications where `[0,1]`
was expected. Later isolated/CI passes did not establish the root cause. This
remains an open stability finding, not a diagnosed harmless flake; no unrelated
ISO rewrite, threshold reduction or silent closure is part of this correction.

These changes are documentation only. New operator acceptance, reviewer proof,
controlled-path product enforcement and installed V2 support remain NOT_VERIFIED.
No new probe, runtime state/schema, signature, source inspection, product
transaction or deployment is supplied. Documentation tests enforce consistency,
not the new product behavior. Final commit/build-bound verification and actual
merge-candidate acceptance must be reported separately, not inferred from old CI.
