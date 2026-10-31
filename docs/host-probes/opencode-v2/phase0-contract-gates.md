# OpenCode V2 Phase-0: contract gates (2026-10-31)

- **Status:** **NO-GO** for full active FlowGuard V2 integration as of 2026-10-31.
- **Scope:** Pinned Desktop + CLI/server V2.2.4 candidate, each independently installed/probed.
- **Normative design:** [ADR-010](../../decisions/010-host-neutral-opt-in-governance.md).
- **Existing evidence:** [2026-10-30 real-host report](./2026-10-30-2.2.4/README.md) and [P0 security follow-up](./2026-10-30-2.2.4/P0_SECURITY_GATE.md). These are historical observations; do not relabel old probes to fit the new opt-in contract.
- **Implementation inventory:** [Phase-01 ownership and simplification findings](./implementation-inventory.md). No production V2 port or new host-security PASS is implied.
- **Probe trust model:** [Phase-02 attacker capabilities and trusted components](../../trust-boundaries.md#opencode-v2-phase-02-probe-threat-model-1169). This bounds feasibility observations; it does not exempt mandatory product guarantees or establish an operator channel.
- **Current bounded checkpoint:** [2026-10-31 Phase-02 observations](./2026-10-31-2.2.4-phase02/README.md): absent/passive fixture parity only; model-driven shell reproduced command admission. Overall gates remain NO-GO.

## Evidence vocabulary

- `SUPPORTED`: reproducing a specific property with version-pinned installed-host positive **and relevant adversarial** cases.
- `NOT_VERIFIED`: incomplete or absent real-host proof; not a passing result.
- `NOT_SUPPORTED`: actual tested/confirmed inability to meet the exact claim under the specified scope.
- `NO-GO`: a required active-scope contract has no passing proof. A missing host prevention mechanism must not be silently replaced by documentation, model prompts or provider whitelists.

Each gate records host build, Desktop/CLI surface, SDK/adapter artifact hash, official docs URL/date, exact commands, fixtures, negative-side-effect trace, result and justified scope.

## Mandatory gates

| Gate                                         | Required demonstrated result                                                                                                                                                                                                                 | Current known evidence / next action                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-00 **Native parity**                      | Host without FlowGuard and installed-but-INACTIVE host both allow normal commands, shell/edit, native providers, models/variants, without injected mandates or implicit hydrate. Plugin failure before activation does not block native use. | **NOT_VERIFIED** for installed FlowGuard. New absent/passive loader fixture supports bounded schema/catalogue/permission, shell and mock-effort parity only. Historical provider-removal lockdown is not INACTIVE acceptance.                                                                                         |
| P0-01 **Operator authority**                 | Human `/start` and subsequent approve/recover/end actions have independently verifiable, nonreplayable origin. SDK/child/model text/direct `/hydrate` cannot produce that authority.                                                         | **BLOCKED** pending independent operator proof. The new real model-driven shell reproduced SDK command admission using an agent-accessible fixture credential: that API/callback alone is **NOT_SUPPORTED** as human-origin proof. Real human TUI/Desktop and alternate independent channels remain **NOT_VERIFIED**. |
| P0-02-H **Host scope/lifecycle feasibility** | Prove authoritative session/worktree identity, child lineage, lifecycle/restart observations and the host mechanisms needed for durable activation. A bounded probe tests mechanisms, not later FlowGuard correctness.                       | **NOT_VERIFIED**; exact mapping, races and failure observations need real-host evidence.                                                                                                                                                                                                                              |
| P0-03 **Local pre-effect controls**          | Governed file edit, shell, custom and Code Mode tool side effects denied _before_ execution and audited, including failures/reloads.                                                                                                         | Local edit/shell/Code Mode **SUPPORTED in limited probe scope** when plugin hooks loaded; full ACTIVE lifecycle **NOT_VERIFIED**.                                                                                                                                                                                     |
| P0-04 **MCP and provider-hosted actions**    | Advertised MCP tool and hosted/provider-executed tool effects gated or isolated before any effect. Unoffered provider actions and native shell interpolation accounted for.                                                                  | MCP advertised-tool negative **NOT_VERIFIED**; local before-hook absent for provider-executed path. Native Markdown shell interpolation observed **before** prompt admission. Universal preventive guarantee **NOT_SUPPORTED** with hook-only design.                                                                 |
| P0-05 **Reviewer identity/completion**       | Verified isolated visible reviewer, model/variant/effort, single coherent structured capture, exact request→terminal assistant chain and bounded fail-closed recovery.                                                                       | Visible same-child follow-up demonstrated; V2 assistant `parentID` missing, so V1 evidence-generation-5 equivalence **NOT_SUPPORTED**. Replacement host proof and a new evidence generation **NOT_VERIFIED**. `session.wait()`/idle alone not success.                                                                |
| P0-06 **All native models/variants**         | Host-reported catalog and model-specific effort choices remain selectable in ACTIVE/INACTIVE; representative actual final request options match selected/effective reviewer/parent/JSON variants; no FlowGuard allowlist.                    | Selected V2 wire variant demonstrated in probe; **full selection/nonfilter contract NOT_VERIFIED**. Test unspecified/default and max where supported; do not pretend all providers were live certified.                                                                                                               |
| P0-07 **Mixed sessions and resource safety** | ACTIVE & INACTIVE concurrently, no policy/context leakage; shared resources either independently prevented or stale evidence quarantined, with prevention explicitly NOT_SUPPORTED.                                                          | **NOT_VERIFIED**; session isolation alone does not mean exclusive resource control.                                                                                                                                                                                                                                   |
| P0-08 **Plugin failure/unknown outcomes**    | Formerly ACTIVE lost hooks/state cannot produce valid approval/export; unknown reviewer and capacity outcomes remain durable, restart-safe and recover only via verified operator authority.                                                 | **NOT_VERIFIED**; plugin disappearance cannot itself stop the host.                                                                                                                                                                                                                                                   |
| P0-09 **Documentation and build**            | Official vendor docs + installed evidence matrix, versioned host capability, new evidence format, tests, docs, CHANGELOG and package agreement; no stale V1 claims in shipped adapter.                                                       | **NOT_VERIFIED**; requirements tracked by ADR-010 and #1169.                                                                                                                                                                                                                                                          |
| P0-10 **Portability architecture**           | HAI permits a separate minimal non-OpenCode conformance adapter without duplicated core policy and without native OpenCode Task dependence.                                                                                                  | Current HAI uses closed platform IDs and native Task transport; **NOT_VERIFIED** until refactored and contract-tested.                                                                                                                                                                                                |

## Decision algorithm

1. Verify P0-00 first; do not impose a global runtime restriction to make ACTIVE look safe.
2. For any ACTIVE path, if required before-effect prevention, operator proof or reviewer lineage is `NOT_SUPPORTED` / `NOT_VERIFIED`, deny **that governed operation**; do not issue valid evidence or silently switch models/effort.
3. If all **mandatory** capabilities for the proposed STRICT scope are demonstrated, record **GO for that precisely enumerated scope**; other paths remain unsupported. If the only route to a universal-prevention claim is an independently enforced launcher/OS boundary, decide and probe that explicitly. Never assume the plugin can enforce after unloading.
4. Keep the normal host unrestricted when FlowGuard is not installed or is INACTIVE. The scope of limitations must be visible to the operator.
5. Re-run version-bound tests after host or adapter updates. Documented APIs alone do not authorize `SUPPORTED`.

## Feasibility versus product acceptance

**G-P0 proves host-mechanism feasibility only.** P0-02-H does not certify an
unimplemented FlowGuard transaction, activation record or recovery path. Likewise,
probe tests for P0-07/P0-08 establish available isolation/failure mechanisms, not
the correctness of the eventual production integration. P0-09/P0-10 product
conformance and distribution checks must be completed after implementation.

**G-04 / P0-02-P proves product correctness:** actual INACTIVE/ACTIVATING/ACTIVE/
BLOCKED authority, atomic authorization consumption and persistence, audit
coupling, concurrent starts, restart, child propagation, corrupt/deleted records,
capacity locks and authorized deactivation. A missing single state file must not
erase the fact that a scope was previously ACTIVE.

**G-05 proves installed integration:** repeat the security and lifecycle cases
with the built/installed FlowGuard artifact on Desktop and CLI/server separately.
No probe, successful inbox admission, idle event or `session.wait()` alone can
replace exact reviewer completion proof.

Before choosing an operator channel, resolve the trust boundaries in the
[inventory](./implementation-inventory.md#trust-boundaries-before-security-implementation).
An agent-callable CLI or readable token is not independent operator authority.
After `EndGovernance`, removing an instruction entry does not erase conversation
history or compacted mandates. Prove an adequate context reset or require a new
session for native INACTIVE use; retain the old governed transcript and audit.

Final acceptance uses the actual merge candidate against current `develop`, with
commit/build/artifact-bound verification rerun after relevant changes. No second
integration PR or partial merge is allowed; PR #1190 remains Draft while any
mandatory gate is unresolved.

## Implementation order and verification

1. Collect an official-docs-backed contract matrix; preserve existing evidence verbatim.
2. Prove operator origin and ACTIVE trust scope; if absent, stop at **NO-GO** and evaluate an independently authenticated action channel.
3. Prove local/MCP/hosted/native command path capabilities; no provider/model identity exclusions.
4. Prove reviewer provenance and a new V2 evidence generation from exact host facts.
5. Prove model/effort pass-through, mixed sessions, recovery and noninterference.
6. Only then complete the breaking V2 adapter, run installed Desktop+CLI end-to-end Java workflow, ProofGraph, export and ISO projection with adversarial tests.

**Not implemented by this document:** working V2 hooks, an operator-auth service, runtime isolation, or passing E2E security tests.
