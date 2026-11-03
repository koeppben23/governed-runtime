# ADR-010: Host-neutral, opt-in governance contract

- **Status:** Accepted as architecture; runtime conformance **NOT_VERIFIED**
- **Date:** 2026-10-31
- **Scope revision:** 2026-11-02, explicit operator correction preserving V1 functional parity and authorized autonomous activation; 2026-11-03, native command channel as the operator decision source; see the amendments below.
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

## Explicit parity and autonomous-activation amendment (2026-11-02)

This operator decision replaces the **blanket host-UI source requirement for
activation** selected on 2026-10-31 in D2/D3 and the corresponding release gates.
It also replaces any interpretation that equates every policy-authorized automatic
workflow action with a human approval. It does not retrospectively change probe
results or claim that a new activation path has been implemented.

**V1 functional parity is mandatory:** preserve existing product capabilities and
governance guarantees, including policy-permitted fully autonomous workflows.
Explicit activation and stronger human-source checks are new V2 architecture
requirements, not evidence that V1 required them. New V2 mechanisms may improve
safety but MUST NOT eliminate existing capabilities. This is behavioral parity,
not authorization to retain V1 source, SDK shims or obsolete evidence formats.

Activation MUST support both explicit interactive use and explicitly authorized
autonomous use. Human UI evidence is not a prerequisite for every autonomous
start. An autonomous request is not self-authorizing: canonical actor/policy
validation, scoped durable authority, audit and replay/concurrent-use protection
still apply. Record its actual nonhuman source; do not manufacture human consent.
The concrete autonomous adapter is now the explicit native plugin RPC
`flowguard-governance.StartGovernance`, sharing canonical Start preparation,
actor/policy checks, activation lock, audit and confirmation admission. Its
disabled-by-default permission and host-bound request contract are documented in
[configuration](../configuration.md#autonomous-governance-activation-opencode-v2).
Installed-host acceptance remains **NOT_VERIFIED**.

Human gates remain policy-dependent. The decision channel for operator actions is
set by the 2026-11-03 amendment below; no channel is relabelled as human proof.
Authorized activation grants no implicit approval, override,
capacity recovery or End authority. Each operation retains its own canonical
actor/policy, evidence and safe-recovery prerequisites; no automatic capacity
unlock or newly invented policy exception follows from this amendment.

The independent AI reviewer remains an automatable V1 core capability with the
same mandatory identity/evidence/completion/release guarantees. Existing V1
policy exceptions remain, but MUST NOT be expanded or invented to bypass Finding 6. A human is not required to execute an independent AI review. Finding 5 now
requires separate interactive and autonomous activation implementations; Finding
6 remains an unfinished parity port, not an optional feature. Release stays NO-GO
until the applicable product and installed-host positives actually pass.

## Native command channel amendment (2026-11-03)

This operator decision replaces the requirement, selected on 2026-10-31 and
retained on 2026-11-02 for actual human decisions, that a decision come from a
**host-UI interaction distinguishable from agent/SDK invocation**. OpenCode V2
offers no such distinguishable source: the P0-01 probe shows that a plugin
command callback runs identically for UI, SDK and agent-shell callers. The
requirement is withdrawn for OpenCode instead of being simulated.

- The native plugin command hook is the decision source for interactive operator
  actions. Each decision is recorded as channel `host_command` together with the
  actor resolved by the canonical actor authority under the frozen policy
  (`src/state/governance-activation.ts`). `host_command` names a channel; it is
  never a verified-human claim and is never relabelled as one.
- Whether a `host_command` decision satisfies a gate is decided by policy and the
  existing actor-assurance vocabulary, not by the channel.
- Autonomous activation is a separate `autonomous` channel, admissible only when
  `governance.autonomousActivation` permits it and the canonical actor/policy
  authority authorizes it; configuration alone is never proof. A child enrolled
  through native delegation records `delegation` and the root actor.
- One decision keeps one channel and one actor across its revisions. An
  interrupted Start is completed only under the same decision and actor.
- Start authorizes no approval, override, capacity recovery or End.

**Implementation status (2026-11-03):** interactive `/start` is implemented as the
native `start` command and covered by component tests; installed-host acceptance
remains **NOT_VERIFIED**. Autonomous activation and native `host_command` Approve,
OverrideApprove, RequestChanges, Reject and ReviewDecision now share their
canonical lifecycle/decision and audit paths. RecoverCapacity and EndGovernance
are not yet connected and stay blocked. Native decision operations bind the
current subject and source rather than issuing a TTL permission for a later model
call; activation supplies no gate approval.

## Decision

### D1. One canonical product core, many host adapters

FlowGuard core owns policy, workflow states, authorization decisions, evidence requirements, independent-review assurance, ProofGraph, audit and archive authority. It **MUST NOT** import host SDK/types or branch by OpenCode/Cursor/Claude Code/Codex names. Host adapters own SDK hooks, command surfaces, activation proof, identity mappings, tool and hosted-execution interception, subagent transport, context injection, effective model/variant extraction and wire diagnostics.

The existing [HAI](../../src/adapters/host-adapter.ts) is a starting point, **not** verified cross-host completeness. Its closed host identifiers, OpenCode-native review transport type and static boolean capabilities require minimal, evidence-backed refinement. Do not add a general-purpose agent framework or competing state/policy/evidence authority. Future host onboarding is **additive** and independently certified against the same host-neutral conformance suite; this ADR **does not claim** Cursor/Claude Code/Codex parity or implement their adapters in #1169.

### D2. Activation is explicitly opt-in and scope-bound

- **No FlowGuard installed:** host works natively.
- **Installed but no authorized activation (`INACTIVE`):** host works natively. No global mandates, provider/model restrictions, permission changes, shell/tool vetoes, automatic hydration or FlowGuard workflow enforcement. Registering an inert start/help affordance is allowed.
- **`ACTIVATING`:** validate the actual interactive or autonomous source and its authorization, host trust contract, exact workspace/worktree + root session/authorized descendants, policy snapshot and activation generation; commit authority atomically before governed actions. Autonomous activation does not require human UI evidence.
- **`ACTIVE`:** enforce the verified host-execution capability contract and FlowGuard's governance decisions inside that exact scope.
- **`BLOCKED`:** active/formerly-active authority has become corrupt, ambiguous or unavailable. No governed release, evidence or approval; never silently reinterpret this as INACTIVE.

A **verified absence** of an activation record differs from a storage/read error. Activation authority survives host restart and is not inherited by arbitrary sessions in the same repository. `/finish` and `/abort` terminate their workflow, not the activation implicitly. An explicitly authorized `EndGovernance` closes activation only after safe resolution of open obligations; interrupted/ambiguous transitions remain BLOCKED. Model prompts, tool calls, direct `/hydrate` and plugin installation do not activate governance. The native `/start` command does, recorded as `host_command` under the 2026-11-03 amendment, also when an SDK client invokes it. A dedicated autonomous activation request may do so only after canonical authorization and durable commit.

### D3. Explicit, attributable decisions and policy-dependent human gates

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
origin or authorization by itself. **Current source decision (2026-11-02):**
separate explicit interactive activation, explicitly authorized autonomous
activation and actual human approvals. SDK/CLI/API requests are admissible
transport candidates for autonomous activation, subject to demonstrated canonical
authorization; they MUST NOT be relabelled as human proof. Where policy requires
a human decision, require an attributable **host-UI interaction distinguishable
from agent/SDK invocation**. Where existing policy permits automatic progression,
do not add a human gate merely because the V2 port lacks reviewer or activation
implementation. This is not an independent authentication-service requirement.
For OpenCode, the distinguishable host-UI requirement in this paragraph is
superseded by the 2026-11-03 amendment; the channel is recorded as `host_command`.

The source distinction is evaluated with OpenCode and the OS trusted. It does
not require preventing a compromised OS from synthesizing UI input; do not grow
this adapter requirement into a universal anti-spoofing platform.

Interactive `/start` is implemented through the native command channel; the
autonomous operation uses explicit plugin RPC with server-resolved authorization.
Installed-host acceptance remains **NOT_VERIFIED**. The autonomous path requires
its own demonstrated authorization; a caller's `origin`, command text or ordinary
callback cannot supply it. No undocumented source flag or open high-risk
assumption may enter either path. Continue independent porting work without
claiming that either implementation is already accepted.

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

A required independent AI review MUST remain fully automatable with V1-equivalent
governance guarantees. Preserve only existing policy exceptions; do not make
review optional or add human intervention to compensate for the V2 migration.
Finding 6 remains a release-blocking missing implementation until the required
actual reviewer positives pass.

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
- Porting/simplification may proceed against the revised contract without a sandbox, second runtime or universal provider-prevention proof. Actual authority acceptance requires the appropriate demonstrated D3 path: the `host_command` channel with the canonically resolved actor, or explicitly authorized autonomous activation, never a fabricated human equivalence. Reviewer binding requires exact provenance and completion proof. No unresolved high-risk assumption may enter implementation.
- Release still requires installed INACTIVE noninterference, explicit scope-bound activation/decisions, deterministic gates, controlled-path negative tests, reviewer/evidence/audit integrity, native model/effort fidelity, durable recovery, conformance, simplification and full installed Desktop/CLI acceptance. These remain NOT_VERIFIED, so supported ACTIVE V2 governance and merge remain NO-GO. Missing out-of-scope containment alone is no longer a release blocker.
- [Phase-0 test plan](../host-probes/opencode-v2/phase0-contract-gates.md) is the executable gate; it does not assert that any unrun test passed.
- Scope, historical proof artifacts, evidence generations and migration decisions must be truthful. Existing ADRs/probe reports remain historical records, not silently rewritten claims.
