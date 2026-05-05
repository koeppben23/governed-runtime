# Schema Migration Architecture

**Status:** Design Proposal  
**Version:** v1  
**Author:** FlowGuard Core Team  
**Governance:** Long-term schema evolution contract for audit archive integrity.

## 1. Problem Statement

FlowGuard is a compliance audit tool. Sessions produce persistent state artifacts
(`session-state.json`, `flowguard.json`, `policy-snapshot.json`, audit trails) that must
remain valid across schema evolution for the retention window (≥7 years in regulated
mode).

Currently, **every schema is hard-locked to `v1`** via `z.literal('v1')` in Zod schemas.
There is no migration infrastructure:

- No version registry
- No migration transform pipeline
- No backward-compatibility dispatch on `schemaVersion`
- Break-glass tests explicitly reject `v2` (`state.test.ts:241`)

The first breaking schema change will corrupt existing sessions, audit archives,
and workspace state unless a migration path is designed and implemented before that
change lands.

## 2. Current State

### 2.1 Schema Version Points (10 unique version constants)

| Schema                              | File                                          | Lock Mechanism                                                |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `SessionState.schemaVersion`        | `state/schema.ts:164`                         | `z.literal('v1')`                                             |
| `FlowGuardConfig.schemaVersion`     | `config/flowguard-config.ts:26`               | `z.literal('v1')`                                             |
| `PolicySnapshot` (embedded)         | `state/evidence.ts:449`                       | Inherited from SessionState                                   |
| `CentralPolicyBundle.schemaVersion` | `config/policy.ts:187`                        | `readonly schemaVersion: 'v1'`                                |
| `ActorClaim.schemaVersion`          | `adapters/actor.ts:46`                        | `z.literal('v1')`                                             |
| `DiscoveryResult`                   | `discovery/types.ts:22`                       | `DISCOVERY_SCHEMA_VERSION = 'discovery.v1'`                   |
| `ProfileResolution`                 | `discovery/types.ts:23`                       | `PROFILE_RESOLUTION_SCHEMA_VERSION = 'profile-resolution.v1'` |
| `ArchiveManifest`                   | `archive/types.ts:23`                         | `ARCHIVE_MANIFEST_SCHEMA_VERSION = 'archive-manifest.v1'`     |
| `WorkspacePointer`                  | `adapters/workspace/types.ts:26`              | `WORKSPACE_SCHEMA_VERSION = 'v1'`                             |
| `ReviewReport`                      | `state/evidence.ts:628`                       | `flowguard-review-report.v1`                                  |
| `EvidenceArtifact`                  | `adapters/workspace/evidence-artifacts.ts:17` | `flowguard-evidence-artifact.v1`                              |
| `MADR Artifact`                     | `integration/artifacts/madr-writer.ts:22`     | `madr-artifact.v1`                                            |

### 2.2 Existing Backward-Compat Mechanisms

**Only one exists** — field-level coercive transform for actor assurance:

```typescript
// state/evidence.ts:17-24
function coerceAssurance(
  raw: unknown,
): 'best_effort' | 'claim_validated' | 'idp_verified' {
  if (
    raw === 'verified' ||
    raw === 'claim_validated' ||
    raw === 'idp_verified'
  ) {
    if (raw === 'verified') return 'claim_validated'; // legacy actor claim compatibility
    return raw as 'claim_validated' | 'idp_verified';
  }
  return 'best_effort';
}
```

This is a **field-level transform**, not a schema-version migration. It works only
because the change was additive (new assurance tier added, old one renamed).

### 2.3 What Happens on First Breaking Change

A breaking change could be:

- Removing a required field from SessionState
- Renaming a Zod shape key
- Changing a field type (e.g., `string` → `number`)
- Adding a required field without a default

With the current `z.literal('v1')` lock, any existing session with `schemaVersion: 'v1'`
is parsed against the **current** schema. If the current schema has changed, all existing
sessions fail validation — data loss for all open sessions, broken audit trails,
orphaned workspace state.

## 3. Proposed Strategy

### 3.1 Version Registry (SSOT)

A single module declares all known schema versions and their endpoints:

```typescript
// src/state/migration.ts

export const SESSION_SCHEMA_VERSIONS = ['v1', 'v2'] as const;
export type SessionSchemaVersion = (typeof SESSION_SCHEMA_VERSIONS)[number];

export const CURRENT_SESSION_SCHEMA_VERSION: SessionSchemaVersion = 'v2';
```

