# Configuration

FlowGuard supports per-repository configuration via `config.json`.

## Config File Location

```
~/.config/opencode/workspaces/{fingerprint}/config.json
```

## Configuration Schema

```json
{
  "schemaVersion": "v1",
  "logging": {
    "level": "info"
  },
  "policy": {
    "defaultMode": "solo"
  },
  "profile": {},
  "archive": {
    "redaction": {
      "mode": "basic",
      "includeRaw": false
    }
  }
}
```

## Settings Reference

### schemaVersion

**Type:** `string` (literal: `"v1"`)
**Required:** Yes

### logging.level

**Type:** `enum`
**Values:** `debug`, `info`, `warn`, `error`, `silent`
**Default:** `info`

Controls verbosity of FlowGuard logging.

### policy.defaultMode

**Type:** `enum`
**Values:** `solo`, `team`, `team-ci`, `regulated`
**Default:** `solo`

Sets the default policy mode for new sessions when `/hydrate` is called without an explicit `policyMode` argument.

**Resolution priority chain:**

1. Explicit `/hydrate` tool argument (`policyMode`)
2. `config.json` → `policy.defaultMode`
3. Built-in default: `solo`

**P29 central minimum (optional):**

- If `FLOWGUARD_POLICY_PATH` is set, the central policy file becomes mandatory.
- Missing/unreadable/invalid central policy blocks `/hydrate` (fail-closed).
- Central policy defines `minimumMode` (`solo`, `team`, or `regulated`).
- Repo/default weaker than central minimum is raised to the central minimum with
  explicit resolution reason.
- Explicit mode weaker than central minimum is blocked (`EXPLICIT_WEAKER_THAN_CENTRAL`).
- Explicit mode stronger than central minimum is allowed and remains source `explicit`.
- Existing sessions are also checked when `/hydrate` runs; if existing session mode is weaker
  than central minimum, hydrate blocks (`EXISTING_POLICY_WEAKER_THAN_CENTRAL`).

The installer persists `--policy-mode` into this field during `flowguard install`.
Re-install with `--force` updates the value; without `--force`, the existing config is preserved.

`team-ci` degrades to `team` when no CI context is detected (`ci_context_missing`).

Invalid or unrecognized policy mode values are rejected with an explicit `PolicyConfigurationError` (fail-stop). No productive path silently maps unknown modes to a fallback.

### policy.maxSelfReviewIterations

**Type:** `number` (1-20)
**Default:** Preset value (solo=2, team/regulated=3)

Overrides the maximum self-review iterations in PLAN phase:

```json
{
  "policy": {
    "maxSelfReviewIterations": 5
  }
}
```

**Resolution priority:**

1. Config override (`config.policy.maxSelfReviewIterations`)
2. Policy preset value (solo=2, team=3, regulated=3)

Applies only to new sessions. Existing sessions retain their snapshot value.

### policy.maxImplReviewIterations

**Type:** `number` (1-20)
**Default:** Preset value (solo=1, team/regulated=3)

Overrides the maximum impl-review iterations in IMPL_REVIEW phase:

```json
{
  "policy": {
    "maxImplReviewIterations": 7
  }
}
```

**Resolution priority:**

1. Config override (`config.policy.maxImplReviewIterations`)
2. Policy preset value (solo=1, team=3, regulated=3)

Applies only to new sessions. Existing sessions retain their snapshot value.

### Runtime Policy Resolution

Different runtime contexts resolve policy defaults independently:

| Context                 | Priority Chain                                                                                                             | Final Fallback |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `/hydrate` tool         | requested (`explicit > config.defaultMode > solo`) constrained by optional central `minimumMode` (`FLOWGUARD_POLICY_PATH`) | `solo`         |
| Plugin / session policy | state snapshot > `config.policy.defaultMode` > `team`                                                                      | `team`         |
| Install CLI             | `--policy-mode` writes `config.policy.defaultMode`                                                                         | —              |

**Why different fallbacks?**

- `/hydrate` defaults to `solo` — developer-friendly for initial workspace bootstrap.
- Plugin/session policy defaults to `team` — conservative (human gates on, full audit, hash chain enabled). A running plugin should not silently fall into the most permissive mode when config is missing.

Both paths read `config.policy.defaultMode` as the primary configured default. The difference is only in the built-in fallback when no config exists.

### Existing Sessions and Snapshot Authority

Config values are resolved once at session creation (first `/hydrate`). The resolved values become part of the immutable session snapshot:

- `policySnapshot.maxSelfReviewIterations`
- `policySnapshot.maxImplReviewIterations`
- `profileResolution.activeChecks`

Re-running `/hydrate` on an existing session reads from the snapshot, not from updated config. This ensures:

- Deterministic behavior across session lifetime
- Audit trail integrity (what rules governed the session are preserved)
- Reproducible replays

Config changes apply only to **new** sessions. To update an existing session's config-driven values, a migration path would need to be explicitly implemented.

### Central Policy File (P29)

