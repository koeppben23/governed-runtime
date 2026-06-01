# Policies

FlowGuard supports four policy modes that determine the level of enforcement.

## Policy Modes

| Mode      | Human Gates | Four-Eyes    | Self-Approval   |
| --------- | ----------- | ------------ | --------------- |
| Solo      | 0           | No           | Allowed         |
| Team      | 3           | Optional     | Allowed         |
| Team-CI   | 0 (CI only) | Optional     | Allowed         |
| Regulated | 3           | **Required** | **Not Allowed** |

## Solo Mode

Default mode for personal projects.

**Characteristics:**

- No mandatory human gates
- AI drives the entire workflow
- Self-approval allowed
- Fast iteration

**When to use:**

- Personal projects
- Prototypes
- Exploratory work

## Team Mode

For team projects with optional human oversight.

**Characteristics:**

- 3 mandatory human gates (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW)
- Four-eyes optional (can be same person)
- Self-approval allowed
- Review documentation required
- Hash chain enabled

Note: `IMPL_REVIEW` is **not** a human gate. It is an independent-review gate that
auto-advances on subagent verdict convergence (see `docs/independent-review.md`).

## Team-CI Mode

For CI/CD pipelines that should auto-advance user gates.

**Characteristics:**

- Auto-approve behavior at user gates when CI context is present
- Full audit trail and hash chain
- Same iteration limits as Team mode

**Fail-safe degradation:**

- If CI context is missing or unclear, `team-ci` degrades to `team`
- Reason code: `ci_context_missing`
- Effective behavior becomes human-gated (no silent auto-approve)

**When to use:**

- Team projects
- Shared codebases
- When review documentation is desired

## Regulated Mode

For compliance-required environments (banks, healthcare, etc.).

**Characteristics:**

- 3 mandatory human gates (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW)
- Four-eyes **required** — reviewer must differ from initiator
- Self-approval **not allowed**
- Audit trail mandatory
- Hash chain verification (strict mode in archive verification)
- Mandatory independent subagent review for `/plan`, `/architecture`, and `/implement` (fail-closed)

**When to use:**

- Regulated industries
- Compliance requirements
- Audit-ready documentation

## Setting Policy Mode

### Via Command

```bash
/hydrate policyMode=regulated
```

### Via Configuration

In `flowguard.json`:

```json
{
  "policy": {
    "defaultMode": "regulated"
  }
}
```