Each schema domain (session, config, policy, discovery, archive) gets its own
version registry. Version constants replace the current `z.literal('v1')` in schemas.

### 3.2 Migration Pipeline

Each schema version transition is a pure function:

```typescript
type Migration<Src, Tgt> = (input: Src) => Tgt;

// Example: v1 → v2 SessionState migration
function migrateSessionV1ToV2(v1: SessionStateV1): SessionStateV2 {
  // Transform: add new required field with default, rename key, etc.
  return { ...v1, newField: default_value /* ... */ };
}
```

A registry maps each source version to the next version's migration:

```typescript
const SESSION_MIGRATIONS: Record<string, Migration<unknown, unknown>> = {
  v1: migrateSessionV1ToV2,
  // 'v2': migrateSessionV2ToV3,  // future
};
```

### 3.3 Read-Time Migration (Hydrate)

The hydrate path reads session state from disk. If the persisted `schemaVersion`
does not match `CURRENT_SESSION_SCHEMA_VERSION`, migrations are chained until
the current version is reached:

```typescript
function migrateToCurrent(raw: Record<string, unknown>): SessionStateV2 {
  let current = raw;
  let version = raw.schemaVersion as string;

  while (version !== CURRENT_SESSION_SCHEMA_VERSION) {
    const migrate = SESSION_MIGRATIONS[version];
    if (!migrate) {
      throw new PersistenceError(
        'SESSION_MIGRATION_MISSING',
        `No migration from schemaVersion=${version} to any subsequent version`,
      );
    }
    current = migrate(current);
    version = current.schemaVersion as string;
  }

  return SessionStateV2.parse(current);
}
```

**Migration is idempotent:** running migrateToCurrent on already-current data is a no-op.

### 3.4 Write-Time Migration (Audit Events)

Audit events (`audit-trail.jsonl`) are append-only and immutable. When a breaking
schema change occurs:

1. **Closed sessions** — audit trail is read for verification but not migrated.
   Audit verification must accept all known historical schema versions. The
   verification path uses a version-aware reader that dispatches on `schemaVersion`.

2. **Open sessions** — state is migrated at the next hydrate. The session pointer
   is updated to reflect the new schema version.

3. **New sessions** — always created at `CURRENT_SESSION_SCHEMA_VERSION`.

### 3.5 Audit Compatibility Contract

The audit trail is the **longest-lived artifact** (≥7 years regulatory retention).
Schema migration must not break audit verification for historical data.

**Contract:**

1. Each audit event carries a `schemaVersion` field.
2. The audit verification module maintains readers for **all known historical
   schema versions**. Historical readers are never removed.
3. A new schema version adds a new reader; existing readers remain untouched.
4. The verification path dispatches on `schemaVersion`:
   ```
   if (version === 'v1') return verifyV1(event);
   if (version === 'v2') return verifyV2(event);
   ```
5. Deprecated schema versions emit a **compatibility warning** but are still
   verifiable.

### 3.6 Schema Evolution Rules

When adding a new schema version:

1. **Additive fields only** — new fields MUST have defaults. Required fields
   without defaults are forbidden in additive changes.
2. **Field removal** — requires a migration that maps the old field to null/absent
   or transforms it to a new field.
3. **Type changes** — requires a migration that transforms the old type to the new.
4. **Renames** — treated as field removal + new field addition. The migration
   copies the old value to the new field name.
5. **Migration MUST be tested** — every migration function must have:
   - Happy path: vN input → vN+1 output with expected values
   - Bad path: missing fields in vN input handled gracefully
   - Round-trip: vN → vN+1 audit verification still works

## 4. Implementation Plan

### Phase 1: Infrastructure (before first breaking change)

| Step | Deliverable                                                                      | Complexity |
| ---- | -------------------------------------------------------------------------------- | ---------- |
| 1.1  | Create `src/state/migration.ts` with version registry + pipeline                 | Medium     |
| 1.2  | Replace `z.literal('v1')` in SessionState with `z.enum(SESSION_SCHEMA_VERSIONS)` | Low        |
| 1.3  | Add `migrateToCurrent()` to hydrate read path                                    | Medium     |
| 1.4  | Add `schemaVersion` to audit events                                              | Low        |
| 1.5  | Add migration tests (happy/bad/round-trip)                                       | Medium     |
| 1.6  | Update break-glass tests to accept multi-version                                 | Low        |

