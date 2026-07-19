# Configuration

FlowGuard supports per-repository configuration via `flowguard.json`.

## Config File Location

```
~/.config/opencode/flowguard.json              # Global (fallback)
{worktree}/.opencode/flowguard.json            # Repo-scoped (takes priority)
```

## Configuration Schema

```json
{
  "schemaVersion": "v1"
}
```

With no policy override, FlowGuard resolves the built-in `team` mode (human-gated).

## Settings Reference

### schemaVersion

**Type:** `string` (literal: `"v1"`)
**Required:** Yes

### logging.level

**Type:** `enum`
**Values:** `debug`, `info`, `warn`, `error`, `silent`
**Default:** `info`

Controls verbosity of FlowGuard logging. Messages below the configured level are suppressed. `debug` emits all messages; `silent` suppresses everything.

### logging.mode

**Type:** `enum`
**Values:** `file`, `ui`, `both`, `console`, `file+console`
**Default:** `file`

Controls where FlowGuard writes structured log output.

| Mode           | Behavior                                                                |
| -------------- | ----------------------------------------------------------------------- |
| `file`         | Writes JSONL to `{workspace}/.opencode/logs/flowguard-{YYYY-MM-DD}.log` |
| `ui`           | Delegates to OpenCode SDK `client.app.log()` (renders in TUI)           |
| `both`         | File + UI sinks                                                         |
| `console`      | Writes formatted lines to stderr (warn/error) / stdout (info/debug)     |
| `file+console` | File + console sinks                                                    |

**CLI `--log-mode` flag**: The CLI uses a separate flag (`--log-mode console|file|file+console`) because it has no OpenCode plugin context and cannot use `ui` or `both`. The CLI defaults to `console` if `--log-mode` is omitted.

### logging.retentionDays

**Type:** `number` (1-90)
**Default:** `7`

Number of days to retain log files. Logs older than this are automatically deleted when the first log entry of the day is written. See [Troubleshooting](./troubleshooting.md) for log location details.

### Adapter-layer logging

All adapter modules (persistence, git, archive, init, evidence-artifacts, gh-cli, actor, identity) emit structured logs for failure paths via `AsyncLocalStorage`-scoped dependency injection. Example events:

- `Atomic write failed` (persistence)
- `git executable not found` / `Failed to resolve current branch` (git)
- `Discovery snapshot missing during archive creation` (archive)
- `JWT verification failed` (identity, redacted)
- `Legacy selfReview config normalized to mandatory strict` (policy)

Adapter logs route to whichever log mode is configured — file, console, or both.

### Identity log redaction

Identity, JWT, and JWKS error logs automatically sanitize sensitive data:

- File paths → basename only (e.g. `[redacted:token.jwt]`)
- URIs → hostname only (e.g. `[redacted:auth.example.com]`)
- Issuers → SHA-256 prefix (e.g. `[hashed:a1b2c3d4]`)
- Error messages → URLs and absolute paths stripped

This prevents accidental exposure of tokens, claim data, or provider endpoints in log files.

### policy.defaultMode

**Type:** `enum`
**Values:** `solo`, `team`, `team-ci`, `regulated`
**Default:** `team`

Sets the default policy mode for new sessions when `/hydrate` is called without an explicit `policyMode` argument.

**Resolution priority chain:**

1. Explicit `/hydrate` tool argument (`policyMode`)
2. `flowguard.json` → `policy.defaultMode`
3. Built-in default: `team` (fail-closed / human-gated)

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

**Type:** `number` (1-10)
**Default:** Preset value (solo=2, team/team-ci/regulated=3)

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
2. Policy preset value (solo=2, team=3, team-ci=3, regulated=3)

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

### policy.minimumActorAssuranceForApproval

**Type:** `enum`
**Values:** `best_effort`, `claim_validated`, `idp_verified`
**Default:** `best_effort` for solo / team / team-ci; **`claim_validated`** for regulated

Minimum required actor assurance for `approve` verdicts at user gates. The
approver's resolved assurance tier must be `>=` this value, otherwise
`/review-decision approve` is rejected with `ACTOR_ASSURANCE_INSUFFICIENT`.

### policy.requireVerifiedActorsForApproval

**Type:** `boolean`
**Default:** `false`

Legacy precedence flag. When `true`, the approver is required to be at
assurance `claim_validated` or higher (the same effect as
`minimumActorAssuranceForApproval: 'claim_validated'`).

