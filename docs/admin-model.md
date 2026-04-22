# Admin Model

This document describes ownership, administration, and operational responsibilities for FlowGuard deployments.

---

## Overview

FlowGuard has a flat ownership model:

- **Single owner** per installation
- **Per-session roles** (initiator, reviewer) for regulated workflows
- **No built-in multi-user administration**

---

## Delivery Scope

| Category                    | Description                  | Example                           |
| --------------------------- | ---------------------------- | --------------------------------- |
| **Technically Enforced**    | Guarantees by implementation | Four-eyes principle, phase gates  |
| **Currently Delivered**     | Available in current release | Policy modes, profile rules, CLI  |
| **Optional**                | Can be configured            | Custom profiles, reason codes     |
| **Not Covered**             | Intentionally not provided   | Team management, role hierarchies |
| **Customer Responsibility** | Operational decisions        | User provisioning, access control |

---

## Ownership Model

### Installation Owner

| Attribute            | Description                                                       |
| -------------------- | ----------------------------------------------------------------- |
| **Definition**       | Person who installed FlowGuard or owns the installation directory |
| **Responsibilities** | Upgrade management, configuration, backup                         |
| **Capabilities**     | Full control over installation                                    |

**Currently Delivered:**

- CLI with upgrade, uninstall, doctor commands
- Optional workspace `config.json` configuration
- Archive management

**Customer Responsibility:**

- Designating installation owner
- Transferring ownership on personnel changes
- Documenting installation configuration

### Session Roles

FlowGuard supports two roles within a session:

| Role          | Description                   | Enforced             |
| ------------- | ----------------------------- | -------------------- |
| **Initiator** | Person who starts the session | Always tracked       |
| **Reviewer**  | Person who approves at gates  | Team/Regulated modes |

**Technically Enforced:**

- Regulated mode: reviewer must differ from initiator
- Self-approval blocked in Regulated mode
- Identity tracked in audit trail

**Customer Responsibility:**

- Identity management (authentication)
- Reviewer assignment
- Role-based access control (external)

---

## Administration Tasks

### Day-to-Day Operations

| Task                     | Owner             | Frequency             |
| ------------------------ | ----------------- | --------------------- |
| **Session management**   | Session initiator | Per session           |
| **Archive creation**     | Session initiator | Per completed session |
| **Archive verification** | Reviewer or owner | On restore            |

**Currently Delivered:**

- CLI commands for session control
- `/hydrate`, `/ticket`, `/plan`, etc.
- `/archive` for session export
- `/review` for compliance reporting

### Installation Management

| Task                      | Owner              | Frequency   |
| ------------------------- | ------------------ | ----------- |
| **Initial installation**  | Installation owner | Once        |
| **Upgrades**              | Installation owner | As needed   |
| **Configuration changes** | Installation owner | As needed   |
| **Uninstall**             | Installation owner | When needed |

**Currently Delivered:**

- `flowguard install --core-tarball <path>`
- `flowguard uninstall`
- `flowguard doctor` for integrity checks

**Customer Responsibility:**

- Monitoring for security releases
- Testing upgrades in non-production
- Maintaining artifact archives

### Policy Management

| Task                      | Owner            | Frequency              |
| ------------------------- | ---------------- | ---------------------- |
| **Profile selection**     | Repository owner | Per repository         |
| **Policy mode selection** | Project owner    | Per session or project |
| **Custom rules**          | Organization     | As needed              |

**Currently Delivered:**

- 4 built-in profiles (Baseline, Java, Angular, TypeScript)
- 4 policy modes (Solo, Team, Team-CI, Regulated)
- Central minimum policy enforcement via `FLOWGUARD_POLICY_PATH`
- Configurable reason codes
- Custom check executors

**Customer Responsibility:**

- Profile customization for domain
- Central policy file lifecycle and distribution to execution environments
- Compliance mapping

---

## Access Control

### FlowGuard Access

