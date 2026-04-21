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

The installer persists `--policy-mode` into this field during `flowguard install`.
Re-install with `--force` updates the value; without `--force`, the existing config is preserved.

`team-ci` degrades to `team` when no CI context is detected (`ci_context_missing`).

Invalid or unrecognized policy mode values are rejected with an explicit `PolicyConfigurationError` (fail-stop). No productive path silently maps unknown modes to a fallback.

### Runtime Policy Resolution

Different runtime contexts resolve policy defaults independently:

| Context                 | Priority Chain                                        | Final Fallback |
| ----------------------- | ----------------------------------------------------- | -------------- |
| `/hydrate` tool         | explicit arg > `config.policy.defaultMode` > `solo`   | `solo`         |
| Plugin / session policy | state snapshot > `config.policy.defaultMode` > `team` | `team`         |
| Install CLI             | `--policy-mode` writes `config.policy.defaultMode`    | —              |

**Why different fallbacks?**

- `/hydrate` defaults to `solo` — developer-friendly for initial workspace bootstrap.
- Plugin/session policy defaults to `team` — conservative (human gates on, full audit, hash chain enabled). A running plugin should not silently fall into the most permissive mode when config is missing.

Both paths read `config.policy.defaultMode` as the primary configured default. The difference is only in the built-in fallback when no config exists.

### policy.modes

**Type:** `object`
**Default:** Built-in policies

Override or extend policy configurations:

```json
{
  "policy": {
    "modes": {
      "regulated": {
        "requireHumanGates": true,
        "allowSelfApproval": false,
        "maxSelfReviewIterations": 5,
        "maxImplReviewIterations": 3
      }
    }
  }
}
```

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

| Variable              | Description | Default              |
| --------------------- | ----------- | -------------------- |
| `OPENCODE_CONFIG_DIR` | Config root | `~/.config/opencode` |
| `FLOWGUARD_LOG_LEVEL` | Log level   | `info`               |

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
    "defaultMode": "regulated",
    "modes": {
      "regulated": {
        "requireHumanGates": true,
        "maxSelfReviewIterations": 5,
        "maxImplReviewIterations": 3
      }
    }
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
