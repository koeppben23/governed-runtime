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
  "identity": {
    "allowedIssuers": [],
    "assertionMaxAgeSeconds": 300,
    "requireSessionBinding": true,
    "allowLocalFallbackModes": ["solo", "team"]
  },
  "rbac": {
    "roleBindings": []
  },
  "risk": {
    "rules": [],
    "noMatchDecision": "deny"
  },
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

Sets the default policy mode for new sessions.

`team-ci` degrades to `team` when no CI context is detected (`ci_context_missing`).

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

### identity.allowedIssuers

**Type:** `string[]`
**Default:** `[]`

Allowlist of trusted OIDC issuers for host identity assertions at `/hydrate`.

If empty, issuer trust is not restricted by allowlist (issuer claim is still required for `oidc` assertions).

### identity.assertionMaxAgeSeconds

**Type:** `integer`
**Range:** `1..3600`
**Default:** `300`

Maximum age for host assertions. Older assertions fail closed with `IDENTITY_UNVERIFIED`.

### identity.requireSessionBinding

**Type:** `boolean`
**Default:** `true`

When enabled, `sessionBindingId` in identity assertions must match the active OpenCode session ID.

### identity.allowLocalFallbackModes

**Type:** `enum[]`
**Values:** `solo`, `team`, `team-ci`, `regulated`
**Default:** `solo`, `team`

Policy modes where local fallback identity is allowed when no trusted host assertion is present.

Regulated mode blocks local identity by default unless explicitly included here.

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
