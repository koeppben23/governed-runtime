# Delivery Scope

This document defines what FlowGuard delivers, what it intentionally does not deliver, and where customer responsibility begins.

---

## Scope Categories

| Category                    | Definition                                                       |
| --------------------------- | ---------------------------------------------------------------- |
| **Technically Enforced**    | Guarantees that cannot be bypassed without modifying source code |
| **Currently Delivered**     | Features available in the current release                        |
| **Optional**                | Features that can be enabled but are not default                 |
| **Not Covered**             | Intentionally not implemented; customer must handle separately   |
| **Customer Responsibility** | Operational concerns outside FlowGuard's scope                   |

---

## Technically Enforced

These properties are guaranteed by the implementation and cannot be circumvented without code changes.

### Fail-Closed Enforcement

| Property                    | Description                                       |
| --------------------------- | ------------------------------------------------- |
| **Phase gates**             | Transitions require evidence; blocked without     |
| **Command admissibility**   | Commands rejected if not allowed in current phase |
| **Audit chain integrity**   | Tampered events detected and rejected             |
| **State schema validation** | Invalid state blocks all operations               |
| **Unknown phase/event**     | Blocks (no silent fallthrough to default)         |

### Deterministic Behavior

| Property                | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| **Pure state machine**  | Same state + event = same result                                                  |
| **No randomness**       | No probabilistic paths or hidden state                                            |
| **Reason codes**        | Every block has specific code + recovery guidance                                 |
| **Archive determinism** | Archive content is deterministic given identical session state and file inventory |

### Evidence Integrity

| Property                 | Description                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| **Hash chain**           | SHA-256 linked events, tamper-evident                                                      |
| **Policy snapshot**      | Immutable hash frozen at session start                                                     |
| **Archive verification** | Multi-check validation on restore (manifest, files, digests, discovery consistency, state) |
| **Discovery digest**     | Session state linked to discovery snapshot                                                 |

---

## Currently Delivered

These features are available in FlowGuard 1.0.0.

### Workflow Engine

| Feature                 | Status    | Notes                                                                                                |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| **14 explicit phases**  | Delivered | 3 flows: Ticket (READY→COMPLETE), Architecture (READY→ARCH_COMPLETE), Review (READY→REVIEW_COMPLETE) |
| **3 policy modes**      | Delivered | Solo, Team, Regulated                                                                                |
| **4 built-in profiles** | Delivered | Baseline, Java/Spring Boot, Angular/Nx, TypeScript/Node                                              |
| **4-phase self-review** | Delivered | iteration limit, digest convergence, verdict loop                                                    |
| **10 commands**         | Delivered | hydrate, ticket, plan, continue, implement, validate, review-decision, architecture, review, abort   |
| **11 custom tools**     | Delivered | OpenCode tool exports (+ archive operational tool)                                                   |
| **4 event kinds**       | Delivered | transition, tool_call, error, lifecycle                                                              |

### Audit & Compliance

| Feature                      | Status    | Notes                        |
| ---------------------------- | --------- | ---------------------------- |
| **Hash-chained audit trail** | Delivered | SHA-256, JSONL append-only   |
| **Compliance summary**       | Delivered | 7-check automated assessment |
| **Completeness matrix**      | Delivered | Per-slot evidence evaluation |
| **Archive with manifest**    | Delivered | Multi-check verification     |
| **Four-eyes enforcement**    | Delivered | Regulated mode only          |

### Installation & Operation

| Feature                    | Status    | Notes                                                                  |
| -------------------------- | --------- | ---------------------------------------------------------------------- |
| **CLI installer**          | Delivered | install, uninstall, doctor                                             |
| **Global installation**    | Delivered | `~/.config/opencode/`                                                  |
| **Project installation**   | Delivered | `.opencode/`                                                           |
| **Pre-built distribution** | Delivered | `.tgz` artifact                                                        |
| **Offline resolution**     | Delivered | `file:`-based dependencies                                             |
| **6-collector discovery**  | Delivered | Repo metadata, stack, topology, surface, domain, code-surface analysis |

---

## Optional

These features exist but are not enabled by default. Customer must explicitly configure.

| Feature                    | How to Enable                              | Notes                            |
| -------------------------- | ------------------------------------------ | -------------------------------- |
| **Regulated mode**         | `--policy-mode regulated` or `config.json` | Enforces four-eyes principle     |
| **Custom profiles**        | Register via config                        | Extend with stack-specific rules |
| **Custom reason codes**    | Register via config                        | Add domain-specific codes        |
| **Custom check executors** | Register via config                        | Integrate domain validators      |
| **Project-scoped install** | `--install-scope repo`                     | Commits `.opencode/` to repo     |

---

## Not Covered

FlowGuard does not provide these capabilities. Customer must address separately.

| Gap                          | Impact                            | Workaround                         |
| ---------------------------- | --------------------------------- | ---------------------------------- |
| **Multi-user sessions**      | No collaboration, no shared state | External workflow or ticket system |
| **CI/CD native integration** | No pipeline commands              | Custom script wrappers             |
| **Hosted / SaaS deployment** | No managed service                | Self-hosted only                   |
| **Compliance certification** | No SOC 2, ISO 27001, etc.         | Customer assessment required       |
| **LLM output validation**    | No code correctness guarantees    | External test suite                |
| **Distributed sessions**     | No cross-machine state            | Single-machine only                |
| **Remote attestation**       | No third-party verification       | Manual verification                |
| **Policy versioning**        | No audit of policy changes        | External version control           |

---

## Customer Responsibilities

The following operational concerns are outside FlowGuard's scope.

### Security & Access Control

| Area                       | Customer Responsibility                       |
| -------------------------- | --------------------------------------------- |
| **Host access**            | Control who can run FlowGuard                 |
| **Filesystem permissions** | Protect `.opencode/` from unauthorized access |
| **Network isolation**      | Ensure no outbound connections (air-gapped)   |
| **Artifact integrity**     | Verify checksums before installation          |
| **Secret management**      | Protect API keys, credentials                 |

### Data Management

| Area                   | Customer Responsibility                  |
| ---------------------- | ---------------------------------------- |
| **Backup**             | Archive `.opencode/` directory regularly |
| **Retention**          | Define how long session data is kept     |
| **Restore**            | Test restore from backup                 |
| **Archive storage**    | Where archives are stored long-term      |
| **Compliance mapping** | Map FlowGuard controls to regulations    |

### Operations

| Area                   | Customer Responsibility             |
| ---------------------- | ----------------------------------- |
| **Upgrade management** | Monitor releases, test upgrades     |
| **Rollback**           | Maintain previous artifact archives |
| **Incident response**  | React to FlowGuard failures         |
| **Support escalation** | Define internal escalation path     |
| **Documentation**      | Internal user guides, training      |

---

## Regulatory Considerations

FlowGuard provides **building blocks** for regulated workflows:

| Capability                | What It Provides               | What It Does Not Provide |
| ------------------------- | ------------------------------ | ------------------------ |
| **Audit trail**           | Tamper-evident event log       | Compliance certification |
| **Four-eyes enforcement** | Reviewer != initiator enforced | Regulatory approval      |
| **Evidence completeness** | Deterministic slot evaluation  | Completeness proof       |
| **Archive integrity**     | Multi-check verification       | Long-term preservation   |
| **Reason codes**          | Specific error vocabulary      | Root cause analysis      |

**Customer must assess** whether FlowGuard's controls satisfy their specific regulatory requirements.

---

_FlowGuard Version: 1.2.0-rc.1_
_Last Updated: 2026-04-15_