| Resource            | Access Required                  | Not Covered    |
| ------------------- | -------------------------------- | -------------- |
| **Run FlowGuard**   | Execute access to installation   | Authentication |
| **Modify session**  | Write to `.opencode/`            | Authorization  |
| **View session**    | Read `.opencode/`                | Authorization  |
| **Archive session** | Read `.opencode/`, write archive | Authorization  |

**Customer Responsibility:**

- OS-level file permissions
- User authentication
- Authorization for shared installations

### Audit Access

| Action               | Access Required                      |
| -------------------- | ------------------------------------ |
| **Read audit trail** | Read `.opencode/audit.jsonl`         |
| **Verify integrity** | Read access + tool execution         |
| **Export archive**   | Read `.opencode/`, write destination |

**Customer Responsibility:**

- Who can read audit trails
- Who can verify archives
- Long-term archive storage

---

## Team Deployment

### Shared Installation

For teams sharing a single installation:

| Scenario                   | Supported       | Implementation                    |
| -------------------------- | --------------- | --------------------------------- |
| **Shared global install**  | Yes             | Multiple users, same installation |
| **Shared project install** | Yes             | `.opencode/` in repo              |
| **Team administration**    | **Not Covered** | External tooling                  |

**Customer Responsibility:**

- User provisioning
- Access control
- Configuration management

### Repository-Scoped Deployment

| Feature                   | Status                      | Notes                                              |
| ------------------------- | --------------------------- | -------------------------------------------------- |
| **Per-repo installation** | **Currently Delivered**     | `--install-scope repo`                             |
| **Repo-specific config**  | **Currently Delivered**     | Workspace `config.json` per repository fingerprint |
| **Team-wide policies**    | **Customer Responsibility** | Git hooks, CI enforcement                          |

---

## Escalation Model

### Issue Categories

| Category                   | First Response           | Resolution              |
| -------------------------- | ------------------------ | ----------------------- |
| **Installation failure**   | Self-service             | `flowguard doctor`      |
| **Session blocked**        | Self-service             | Reason codes + recovery |
| **Bug in FlowGuard**       | GitHub issue             | Best-effort             |
| **Security vulnerability** | GitHub security advisory | Per SECURITY.md         |
| **Compliance question**    | Customer responsibility  | External consultant     |

### Support Path

```
User → Installation Owner → FlowGuard Maintainer (via GitHub)
         ↓
    Internal IT (if applicable)
```

**Customer Responsibility:**

- Defining internal escalation path
- Training users on issue categories
- Coordinating with FlowGuard maintainer

---

## Operational Procedures

### New Team Member Onboarding

| Step | Owner              | Action                                |
| ---- | ------------------ | ------------------------------------- |
| 1    | Installation Owner | Ensure FlowGuard installed            |
| 2    | Installation Owner | Share installation location           |
| 3    | New Member         | Verify with `flowguard doctor`        |
| 4    | New Member         | Complete first session under guidance |

### Incident Response

| Phase             | Action                                    | Owner              |
| ----------------- | ----------------------------------------- | ------------------ |
| **Detection**     | User reports issue                        | User               |
| **Triage**        | Identify scope (install, session, policy) | Installation Owner |
| **Mitigation**    | Workaround or rollback                    | Installation Owner |
| **Recovery**      | Restore from archive if needed            | Session owner      |
| **Post-incident** | Document and prevent                      | Installation Owner |

**Customer Responsibility:**

- Incident response procedures
- Backup verification
- Rollback testing

---

## Limitations

| Limitation               | Impact                   | Workaround                           |
| ------------------------ | ------------------------ | ------------------------------------ |
| **No built-in admin UI** | Manual CLI management    | Custom tooling                       |
| **No role hierarchies**  | Flat permission model    | External IAM                         |
| **No team management**   | Manual user coordination | Team conventions                     |
| **No delegated admin**   | Single owner per install | Shared credentials (not recommended) |

---

_FlowGuard Version: 1.1.0_
_Last Updated: 2026-04-15_
