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

### profile.default

**Type:** `string`
**Default:** Auto-detected

Override automatic profile detection:

```json
{
  "profile": {
    "default": "typescript"
  }
}
```

### profile.overrides

**Type:** `object`
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

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_CONFIG_DIR` | Config root | `~/.config/opencode` |
| `FLOWGUARD_LOG_LEVEL` | Log level | `info` |

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
  "archive": {
    "redaction": {
      "mode": "strict",
      "includeRaw": false
    }
  },
  "profile": {
    "default": "typescript"
  }
}
```
