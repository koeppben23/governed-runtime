# ADR-010: Host-neutral, opt-in governance contract

- **Status:** Accepted as architecture; runtime conformance **NOT_VERIFIED**
- **Date:** 2026-10-31
- **Deciders:** FlowGuard operator
- **Scope:** FlowGuard product semantics and future adapters; OpenCode V2 implementation tracked by [#1169](https://github.com/koeppben23/governed-runtime/issues/1169)
- **Related:** [ADR-008](./008-reviewer-authority-boundaries.md), [ADR-009](./009-model-neutral-review-transport.md), [Phase-0 gates](../host-probes/opencode-v2/phase0-contract-gates.md)

## Context

The OpenCode V2 migration is intentionally breaking and must simplify the touched FlowGuard implementation without weakening evidence, audit, or review authority. The current OpenCode V2.2.4 [installed-host probe](../host-probes/opencode-v2/2026-10-30-2.2.4/README.md) is **NO-GO** for full active governance. Prompt- or plugin-level checks are not equivalent to host-independent prevention. Prior issue comments suggesting a provider/model whitelist are superseded by this decision.

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

### D3. Human decisions use independent operator authorization

The host-neutral domain operation is `StartGovernance` (or `Approve`, `OverrideApprove`, `RecoverCapacity`, `EndGovernance`). `/start` is the OpenCode user-facing command spelling, not proof of human origin. Every security-significant operator decision needs a non-replayable, action/scope/generation-bound attestation from a **host-authoritative human UI channel** or **independently authenticated operator channel**. A locally executed CLI command or agent-writable token is insufficient if an agent can invoke it with the same authority. The latter mechanism is a design option, not a feature already implemented or a proved OS boundary.

**P0 blocker:** OpenCode V2.2.4 has not demonstrated trustworthy command origin. No automatic capacity-lock release or active start may be claimed before it is proven.

### D4. One STRICT governance profile; two separate assurances

FlowGuard currently defines **one** strict, evidence-backed active-governance contract. No relaxed/best-effort mode may mint equivalent approvals.

1. **Governance/evidence integrity:** invalid identity, authorization, reviewer completion, evidence, policy or audit prevents a valid FlowGuard authorization/export.
2. **Preventive host control:** prohibited side effects are refused _before_ execution only for execution paths with **real, tested** interception or an independent host/OS guard.

An absent/crashed/unloaded plugin cannot enforce host hooks. Its absence is harmless to INACTIVE native usage, but cannot silently validate formerly ACTIVE work. Without an independent host/OS mechanism, do **not** assert post-unload prevention, external API containment, or security against ungoverned sibling processes.

A mandatory unsafe path must be disabled/prevented, or the affected governed action/certification is `NOT_SUPPORTED` / **NO-GO**. Evidence quarantine alone cannot retroactively prevent side effects.

### D5. All host-native models and effort variants remain available

The host owns its selectable model catalogue and per-model reasoning/effort variants, including unset/default and host-specific values. FlowGuard MUST NOT introduce provider/model allowlists, silent replacements, reasoning reduction or a universal token cap. The operator's selected parent/reviewer configuration, **effective** host resolution and **attested** evidence execution are separate facts. Native host-authorized fallbacks may occur, but review evidence must bind the exact effective model/effort for each execution; an unproved mid-review switch invalidates the required assurance.

Host capability gates are about **execution paths, not model names**. A model can be selectable while its governed workflow is explicitly unsupported (e.g. unpreventable hosted side effects, missing review execution capability). Selection is not a guarantee of task quality, eventual completion or universal provider containment.

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

- OpenCode V1 is not retained as a product path after the V2 breaking replacement; other host integrations retain their currently **verified** support rather than inferred parity.
- P0 must first prove inactive noninterference, operator authorization, preventive boundaries, exact reviewer provenance, model/effort fidelity and recovery. Until then **NO-GO** for supported active V2 governance.
- [Phase-0 test plan](../host-probes/opencode-v2/phase0-contract-gates.md) is the executable gate; it does not assert that any unrun test passed.
- Scope, historical proof artifacts, evidence generations and migration decisions must be truthful. Existing ADRs/probe reports remain historical records, not silently rewritten claims.
