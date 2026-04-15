# Policies

FlowGuard supports three policy modes that determine the level of enforcement.

## Policy Modes

| Mode | Human Gates | Four-Eyes | Self-Approval |
|------|-------------|-----------|---------------|
| Solo | 0 | No | Allowed |
| Team | 3 | Optional | Allowed |
| Regulated | 3 | **Required** | **Not Allowed** |

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

| Setting | Solo | Team | Regulated |
|---------|------|------|-----------|
| Human gates | 0 | 3 | 3 |
| Four-eyes required | No | No | **Yes** |
| Self-approval | Allowed | Allowed | **Not Allowed** |
| Audit trail | Optional | Recommended | **Mandatory** |
| Hash chain | No | Optional | **Yes** |
