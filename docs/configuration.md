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

**Central minimum policy (optional):**

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

Overrides the maximum independent review iterations in PLAN phase. The field name is retained as the persisted policy contract:

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

### policy.identityProvider

**Type:** discriminated object (`mode: "static" | "jwks"`)
**Default:** unset

Configures IdP-based actor verification for `idp_verified` assurance.

Token-expiry note: `exp` is currently recommended but not strictly required for accepted IdP tokens. When absent, FlowGuard computes a bounded default `expiresAt` in token metadata for compatibility. Organizations with stricter security posture should enforce `exp` issuance in their IdP policy.

Runtime token input for both modes is provided via `FLOWGUARD_ACTOR_TOKEN_PATH` (JWT file path).
If `policy.identityProvider` is set and `identityProviderMode` is `required`, missing or invalid
token input blocks mutating decision paths (`/review-decision approve`) fail-closed.
Hydrate remains diagnostic/best-effort and does not block on IdP failures.
Schema validation rejects empty or structurally invalid identity provider configurations
(including missing mode, issuer, or signing keys).

`mode: "static"` (local key bundle):

```json
{
  "policy": {
    "identityProvider": {
      "mode": "static",
      "issuer": "https://issuer.example.com",
      "audience": ["flowguard"],
      "claimMapping": {
        "subjectClaim": "sub",
        "emailClaim": "email",
        "nameClaim": "name"
      },
      "signingKeys": [
        {
          "kind": "pem",
          "kid": "key-1",
          "alg": "RS256",
          "pem": "-----BEGIN PUBLIC KEY-----..."
        }
      ]
    }
  }
}
```

`mode: "jwks"` (JWKS source, exactly one authority):

```json
{
  "policy": {
    "identityProvider": {
      "mode": "jwks",
      "issuer": "https://issuer.example.com",
      "audience": ["flowguard"],
      "claimMapping": {
        "subjectClaim": "sub",
        "emailClaim": "email",
        "nameClaim": "name"
      },
      "jwksPath": "/etc/flowguard/jwks.json"
    }
  }
}
```

Or remote JWKS with cache TTL:

```json
{
  "policy": {
    "identityProvider": {
      "mode": "jwks",
      "issuer": "https://issuer.example.com",
      "audience": ["flowguard"],
      "claimMapping": {
        "subjectClaim": "sub",
        "emailClaim": "email",
        "nameClaim": "name"
      },
      "jwksUri": "https://id.example.com/.well-known/jwks.json",
      "cacheTtlSeconds": 300
    }
  }
}
```

Authority rule: no mixed mode. `static` accepts `signingKeys` only; `jwks` accepts exactly one of `jwksPath` or `jwksUri`.

`jwksUri` policy: HTTPS only, cached for `cacheTtlSeconds` (default 300s), fail-closed on fetch/parse/validation errors when refresh is required. This implementation intentionally has no stale-on-error and no last-known-good fallback after TTL expiry.

### policy.identityProviderMode

**Type:** `enum`
**Values:** `optional`, `required`
**Default:** `optional`

Controls whether IdP verification failure blocks session creation:

- `optional`: IdP verification errors degrade to next identity source (claim/env/git/unknown)
- `required`: IdP verification must succeed (fail-closed on missing/invalid token or key mismatch)

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

| Context          | Priority Chain                                        | Final Fallback |
| ---------------- | ----------------------------------------------------- | -------------- |
| `/hydrate` tool  | explicit > central > config.defaultMode > `solo`      | `solo`         |
| Plugin / runtime | state snapshot > `config.policy.defaultMode` > `solo` | `solo`         |
| Install CLI      | `--policy-mode` writes `config.policy.defaultMode`    | —              |

**Runtime policy mode unification**

All runtime surfaces (plugin, status, etc.) use the same fallback priority:

```
state.policySnapshot.mode → config.policy.defaultMode → solo
```

This unified fallback replaces the previous plugin-specific `team` fallback.

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

### Central Policy File

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

**Resolution priority chain:**

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

**Resolution priority:**

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