> **Precedence:** `requireVerifiedActorsForApproval` is evaluated **first**.
> When it is `true`, the runtime ignores `minimumActorAssuranceForApproval`
> for the decision rail and uses the legacy gate. Operators relaxing the
> stricter legacy gate by setting `minimumActorAssuranceForApproval` to a
> lower tier MUST also set `requireVerifiedActorsForApproval: false` —
> otherwise the legacy gate keeps winning. See
> `src/rails/review-decision.ts` (`verifyAssuranceThreshold`) and
> `docs/actor-assurance-architecture.md`.

### policy.maxImplReviewIterations

**Type:** `number` (1-10)
**Default:** Preset value (solo=1, team/team-ci/regulated=3)

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
2. Policy preset value (solo=1, team=3, team-ci=3, regulated=3)

Applies only to new sessions. Existing sessions retain their snapshot value.

### policy.allowReducedCeremony

**Type:** `boolean`
**Default:** `false`

Permits reduced implementation-review ceremony only after FlowGuard has runtime evidence that the changed files are low risk. This setting is fail-closed and does not let `claimedTaskClass` choose pipeline depth.

Reduced ceremony can apply only when all of these are true:

- `policy.allowReducedCeremony` is `true` in the frozen policy snapshot.
- `claimedTaskClass` is present and exactly `TRIVIAL`.
- Runtime-computed minimum task class is `TRIVIAL`.
- `riskGate` is clear or absent.
- Changed-file evidence is available and touches no governance, security, policy, state, audit, archive, release, installer, CI, persistence, migration, or trust-boundary surface.
- Validation evidence for all active checks is complete and passing.
- Implementation evidence, `state.reducedCeremony`, and transition audit are recorded.
- `reviewInvocationPolicy` does not require host-task review.
- No outstanding review obligation exists.

If any condition fails, FlowGuard keeps the full existing ceremony. Sensitive surfaces escalate to the computed minimum, often `HIGH-RISK`; they do not downgrade to `STANDARD` by default. Reduced ceremony never writes synthetic `implReview` approval evidence.

### policy.maxIncoherentReviewerCaptureRetries

**Type:** integer `0` through `5`
**Default:** `1`

Caps fresh `flowguard-reviewer` Task calls after a host-task capture is internally
incoherent: `overallVerdict: "accept"` with a non-empty `blockingIssues` array (F12).
The initial incoherent capture is retained as audit evidence; a default budget of `1`
allows one fresh reviewer call for the same pending obligation. A second incoherent
capture exhausts the budget and requires the governed artifact to be re-submitted for
a new review obligation.

This is intentionally **not** a general parser-recovery budget. Missing, malformed, or
schema-invalid reviewer output follows its own fail-closed recovery path and does not
consume this F12-specific budget.

### Runtime Policy Resolution

Different runtime contexts resolve policy defaults independently:

| Context          | Priority Chain                                        | Final Fallback |
| ---------------- | ----------------------------------------------------- | -------------- |
| `/hydrate` tool  | explicit > central > config.defaultMode > `team`      | `team`         |
| Plugin / runtime | state snapshot > `config.policy.defaultMode` > `team` | `team`         |
| Install CLI      | `--policy-mode` writes `config.policy.defaultMode`    | —              |

**Runtime policy mode unification**

All runtime surfaces (plugin, status, etc.) use the same fallback priority:

```
state.policySnapshot.mode → config.policy.defaultMode → team
```

The built-in fallback is `team` (human-gated) so that an unconfigured session
fails closed rather than silently auto-approving.

### Existing Sessions and Snapshot Authority

Config values are resolved once at session creation (first `/hydrate`). The resolved values become part of the immutable session snapshot:

- `policySnapshot.maxSelfReviewIterations`
- `policySnapshot.maxImplReviewIterations`
- `policySnapshot.maxIncoherentReviewerCaptureRetries`
- `policySnapshot.allowReducedCeremony`
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
**Default:** `none`

Archive Layout v2 requires `none` and exports a complete raw-evidence package.

`basic` and `strict` are legacy settings. Archive creation fails until they are migrated to `none`. Redacted sharing export is a future, separate feature.

### archive.redaction.includeRaw

**Type:** `boolean`
**Default:** `true`

Archive Layout v2 requires `true` and includes raw evidence. Archive manifests record `rawIncluded: true` and the `raw_audit_evidence_export` risk flag.

`false` is a legacy setting and causes archive creation to fail. Migrate it to `true` before creating an archive.

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

**Fail-closed vs. collector-local degradation:**

- `/hydrate` enforces a **fail-closed artifact contract**: the session cannot enter READY unless all four required artifacts (`discovery.json`, `profile-resolution.json`, `discovery-snapshot.json`, `profile-resolution-snapshot.json`) are persisted, and both `discoveryDigest` and `discoverySummary` are computed. If any artifact cannot be written, hydration fails with an explicit error.
- Individual collectors degrade **locally**: if a collector times out or throws, its status is recorded as `'failed'` in the `diagnostics` array with structured error info (`errorCode`, `timedOut`, `degradedReason`). The overall discovery run still produces a result with safe defaults for the failed collector's section. This means discovery always completes, but the result may be partial.