The selected mode determines all enforcement characteristics in the table above
(human gates, four-eyes, self-approval, audit trail, hash chain, iteration limits,
subagent review). Per-mode overrides via `policy.modes.<mode>.<field>` are **not**
a runtime authority surface in the current release — see
[`configuration.md`](./configuration.md#policymodes). The mode itself is the
configuration unit. To configure stronger actor identity assurance independent of
mode, use `policy.minimumActorAssuranceForApproval` and
`policy.identityProviderMode` (see "Configuring Stronger Assurance" below).

## Central Policy Minimum

FlowGuard supports an explicit central policy source via `FLOWGUARD_POLICY_PATH`.

- `FLOWGUARD_POLICY_PATH` **unset**: no central override applies.
- `FLOWGUARD_POLICY_PATH` **set**: central policy file is mandatory and validated.
- Invalid/missing/unreadable central policy blocks `/hydrate` fail-closed.

Resolution contract:

- Requested mode = `explicit || repo default || built-in default`
- Central minimum = `minimumMode` from central policy file
- Repo/default weaker than central minimum -> effective mode raised to central with visible reason
- Explicit weaker than central minimum -> blocked (`EXPLICIT_WEAKER_THAN_CENTRAL`)
- Explicit stronger than central minimum -> allowed, source remains `explicit`
- Existing session policy weaker than central minimum -> blocked (`EXISTING_POLICY_WEAKER_THAN_CENTRAL`)

## Policy Comparison

| Setting                   | Solo     | Team    | Team-CI             | Regulated       |
| ------------------------- | -------- | ------- | ------------------- | --------------- |
| Human gates               | 0        | 3       | 0 (CI only; else 3) | 3               |
| Four-eyes required        | No       | No      | No                  | **Yes**         |
| Self-approval             | Allowed  | Allowed | Allowed             | **Not Allowed** |
| Audit trail               | Optional | **Yes** | **Yes**             | **Mandatory**   |
| Hash chain                | No       | **Yes** | **Yes**             | **Yes**         |
| Subagent review           | **Yes**  | **Yes** | **Yes**             | **Yes**         |
| Strict review enforcement | **Yes**  | **Yes** | **Yes**             | **Yes**         |

**Human gates list (where applicable):** `PLAN_REVIEW`, `EVIDENCE_REVIEW`,
`ARCH_REVIEW`. `IMPL_REVIEW` is an independent-review gate (subagent-driven), not
a human gate.

**Subagent review:** All four modes ship with `selfReview.subagentEnabled = true`,
`selfReview.fallbackToSelf = false`, `selfReview.strictEnforcement = true` as the
runtime-normalized defaults. Self-review is never accepted as review evidence in
the current release; the orchestrator deterministically invokes the
`flowguard-reviewer` subagent for `/plan`, `/architecture`, and `/implement` and
fails closed on missing or mismatched evidence (see `docs/independent-review.md`).

## Actor Identity & Assurance

FlowGuard tracks actor identity with a three-tier assurance model. The assurance level determines how strongly the actor's identity has been verified.

### Assurance Tiers

| Tier              | Source      | How Resolved                                                                |
| ----------------- | ----------- | --------------------------------------------------------------------------- |
| `best_effort`     | `env`/`git` | `FLOWGUARD_ACTOR_ID` env var, or git config (`user.name`/`user.email`)      |
| `claim_validated` | `claim`     | `FLOWGUARD_ACTOR_CLAIMS_PATH` — signed claim file, validated at resolution  |
| `idp_verified`    | `oidc`      | `FLOWGUARD_ACTOR_TOKEN_PATH` + configured `identityProvider` — JWT verified |

Assurance is ordinal: `best_effort` (0) < `claim_validated` (1) < `idp_verified` (2).

### Default Behavior

`solo`, `team`, and `team-ci` default to `minimumActorAssuranceForApproval: best_effort`. In those modes, any resolved actor identity — even from environment variables or git config — satisfies the approval threshold.

`regulated` defaults to `minimumActorAssuranceForApproval: claim_validated`. Regulated approvals therefore require either a valid claim file via `FLOWGUARD_ACTOR_CLAIMS_PATH` or stronger `idp_verified` identity. Environment-variable or git-derived `best_effort` identities do not satisfy the default regulated approval threshold.

### Configuring Stronger Assurance

To require verified identity for approvals, set both fields in `flowguard.json`:

```json
{
  "policy": {
    "minimumActorAssuranceForApproval": "idp_verified",
    "identityProviderMode": "required"
  }
}
```

| Config Field                       | Values                                           | Effect                                                         |
| ---------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `minimumActorAssuranceForApproval` | `best_effort`, `claim_validated`, `idp_verified` | Minimum assurance tier required for `/review-decision approve` |
| `identityProviderMode`             | `optional`, `required`                           | Whether IdP verification is mandatory for actor resolution     |

### Option B: Hydrate Diagnostic, Decision Enforces

Identity policy enforcement follows **Option B** semantics:

- **`/hydrate`** resolves actor identity **best-effort** (without IdP context). Even when `identityProviderMode: required`, hydrate succeeds and creates the session. The policy snapshot records the configured identity requirements.
- **`/review-decision`** resolves actor identity **with full IdP/policy context** from the session's policy snapshot. If the actor's assurance is below the configured `minimumActorAssuranceForApproval` threshold, the decision is **BLOCKED** with `ACTOR_ASSURANCE_INSUFFICIENT`. For the regulated default, set `FLOWGUARD_ACTOR_CLAIMS_PATH` to a valid claim file or configure an identity provider for `idp_verified` approval.
- **If `identityProviderMode: required`** and `resolveActor` cannot verify the actor (no token path, invalid token), the decision is **BLOCKED** with `ACTOR_IDP_MODE_REQUIRED`.

This design separates session creation (diagnostic, always possible) from mutating decisions (enforced, fail-closed).

### Enforcement Flow

```
Config (identityProviderMode, minimumActorAssuranceForApproval)
  → PolicySnapshot (frozen at hydrate)
    → resolvePolicyFromState (reads snapshot, NOT mode defaults)
      → resolveActorForPolicy (resolves actor with IdP context)
        → review-decision rail (ordinal comparison: actor level vs required level)
          → ALLOWED or BLOCKED
```

The enforcement always reads from the persisted **policy snapshot** — not from reconstructed policy mode defaults. This guarantees that the exact policy active at session creation governs all decisions.

## Discovery Health Enforcement

FlowGuard can gate mutating tools on the health of persisted Discovery evidence.
The `policy.discoveryHealth` block is a two-axis, fail-closed control that is
frozen into the policy snapshot at hydrate time and surfaced read-only in
`flowguard_status.discoveryHealthGate`.

### Configuration

```json
{
  "policy": {
    "discoveryHealth": {
      "enforcement": "required",
      "onDegraded": "warn",
      "onDrift": "block"
    }
  }
}
```

| Field         | Values                        | Effect                                                                                   |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `enforcement` | `off`, `advisory`, `required` | Whether the gate blocks mutating tools. `off`/`advisory` never block; `required` blocks. |
| `onDegraded`  | `allow`, `warn`, `block`      | Action when Discovery is available but degraded (failed/partial collectors).             |
| `onDrift`     | `allow`, `warn`, `block`      | Action when persisted Discovery has drifted from the current workspace.                  |

### Per-mode defaults

| Mode        | `enforcement` | `onDegraded` | `onDrift` |
| ----------- | ------------- | ------------ | --------- |
| `solo`      | `off`         | `allow`      | `allow`   |
| `team`      | `off`         | `allow`      | `allow`   |
| `team-ci`   | `required`    | `warn`       | `block`   |
| `regulated` | `required`    | `warn`       | `block`   |

Legacy policy snapshots without a `discoveryHealth` block receive the same
fail-closed, mode-consistent default when loaded.

### Enforcement semantics

- When `enforcement: required`, the gate evaluates at the same seam as risk
  classification before write/edit/apply_patch and after bash mutations.
- Precedence is `unavailable` > `degraded` (under `onDegraded: block`) >
  `drift` (under `onDrift: block`). The corresponding block codes are
  `DISCOVERY_HEALTH_UNAVAILABLE`, `DISCOVERY_HEALTH_DEGRADED`, and
  `DISCOVERY_DRIFT_BLOCKED`.
- Missing or unreadable Discovery is **never** treated as healthy. Absent drift
  evidence is treated as `not_checked` and blocks under `onDrift: block`.
- The gate is **escalate-only** at the tool seam: once blocked it stays blocked
  until reconciled. `flowguard_hydrate` is the **only** authority that may clear
  the gate, by re-reading the persisted `DiscoveryResult` (the SSOT) and running
  a single bounded drift check.
- A `discovery_health:gate_changed` audit event is emitted **once** per material
  gate-status change, from a single audit authority. Both directions are
  auditable: blocking (`to_blocked`), recovery/unblocking (`to_clear`), and a
  changed block reason (`block_reason_changed`). Unchanged re-evaluations emit
  nothing, keeping the audit trail signal-dense.

### Status projections

`flowguard_status` exposes two distinct, read-only views:

- `discoveryHealthGate` — the **persisted, sticky** gate (the last block/clear
  decision written to state). Status never mutates or clears it.
- `discoveryEvidenceGate` — a **recomputed** projection of the live policy
  decision (`pass` | `warn` | `block`) against the current Discovery evidence and
  drift. It carries `source: "computed_from_current_status_projection"` and is
  never persisted. Under `advisory` enforcement, `block` decisions are reported
  as `warn`. Use it to preview the decision a mutating tool would face before the
  next seam evaluation or `/hydrate` reconcile.

### Recovery

If a `required` gate blocks a mutating tool, run `flowguard_hydrate` to refresh
Discovery and reconcile the gate. To opt out of enforcement entirely, set
`policy.discoveryHealth.enforcement` to `advisory` or `off`.

## Validation Evidence Enforcement

FlowGuard can refuse to let the `VALIDATION` phase pass **vacuously** — that is,
with an empty `activeChecks` list and therefore no executed verification evidence.
Without this control, a session with no Discovery-derived verification commands
auto-advances `PLAN_REVIEW → VALIDATION → IMPLEMENTATION` while proving nothing.

The `policy.validationEvidence` block is a fail-closed control frozen into the
policy snapshot at hydrate time and consumed by the single authority
`evaluateValidationEvidence`. It governs **progression admissibility only** — it
never fabricates evidence and never injects fallback commands. The
`verificationCandidates`/`activeChecks` lists remain the sole source of truth for
what may be executed.

### Configuration

```json
{
  "policy": {
    "validationEvidence": {
      "enforcement": "required",
      "allowNoCommands": false
    }
  }
}
```

| Field             | Values                        | Effect                                                                                                         |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `enforcement`     | `off`, `advisory`, `required` | Whether an empty `activeChecks` list blocks progression. `off`/`advisory` preserve the legacy vacuous pass.    |
| `allowNoCommands` | `true`, `false`               | The **only** sanctioned opt-out. When `true`, a verified "no verification commands" repo state passes legally. |

Enforcement is effective only when `enforcement: required` **and**
`allowNoCommands: false`. A non-empty `activeChecks` list is always governed by
ordinary check pass/fail evaluation and is never blocked by this control.

### Per-mode defaults

| Mode        | `enforcement` | `allowNoCommands` |
| ----------- | ------------- | ----------------- |
| `solo`      | `off`         | `false`           |
| `team`      | `off`         | `false`           |
| `team-ci`   | `required`    | `false`           |
| `regulated` | `required`    | `false`           |

Legacy policy snapshots without a `validationEvidence` block receive the same
fail-closed, mode-consistent default when loaded.

> **Behavior change (#400):** Under `team-ci` and `regulated`, a `VALIDATION`
> phase with **no active checks** now **blocks** instead of silently passing.
> Sessions that previously relied on the vacuous pass must either expose
> Discovery-derived verification commands or explicitly opt out with
> `validationEvidence.allowNoCommands: true`.

### Enforcement semantics

When `enforcement: required`, `allowNoCommands: false`, and `activeChecks` is
empty, the authority distinguishes two cases based on whether Discovery is
trustworthy enough to assert that "no commands" is a true repository property:

- **`VALIDATION_EVIDENCE_REQUIRED`** — Discovery is trustworthy (persisted
  Discovery summary and digest present, `discoveryHealth` enforcement is
  `required`, the health gate is `clear`, and the last drift assessment is
  `clean`). The empty list is a verified repo property and policy forbids the
  vacuous pass.
- **`VALIDATION_EVIDENCE_UNVERIFIED`** — Discovery is **not** trustworthy, so the
  runtime cannot prove the empty list is real. Rather than assert false
  certainty, it blocks fail-closed and marks the outcome `NOT_VERIFIED`.

Both codes are surfaced by `flowguard_run_check` (empty-check seam),
`/continue` (which refuses to auto-advance past `VALIDATION`), and
`flowguard_status` next-action guidance, which directs the operator to
`/hydrate` and `/status`.

### Recovery

Expose Discovery-derived verification commands (so `activeChecks` is non-empty),
or, if the repository legitimately has no verification commands, opt out
explicitly by setting `policy.validationEvidence.allowNoCommands` to `true`.
To disable the control entirely, set `policy.validationEvidence.enforcement` to
`advisory` or `off`.
