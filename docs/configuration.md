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
  "discovery": {
    "enabled": true,
    "collectors": ["repo-metadata", "stack-detection"]
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
**Values:** `solo`, `team`, `regulated`
**Default:** `solo`

Sets the default policy mode for new sessions.

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

### discovery.enabled

**Type:** `boolean`
**Default:** `true`

Enable or disable repository discovery.

### discovery.collectors

**Type:** `array`
**Values:** `repo-metadata`, `stack-detection`, `topology`, `surface-detection`, `domain-signals`
**Default:** All collectors

Select which discovery collectors to run.

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
  "discovery": {
    "enabled": true,
    "collectors": ["repo-metadata", "stack-detection"]
  },
  "profile": {
    "default": "typescript"
  }
}
```