### Phase 2: First Migration (when v2 is defined)

| Step | Deliverable                                                | Complexity |
| ---- | ---------------------------------------------------------- | ---------- |
| 2.1  | Define SessionState v2 schema                              | Design     |
| 2.2  | Implement `migrateSessionV1ToV2()`                         | Medium     |
| 2.3  | Add audit verification reader for v1 events                | Medium     |
| 2.4  | Integration test: v1 session hydrated → v2 state valid     | High       |
| 2.5  | Integration test: v1 audit trail verifiable with v2 schema | High       |

### Phase 3: Config & Policy Migration (deferred)

Config and policy schemas have their own versions. These migrate independently
from session state. The same pipeline pattern applies.

### Phase 4: Discovery & Archive Schema Migration (deferred)

Discovery results and archive manifests have domain-scoped versions
(`discovery.v1`, `archive-manifest.v1`). These are treated as content-addressed
artifacts — migration is optional but must preserve content integrity.

## 5. Rollout Strategy

### Safe Default: No Migration

Until the pipeline is implemented, `z.literal('v1')` remains the lock. Any attempt
to parse data with a different schema version is rejected — fail-closed. This is
the **correct default behavior** for a compliance tool.

### Migration is Opt-In by Version Existence

The migration pipeline is activated **only when a source version has an entry in
the migration registry**. If no migration exists for version X, parsing encounters
`SESSION_MIGRATION_MISSING` — fail-closed.

### Backward-Incompatible Schema Changes Are Prohibited Without Migration

A PR that changes the SessionState Zod schema MUST also:

1. Increment `CURRENT_SESSION_SCHEMA_VERSION`
2. Add a migration from the previous version
3. Add migration tests

This is enforced by a code review policy, not by tooling — the migration registry
is a SSOT, and PR review verifies it.

## 6. Risk Assessment

### 6.1 If We Don't Implement Migration Before v2

| Impact                                  | Severity     | Mitigation                                                                   |
| --------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| All existing sessions fail validation   | **Critical** | Don't ship v2 without migration                                              |
| Audit trails become unverifiable        | **Critical** | Don't ship v2 without version-aware audit readers                            |
| Workspace state is orphaned             | **High**     | Don't ship v2 without hydrate migration                                      |
| Config defaults break for open sessions | **Medium**   | Config migration can be deferred (config changes apply to new sessions only) |

### 6.2 Migration Complexity Risks

| Risk                                                | Likelihood | Mitigation                                                                  |
| --------------------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| Migration introduces data corruption                | Medium     | Pure functions, exhaustive tests, round-trip verification                   |
| Migration performance degrades hydrate              | Low        | Migration is O(1) per field; only runs once per session                     |
| Migration registry becomes out of sync with schemas | Medium     | SSOT module, PR review policy, integration test covering all known versions |

### 6.3 Regulatory Risk

For regulated-mode sessions, audit trail immutability is a compliance requirement.
Schema migration MUST NOT rewrite historical audit events. The version-aware audit
reader pattern ensures this — old events are read with old schemas, new events
with new schemas.

## 7. References

- `src/state/schema.ts` — SessionState Zod schema
- `src/config/flowguard-config.ts` — FlowGuardConfig Zod schema
- `src/state/evidence.ts` — PolicySnapshot schema + coerceAssurance example
- `src/audit/integrity.ts` — Audit chain integrity (legacy tolerance comment)
- `docs/configuration.md:246-252` — Config immutability note
- `docs/actor-assurance-architecture.md:288-312` — actor assurance field migration example

## 8. Decision Log

| Decision                                                       | Date       | Rationale                                                                               |
| -------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| Migration is read-time, not write-time                         | 2026-04-27 | Avoids rewriting historical audit trails. State is migrated on next hydrate.            |
| Version registry is per domain                                 | 2026-04-27 | Session, config, policy, discovery evolve independently. No single global version.      |
| Magnetic pipelines are `Record<string, Migration>`             | 2026-04-27 | Simpler than a class-based transformer pattern. Pure functions, easy to test.           |
| Audit readers are never removed                                | 2026-04-27 | Regulatory requirement — historical audit data must remain verifiable for ≥7 years.     |
| `z.literal('v1')` is NOT changed to `z.enum([...])` in Phase 1 | 2026-04-27 | Phase 1 only builds infrastructure. The literal stays until Phase 2 when v2 is defined. |