**Advisory verification authority:**

Verification commands (test, lint, build, typecheck) are derived via `planVerificationCandidates` and surfaced as `verificationCandidates` in `flowguard_status`. This is the single canonical advisory verification source. The `validationHints` field in `DiscoveryResult` is a legacy intermediate signal retained for digest stability and must not be consumed for agent guidance.

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
**Default:** Empty (`[]` — derived from `verificationCandidates` at session creation)

Override the active checks for the selected profile. Each entry must match a
verification candidate `kind` from `flowguard_status.verificationCandidates`.
Valid kinds are: `build`, `test`, `lint`, `typecheck`, `format`, `security`,
`coverage`.

```json
{
  "profile": {
    "activeChecks": ["test", "lint", "typecheck"]
  }
}
```

**Resolution priority:**

1. Explicit non-empty `config.profile.activeChecks` (highest priority)
2. Derived from `verificationCandidates` (each unique candidate `kind` becomes
   an active check)
3. Empty (no checks — VALIDATION phase is vacuously passed)

When an explicit override lists a kind not present in
`verificationCandidates`, `flowguard_run_check` will reject it with
`CHECK_KIND_NOT_AVAILABLE`.

Applies only to new sessions. Existing sessions retain their snapshot value.

> **No per-profile config overrides.** Earlier drafts mentioned a
> `profile.overrides.<id>.activeChecks` override map. That field is **not**
> declared in `FlowGuardConfigSchema` (`src/config/flowguard-config.ts`) and
> is silently ignored by Zod. Customize the active set via `profile.activeChecks`
> (global override) or by registering a custom profile (see
> `docs/profiles.md#custom-profiles`).

## Environment Variables

| Variable                    | Description                                                                                    | Default              |
| --------------------------- | ---------------------------------------------------------------------------------------------- | -------------------- |
| `OPENCODE_CONFIG_DIR`       | Config root                                                                                    | `~/.config/opencode` |
| `FLOWGUARD_POLICY_PATH`     | Optional central policy file path (`schemaVersion: "v1"`, `minimumMode`)                       | unset                |
| `FLOWGUARD_REVIEWER_MODEL`  | Operative reviewer model id pinned into the reviewer agent frontmatter at install time         | unset (host default) |
| `FLOWGUARD_REVIEWER_EFFORT` | Operative reviewer reasoning-effort pinned into the reviewer agent frontmatter at install time | unset (host default) |

Log level is sourced exclusively from `config.logging.level` (see the
**logging** section above). There is no `FLOWGUARD_LOG_LEVEL` env override at
runtime; setting it has no effect.

### Reviewer Transport Tuning (operative layer)

`FLOWGUARD_REVIEWER_MODEL` and `FLOWGUARD_REVIEWER_EFFORT` adapt only the
**operative reviewer transport** (which model runs the review and how hard it
reasons). They are applied as frontmatter directives when the reviewer agent is
written during `flowguard install`. They do **not** change any governance
mandate, prompt body, or risk logic — the mandate body is byte-identical
regardless of these values (governance stays model-invariant).

Values are validated fail-closed at install time:

- `FLOWGUARD_REVIEWER_MODEL` — alphanumerics, dots, slashes, `@`, colons, and
  hyphens only; newlines rejected (YAML-injection guard).
- `FLOWGUARD_REVIEWER_EFFORT` — lowercase letters only (e.g. `low`, `medium`,
  `high`, `xhigh`, `max`). Any other value aborts the install.

Per-host support matrix (the injected frontmatter key differs by host):

| Host          | `model:` injection | Effort frontmatter key | Notes                                               |
| ------------- | ------------------ | ---------------------- | --------------------------------------------------- |
| `opencode`    | yes                | `reasoningEffort:`     | Provider passthrough.                               |
| `claude-code` | yes                | `effort:`              | Effort values: `low`/`medium`/`high`/`xhigh`/`max`. |
| `codex`       | no                 | unsupported            | See limitation below.                               |

**Codex limitation:** FlowGuard ships the Codex reviewer as a markdown subagent,
which does not honor `model`/`model_reasoning_effort` directives. Codex configures
those natively via TOML custom agents under `.codex/agents/`. To avoid silently
dropping operator intent, setting either env var while installing for Codex
**fails closed** with an explicit error. Unset the variables for the Codex
install, or configure the Codex custom agent directly.

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
      "mode": "none",
      "includeRaw": true
    }
  }
}
```
