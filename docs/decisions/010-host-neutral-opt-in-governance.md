# ADR-010: Host-neutral, opt-in governance contract

- **Status:** Accepted as architecture; runtime conformance **NOT_VERIFIED**
- **Date:** 2026-10-31
- **Scope revision:** 2026-10-31, explicit operator correction from host containment to governed-decision integrity; see the amendment below.
- **Deciders:** FlowGuard operator
- **Scope:** FlowGuard product semantics and future adapters; OpenCode V2 implementation tracked by [#1169](https://github.com/koeppben23/governed-runtime/issues/1169)
- **Related:** [ADR-008](./008-reviewer-authority-boundaries.md), [ADR-009](./009-model-neutral-review-transport.md), [Phase-0 gates](../host-probes/opencode-v2/phase0-contract-gates.md)

## Context

The OpenCode V2 migration is intentionally breaking and must simplify the touched FlowGuard implementation without weakening evidence, audit, or review authority. The OpenCode V2.2.4 [installed-host probe](../host-probes/opencode-v2/2026-10-30-2.2.4/README.md) recorded **NO-GO** against its then-current acceptance contract. Those observations remain unchanged; they are not a passing product test under the revised contract. Prompt- or plugin-level checks are not host-independent prevention. Prior issue comments suggesting a provider/model whitelist remain superseded.

## Explicit scope amendment (2026-10-31)

This is an intentional architecture change, not a reinterpretation of old PASS,
NO-GO or BLOCKED evidence. It replaces the earlier D3 requirement for independent
human-origin attestation as a universal activation/porting prerequisite and the
earlier D4/release-gate interpretation that every reachable host/OS/provider
side-effect path must be independently contained before V2 porting can proceed.
The revised D3/D4 and release criteria below are authoritative. D1/D2 and
D5–D10 remain in force except for the explicit prevention-scope clarification.

**Product contract:** explicit activation; deterministic phases/policies/evidence
and approval validation; actual independent reviewer execution; fail-closed
FlowGuard decisions; host-neutral core; all native models/effort choices; actual
V1 removal and simplification. OpenCode, the installed FlowGuard code and the OS
are trusted infrastructure for these checks. Model text, tool arguments and
provider replies are inputs, not governance or provenance authority.

FlowGuard controls its authorized workflows through supported host interfaces.
It does not promise an unbypassable boundary around the entire host, filesystem,
process tree or remote provider. A second runtime, OS sandbox, independent
authentication service or general security framework is **not required or
authorized as compensation** for missing host guarantees. Explicit controlled-path
prevention and honest limits remain mandatory; reviewer/evidence correctness is
not relaxed. See the [revised decision report](../host-probes/opencode-v2/p0-feasibility-decision.md)
for changed requirements, retained blockers and the selected operator-source contract.

## Options

1. **Always-on host lockdown or provider whitelist.** Rejected: breaks ungoverned host operation, native model choice and portable semantics; still bypassable after plugin failure.
2. **Best-effort advisory review with valid-looking approvals.** Rejected: creates unsupported security assertions.
3. **Explicit opt-in, host-neutral STRICT governance with capability-scoped prevention and independent evidence assurance.** **Chosen.** Its limitations must be reported precisely, not disguised as successful full isolation.

## Decision

### D1. One canonical product core, many host adapters

FlowGuard core owns policy, workflow states, authorization decisions, evidence requirements, independent-review assurance, ProofGraph, audit and archive authority. It **MUST NOT** import host SDK/types or branch by OpenCode/Cursor/Claude Code/Codex names. Host adapters own SDK hooks, command surfaces, activation proof, identity mappings, tool and hosted-execution interception, subagent transport, context injection, effective model/variant extraction and wire diagnostics.

The existing [HAI](../../src/adapters/host-adapter.ts) is a starting point, **not** verified cross-host completeness. Its closed host identifiers, OpenCode-native review transport type and static boolean capabilities require minimal, evidence-backed refinement. Do not add a general-purpose agent framework or competing state/policy/evidence authority. Future host onboarding is **additive** and independently certified against the same host-neutral conformance suite; this ADR **does not claim** Cursor/Claude Code/Codex parity or implement their adapters in #1169.

### D2. Activation is explicitly opt-in and scope-bound

- **No FlowGuard installed:** host works natively.
- **Installed but no trusted operator activation (`INACTIVE`):** host works natively. No global mandates, provider/model restrictions, permission changes, shell/tool vetoes, automatic hydration or FlowGuard workflow enforcement. Registering an inert start/help affordance is allowed.
- **`ACTIVATING`:** validate operator origin, host trust contract, exact workspace/worktree + root session/authorized descendants, policy snapshot and activation generation; commit authority atomically before governed actions.
- **`ACTIVE`:** enforce the verified host-execution capability contract and FlowGuard's governance decisions inside that exact scope.
- **`BLOCKED`:** active/formerly-active authority has become corrupt, ambiguous or unavailable. No governed release, evidence or approval; never silently reinterpret this as INACTIVE.

A **verified absence** of an activation record differs from a storage/read error. Activation authority survives host restart and is not inherited by arbitrary sessions in the same repository. `/finish` and `/abort` terminate their workflow, not the activation implicitly. An explicitly authorized `EndGovernance` closes activation only after safe resolution of open obligations; interrupted/ambiguous transitions remain BLOCKED. Model prompts, SDK-generated `/start` text, direct `/hydrate` and plugin installation do not activate governance.

### D3. Explicit, attributable operator decisions within trusted infrastructure

The host-neutral operations are `StartGovernance`, `Approve`, `OverrideApprove`,
`RecoverCapacity` and `EndGovernance`; `/start` is the OpenCode activation action.
Each accepted decision must be explicit, attributable to its actual source,
bound to its action/session/worktree/policy/activation generation, validated by
the existing actor/policy authority and durably audited with replay/concurrent-use
protection. Installation, ordinary prompts and model assertions are not decisions.
Direct hydrate cannot create activation; automatic capacity-lock release remains
prohibited. No external authentication service or hardware attestation is a
product prerequisite.

Trusting the host/OS to execute correctly does **not** authenticate a human behind
every API request. An SDK command callback proves command execution, not human
origin. Record that distinction; never relabel an agent-accessible host API as
human proof. **Operator-source decision (2026-10-31):** activation, approvals,
overrides, capacity recovery and deactivation require an explicit, attributable
**host-UI interaction distinguishable from agent/SDK invocation**. SDK/CLI/API
callbacks alone are not admissible operator decisions, even when explicit and
audited. This is a host-interface source requirement, not a demand for an
independent authentication service or hardware/OS isolation.

The source distinction is evaluated with OpenCode and the OS trusted. It does
not require preventing a compromised OS from synthesizing UI input; do not grow
this adapter requirement into a universal anti-spoofing platform.

The concrete V2 UI-to-adapter source distinction remains **NOT_VERIFIED**; no
undocumented source flag or ordinary callback may be invented as its substitute.
Authority-bearing acceptance is BLOCKED until that mechanism is demonstrated.
Only the affected decision path is blocked; this does not stop adapter
simplification/porting work independent of that proof.

### D4. One STRICT governance profile; two separate assurances

FlowGuard currently defines **one** strict, evidence-backed active-governance contract. No relaxed/best-effort mode may mint equivalent approvals.

1. **Governance/evidence integrity:** invalid identity, authorization, reviewer completion, evidence, policy or audit prevents a valid FlowGuard authorization/export.
2. **Controlled-path prevention:** on host paths FlowGuard actually intercepts and claims to govern, prohibited operations are refused _before_ execution with real, tested gates. This is not universal host/OS/provider containment.

An absent/crashed/unloaded plugin cannot enforce host hooks. Its absence is harmless to INACTIVE native usage, but cannot silently validate formerly ACTIVE work. Do **not** assert post-unload prevention, external API containment or protection against ungoverned sibling processes. Trusted infrastructure is an operational assumption, not a claim that local same-user code or state is tamper-proof.

Paths outside interception, including native command shell expansion and
autonomous remote actions, must have explicit coverage/limitation reporting.
Their lack of universal preventive coverage is not by itself a V2 cutover
blocker and must not cause model/provider bans. If a FlowGuard-owned operation
needs an unavailable capability, or outside activity makes required evidence
stale, incomplete, contaminated or ambiguous, block that operation/approval.
No unobserved effect may be represented as prevented, executed or audited.
Evidence quarantine cannot undo an already completed side effect. During review
serialization, any observed tool attempt contaminates capture even if denied;
if complete required capture assurance is unavailable, no review may bind.

### D5. All host-native models and effort variants remain available

The host owns its selectable model catalogue and per-model reasoning/effort variants, including unset/default and host-specific values. FlowGuard MUST NOT introduce provider/model allowlists, silent replacements, reasoning reduction or a universal token cap. The operator's selected parent/reviewer configuration, **effective** host resolution and **attested** evidence execution are separate facts. Native host-authorized fallbacks may occur, but review evidence must bind the exact effective model/effort for each execution; an unproved mid-review switch invalidates the required assurance.

Host capability gates are about **execution paths, not model names**. A model
remains selectable even if a particular required workflow or review capture
cannot be completed with valid assurance. Uncontrolled remote activity is a
documented prevention limit, not an automatic model/workflow ban; missing required
review capability still blocks review approval. Selection is not a guarantee of
task quality, eventual completion or universal provider containment.

### D6. Host capability evidence is granular and versioned

For each host + installed build + surface (Desktop/CLI/IDE/cloud/headless) + execution path (local tool, shell/native command, MCP, hosted/provider-executed action, subagent), record:

- Documented vendor contract and documentation date.
- Inspected SDK/source contract where applicable.
- Reproducible installed-host **positive and negative side-effect evidence**.
- Preventive-before-effect availability, authoritative identity/lineage, failure-time semantics, scope, limits and status: `SUPPORTED`, `NOT_SUPPORTED`, or `NOT_VERIFIED`.

A static `preToolBlock: true` and a documented hook do not by themselves prove preventive coverage. Vendor APIs differ and can change; a host version upgrade invalidates unsupported compatibility assumptions until rechecked.

### D7. Reviewer assurance, not a universal native transport

A valid independent review needs frozen subject, isolated identity/permissions, navigable child or equivalently inspectable independent execution, exact request/response lineage, effective model/effort provenance, full normal terminal completion and coherent tool-free structured findings capture. The deterministic gate binds only complete validated evidence; ProofGraph never treats raw host text as attestation.

For OpenCode, [ADR-009](./009-model-neutral-review-transport.md) established native Task + same-child JSON under V1. This is an **adapter-specific baseline**, not a cross-host recipe. OpenCode V2 must prove its **own** equivalent lineage and use a new evidence generation when V1 `response.parentID` cannot be attested. Future hosts may use other **single coherent** transports if they prove the same assurance. Never combine unrelated weak transports.

### D8. Resource scope, lifecycle, and concurrency

Session-scoped opt-in must not affect an unrelated ungoverned session. Shared worktrees do **not** imply exclusive resources. Prefer isolated worktrees, exact Git revision/digest binding, stale-evidence detection and safe concurrency. Independent preventive protection against writes from other sessions/processes requires an actual host/OS boundary; absent that, record prevention `NOT_SUPPORTED` and never claim exclusive control.

### D9. Simplicity, canonical ownership and no legacy

The migration **MUST remove accidental complexity in every touched and directly dependent surface**: obsolete V1 hooks/shims, duplicate SSOT, redundant branches, speculative abstractions and pointless pass-through layers. The easiest _correct final architecture_, not smallest diff, determines acceptance. Preserve audit/evidence semantics, mutation-negative tests and comprehensible error/recovery paths. Keep unrelated core/ISO work outside #1169.

### D10. Documentation, changelog and drift are merge contracts

**Every PR** updates `CHANGELOG.md` under `[Unreleased]`, even docs-only/refactor/test changes. All **affected** docs (README/ADRs/commands/help, host capabilities, examples, installer, schemas, recovery and release notes) change in the **same PR**; no deferred updates or contradictory authoritative sources. CI must enforce changelog presence and existing generated documentation drift tests; reviewers must check semantic code/tests/docs/distribution alignment that cannot be fully automated. No changelog or impacted-doc drift is a merge blocker.

## Official host references (not security certification)

- [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins/) and [V1→V2 migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [Cursor hooks](https://cursor.com/docs/hooks) and [plugins](https://cursor.com/docs/plugins)
- [Codex hooks](https://developers.openai.com/codex/hooks) and [configuration](https://developers.openai.com/codex/config-reference)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [subagents](https://code.claude.com/docs/en/sub-agents)

These references describe official **interfaces**, not FlowGuard-certified behavior. Installed-host probes take precedence over unverified assumptions. Record exact vendor document/version and the host build at each actual integration.

## Consequences and release gate

- Implementation status: the native `Plugin.define` entrypoint and semantic
  client replacement are work in progress in PR #1190, not completed
  cutover or installed support. Native boundary tests cannot establish D3
  operator origin or D7 reviewer assurance. Remaining fixture/SDK-tooling removal,
  regression failures and native-content/lifecycle limits are tracked in the
  [implementation inventory](../host-probes/opencode-v2/implementation-inventory.md#native-entrypointclient-implementation-in-progress).
- OpenCode V1 is not retained as a product path after the V2 breaking replacement; other host integrations retain their currently **verified** support rather than inferred parity.
- Porting/simplification may proceed against the revised contract without a sandbox, second runtime or universal provider-prevention proof. Actual authority acceptance still requires proof of the selected D3 distinguishable host-UI source; reviewer binding requires exact provenance and completion proof. No unresolved high-risk assumption may enter implementation.
- Release still requires installed INACTIVE noninterference, explicit scope-bound activation/decisions, deterministic gates, controlled-path negative tests, reviewer/evidence/audit integrity, native model/effort fidelity, durable recovery, conformance, simplification and full installed Desktop/CLI acceptance. These remain NOT_VERIFIED, so supported ACTIVE V2 governance and merge remain NO-GO. Missing out-of-scope containment alone is no longer a release blocker.
- [Phase-0 test plan](../host-probes/opencode-v2/phase0-contract-gates.md) is the executable gate; it does not assert that any unrun test passed.
- Scope, historical proof artifacts, evidence generations and migration decisions must be truthful. Existing ADRs/probe reports remain historical records, not silently rewritten claims.
