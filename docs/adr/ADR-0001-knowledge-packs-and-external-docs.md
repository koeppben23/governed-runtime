# ADR-0001: Knowledge Packs and External Documentation Authority

- Status: Accepted
- Date: 2026-04-21
- Decision Class: Architecture and Policy
- Scope: Governance contract only (no runtime implementation)

## Context

FlowGuard now has strong local repository evidence (root stack facts, module-scoped facts, database facts, Python/Rust/Go facts, verification candidates, and hardened output contracts).

The next gap is version-specific external knowledge (for example framework migration specifics and toolchain changes) without introducing authority drift, non-determinism, or open-fail behavior.

This ADR defines how external documentation may be used in future phases without changing SSOT ownership or fail-closed guarantees.

## Decision

FlowGuard MAY use loaded external documentation artifacts, but only as advisory Knowledge Packs with explicit provenance.

Knowledge Packs MUST NOT become SSOT and MUST NOT override existing authority layers.

### Core Rules

1. Stable profile rules remain version-neutral by default.
2. Repo evidence and session state remain higher authority than external docs.
3. External docs are advisory evidence only, never SSOT.
4. Knowledge Packs are cacheable, provenance-stamped advisory artifacts.
5. Mutating flows MUST NOT depend on live network calls.
6. Providers are pluggable (for example Context7, official docs bundles, manual import), but provider choice does not change authority.
7. If version-specific guidance is required and no applicable pack is loaded, apply risk behavior below.
8. Knowledge Packs MUST NOT override universal mandates, slash command rules, repo evidence, session state, schemas, or fail-closed behavior.

## Authority and Precedence

FlowGuard applies this precedence ladder in descending authority:

1. Universal FlowGuard Mandates
2. Slash Command Rules
3. Repo Evidence / Session State SSOT / Schemas
4. Loaded Knowledge Packs
5. Generic model memory

Implication: when an applicable Knowledge Pack exists, version-specific claims SHOULD prefer that pack over generic model memory. If pack content conflicts with repo evidence, session state, or schemas, the higher layer wins.

## Risk Behavior Without Applicable Pack

If version-specific guidance is required but no applicable Knowledge Pack is loaded:

- Low-risk work: proceed only with stable profile rules and mark version-specific claims as `NOT_VERIFIED`.
- Standard or high-risk work: return `BLOCKED` with recovery steps.

This behavior extends existing ambiguity/risk policy and preserves fail-closed operation.

## Knowledge Pack Contract (Planned, Not Implemented in P20)

The following shape is the planned contract target for future implementation:

```json
{
  "id": "spring-boot-4-migration",
  "provider": "context7",
  "status": "advisory",
  "subject": {
    "kind": "framework",
    "name": "spring-boot",
    "version": "4.0.1",
    "scope": "services/api"
  },
  "generatedAt": "2026-04-21T00:00:00Z",
  "expiresAt": "2026-05-21T00:00:00Z",
  "sources": [
    {
      "title": "Spring Boot Reference Documentation",
      "url": "https://example.invalid/spring-boot-docs",
      "retrievedAt": "2026-04-21T00:00:00Z"
    }
  ],
  "guidance": [],
  "constraints": [],
  "provenanceHash": "sha256:..."
}
```

Notes:

- `status` is advisory by contract.
- provenance metadata is mandatory for trust and auditability.
- schema/runtime integration is explicitly deferred.

## Non-Goals (P20)

P20 does not implement:

- provider interfaces
- Context7 integration
- network fetches
- cache storage
- runtime schemas
- CLI refresh commands
- command/template behavior changes

## Consequences

Positive:

- Preserves deterministic, fail-closed authority boundaries.
- Enables future version-specific guidance without SSOT drift.
- Keeps mutating command flows robust in offline/air-gapped setups.

Trade-offs:

- Version-specific guidance remains blocked or not-verified until packs are loaded.
- Additional implementation work is required for provider, storage, and command integration.

## Follow-up Roadmap

- P21: Knowledge Pack type/store skeleton (no provider)
- P22: Manual/offline Knowledge Pack import
- P23: Context7 provider spike
- P24: Command integration for loaded packs in `/plan` and `/review`