When `FLOWGUARD_POLICY_PATH` is set, the referenced file must be valid JSON:

```json
{
  "schemaVersion": "v1",
  "minimumMode": "regulated",
  "version": "2026.04"
}
```

Required fields:

- `schemaVersion`: must be `"v1"`
- `minimumMode`: `solo`, `team`, or `regulated`

Optional fields:

- `version`: version label surfaced in applied-policy evidence
- `policyId`: optional operator-defined identifier

### policy.modes

`policy.modes` custom overrides are not a runtime authority surface in the current release.
FlowGuard policy authority is resolved from explicit mode, repo default mode, and (optionally)
`FLOWGUARD_POLICY_PATH` central minimum semantics.

### Audit Chain Verification Mode

The `verifyChain` function accepts an optional `{ strict: boolean }` parameter:

- **Default (`strict: false`):** Legacy events without chain fields are skipped and counted.
  The chain remains valid. Suitable for migration and diagnostic workflows.
- **Strict (`strict: true`):** Legacy events without chain fields are treated as integrity
  failures. Regulated verification paths must use strict mode.

Archive verification (`verifyArchive`) selects strict mode automatically when
`manifest.policyMode === 'regulated'`. Unknown or non-regulated policy modes remain
legacy-tolerant for backward compatibility.

### archive.redaction.mode

**Type:** `enum`
**Values:** `none`, `basic`, `strict`
**Default:** `basic`

Controls export-time redaction for archive artifacts.

FlowGuard preserves raw runtime and audit state internally; redaction is applied only to export artifacts according to the configured archive policy.

### archive.redaction.includeRaw

**Type:** `boolean`
**Default:** `false`

When `false` (default), only redacted export artifacts are included in archives.
When `true`, raw artifacts are included alongside redacted artifacts and the archive manifest is marked with a risk flag.

**Scope of redaction:** Only `decision-receipts.*.json` and `review-report.*.json` are redacted. `session-state.json` and `audit.jsonl` are always included as raw.

### Discovery

Discovery runs automatically on `/hydrate` and requires no user configuration. It collects repository signals through six built-in collectors:

| Collector               | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `repo-metadata`         | Git metadata (branch, commits, authors)                     |
| `stack-detection`       | Detected tech stack from files                              |
| `topology`              | Directory/file layout analysis                              |
| `surface-detection`     | Language/framework surface signals                          |
| `code-surface-analysis` | Endpoint, auth, data, integration hints (bounded heuristic) |
| `domain-signals`        | Domain-specific indicators                                  |

Results are included in `discovery-snapshot.json` archives and used for profile resolution. Code surface signals are intentionally bounded and may be partial.

### profile.defaultId

**Type:** `string`
**Default:** Auto-detected

Override automatic profile detection:

```json
{
  "profile": {
    "defaultId": "typescript"
  }
}
```

**Resolution priority chain (P31):**

1. Explicit `/hydrate` tool argument (`profileId`)
2. `config.profile.defaultId`
3. Profile detection from discovery signals
4. Built-in fallback: `baseline`

**Error handling:**

- If `config.profile.defaultId` references an unknown profile, `/hydrate` fails with
  `INVALID_PROFILE` (category: config).

### profile.activeChecks

**Type:** `string[]`
**Default:** Profile's default active checks

Override the active checks for the selected profile:

```json
{
  "profile": {
    "activeChecks": ["test_quality", "custom_check"]
  }
}
```

**Resolution priority (P31):**

1. `config.profile.activeChecks` (array)
2. Selected profile's `activeChecks`
3. Built-in defaults: `['test_quality', 'rollback_safety']`

Note: `activeChecks` accepts arbitrary string values. Custom check names are allowed for profile-specific validation. Invalid check names will fail at runtime when the check runs.

Applies only to new sessions. Existing sessions retain their snapshot value.

### profile.overrides

**Type:** `object` (map of profile ID → override config)
Custom profile configurations:

```json
{
  "profile": {
    "overrides": {
      "typescript": {
        "activeChecks": ["test_quality", "my_custom_check"]
      }
    }
  }
}
```

## Environment Variables

| Variable                | Description                                                              | Default              |
| ----------------------- | ------------------------------------------------------------------------ | -------------------- |
| `OPENCODE_CONFIG_DIR`   | Config root                                                              | `~/.config/opencode` |
| `FLOWGUARD_LOG_LEVEL`   | Log level                                                                | `info`               |
| `FLOWGUARD_POLICY_PATH` | Optional central policy file path (`schemaVersion: "v1"`, `minimumMode`) | unset                |

## Examples

### Minimal Config

```json
{
  "schemaVersion": "v1"
}
```

### Full Config

```json
{
  "schemaVersion": "v1",
  "logging": {
    "level": "debug"
  },
  "policy": {
    "defaultMode": "regulated"
  },
  "profile": {
    "defaultId": "typescript"
  },
  "archive": {
    "redaction": {
      "mode": "strict",
      "includeRaw": false
    }
  }
}
```
