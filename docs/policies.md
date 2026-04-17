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

## Identity Assertions (OIDC-first)

At `/hydrate`, FlowGuard resolves session identity from trusted host assertions.

Validation is fail-closed and checks:

- required assertion schema (`subjectId`, `identitySource`, `assertedAt`, `assuranceLevel`)
- OIDC issuer trust (`identity.allowedIssuers`)
- freshness (`identity.assertionMaxAgeSeconds`)
- session binding (`identity.requireSessionBinding` + `sessionBindingId`)

Identity source policy:

- **Primary path:** `oidc` (or `service` for CI contexts)
- **Fallback path:** `local` only when mode is listed in `identity.allowLocalFallbackModes`
- **Regulated by default:** local is blocked unless explicitly allowed in config
- **Regulated OIDC trust boundary:** `identity.allowedIssuers` must be non-empty for OIDC assertions

Fail-closed reason codes:

- `IDENTITY_UNVERIFIED`
- `UNTRUSTED_IDENTITY_ISSUER`
- `IDENTITY_SOURCE_NOT_ALLOWED`

## RBAC Approval Constraints

At `/review-decision`, FlowGuard resolves reviewer roles from `rbac.roleBindings` and enforces
mode-aware approval constraints.

Default constraints:

- `regulated` requires dual control (reviewer identity must differ from initiator)
- `regulated` requires reviewer role `approver` or `policy_owner`

Fail-closed reason codes:

- `DUAL_CONTROL_REQUIRED`
- `APPROVER_ROLE_MISMATCH`

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
/flowguard_hydrate policyMode=regulated
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

## Policy Comparison

| Setting            | Solo     | Team        | Team-CI     | Regulated       |
| ------------------ | -------- | ----------- | ----------- | --------------- |
| Human gates        | 0        | 3           | 0 (CI only) | 3               |
| Four-eyes required | No       | No          | No          | **Yes**         |
| Self-approval      | Allowed  | Allowed     | Allowed     | **Not Allowed** |
| Audit trail        | Optional | Recommended | Recommended | **Mandatory**   |
| Hash chain         | No       | Optional    | **Yes**     | **Yes**         |
