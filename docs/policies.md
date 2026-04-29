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

- 3 mandatory human gates (PLAN_REVIEW, IMPL_REVIEW, EVIDENCE_REVIEW)
- Four-eyes optional (can be same person)
- Self-approval allowed
- Review documentation required

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

- 3 mandatory human gates
- Four-eyes **required** — reviewer must differ from initiator
- Self-approval **not allowed**
- Audit trail mandatory
- Hash chain verification

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

In `config.json`:

```json
{
  "policy": {
    "defaultMode": "regulated",
    "modes": {
      "regulated": {
        "requireHumanGates": true,
        "allowSelfApproval": false,
        "audit": {
          "emitTransitions": true,
          "emitToolCalls": true,
          "enableChainHash": true
        }
      }
    }
  }
}
```

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

| Setting            | Solo     | Team        | Team-CI     | Regulated       |
| ------------------ | -------- | ----------- | ----------- | --------------- |
| Human gates        | 0        | 3           | 0 (CI only) | 3               |
| Four-eyes required | No       | No          | No          | **Yes**         |
| Self-approval      | Allowed  | Allowed     | Allowed     | **Not Allowed** |
| Audit trail        | Optional | Recommended | Recommended | **Mandatory**   |
| Hash chain         | No       | Optional    | **Yes**     | **Yes**         |

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

All policy modes default to `minimumActorAssuranceForApproval: best_effort`. This means any resolved actor identity — even from environment variables or git config — satisfies the approval threshold.

**Stronger assurance requires explicit configuration.** FlowGuard does not silently escalate identity requirements based on policy mode alone.

### Configuring Stronger Assurance

To require verified identity for approvals, set both fields in `config.json`:

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
- **`/review-decision`** resolves actor identity **with full IdP/policy context** from the session's policy snapshot. If the actor's assurance is below the configured `minimumActorAssuranceForApproval` threshold, the decision is **BLOCKED** with `ACTOR_ASSURANCE_INSUFFICIENT`.
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
