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
