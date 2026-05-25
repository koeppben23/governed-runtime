# Trust Boundaries

This document describes the trust boundaries within FlowGuard and between FlowGuard and its environment.

---

## Overview

A trust boundary is a line across which data passes between trusted and untrusted components. Understanding these boundaries is essential for security assessment and deployment planning.

---

## Delivery Scope

| Category                    | Description                  | Example                              |
| --------------------------- | ---------------------------- | ------------------------------------ |
| **Technically Enforced**    | Guarantees by implementation | Fail-closed, hash chain, phase gates |
| **Currently Delivered**     | Available in current release | CLI, state validation, audit         |
| **Optional**                | Can be configured            | Policy mode selection                |
| **Not Covered**             | Intentionally not provided   | Network isolation, encryption        |
| **Customer Responsibility** | External to FlowGuard        | OS security, network controls        |

---

## Trust Boundary Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        HOST ENVIRONMENT                          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │    OS       │    │  Network    │    │   Filesystem        │  │
│  │(customer-   │    │  (external) │    │   (customer-        │  │
│  │ managed)    │    │             │    │    managed)         │  │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘  │
│         │                   │                     │              │
│         │                   │                     │              │
│         ▼                   ▼                     ▼              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              FLOWGUARD TRUST BOUNDARY                    │   │
│  │                                                          │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────────┐   │   │
│  │  │   CLI      │  │   Core     │  │    Adapters    │   │   │
│  │  │  (install) │  │ (machine)  │  │  (filesystem)  │   │   │
│  │  └────────────┘  └────────────┘  └────────────────┘   │   │
│  │                                                          │   │
│  │  Trust Level: Highest ←─────────────────────→ Lower      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Trust Levels

### FlowGuard Core

| Property          | Trust Level | Reason                               |
| ----------------- | ----------- | ------------------------------------ |
| **State Machine** | **Highest** | Pure, deterministic, no side effects |
| **Evaluator**     | **Highest** | Pure function, no I/O                |
| **Topology**      | **Highest** | Immutable transition table           |
| **Guards**        | **Highest** | Pure predicates                      |

**Technically Enforced:**

- No network calls from core
- No filesystem access from pure functions
- Zod schema validation on all state transitions
- Fail-closed on unknown inputs

### Adapters

| Property        | Trust Level | Reason                                      |
| --------------- | ----------- | ------------------------------------------- |
| **Persistence** | Medium      | Reads/writes filesystem                     |
| **Workspace**   | Medium      | Enumerates repository files                 |
| **Git**         | Medium      | Calls external git binary                   |
| **Context**     | Medium      | Integrates with configured host runtime     |
| **Network**     | Medium      | Optional HTTPS fetches and local hook ports |

**Customer Responsibility:**

- Filesystem permissions
- Git binary availability
- Host runtime installation integrity
- Network policy for optional URL review, remote JWKS, and localhost hook use

### CLI

| Property      | Trust Level | Reason                      |
| ------------- | ----------- | --------------------------- |
| **Installer** | Medium      | Writes to filesystem        |
| **Doctor**    | Medium      | Reads filesystem            |
| **Templates** | Lower       | Generates user-facing files |

**CLI Design:**

- Re-running install with --force re-applies templates
- Merge-aware package.json handling
- AGENTS.md is not modified by installer

---

## Boundary Crossings

### Filesystem Boundary

| Direction         | Mechanism             | Validation                |
| ----------------- | --------------------- | ------------------------- |
| **Read state**    | Adapter reads JSON    | Zod parse, reject invalid |
| **Write state**   | Adapter writes JSON   | Zod validate before write |
| **Read evidence** | Adapter reads files   | Path validation           |
| **Write audit**   | Adapter appends JSONL | Hash chain update         |

**Customer Responsibility:**

- Filesystem permissions
- Directory protection
- Concurrent access control

### Host Runtime Boundary

| Direction        | Mechanism                                            | Validation               |
| ---------------- | ---------------------------------------------------- | ------------------------ |
| **Tool calls**   | Host invokes FlowGuard tools, hooks, or MCP server   | Tool interface contracts |
| **State access** | Tools read/write session state                       | Via adapters only        |
| **Audit events** | Plugin or hook records host tool activity            | Structured event schema  |
| **Local hooks**  | Claude Code HTTP hook mode uses a localhost listener | Hook payload validation  |

**FlowGuard Adapters Only:**

- FlowGuard accesses filesystem only through adapters
- Adapters validate and transform all data
- No raw filesystem access from core logic

### Network Boundary

FlowGuard is filesystem-first and offline-capable by default. Network activity is
limited to documented, operator-selected surfaces.

| Direction    | Status                     | Implementation                                                                                  |
| ------------ | -------------------------- | ----------------------------------------------------------------------------------------------- |
| **Outbound** | Default: none required     | Installed dependencies resolve from local artifacts; core state-machine execution is offline    |
| **Outbound** | Explicit `/review` input   | `/review url=...` performs HTTPS content loading after HTTPS URL validation and fail-closed DNS target validation |
| **Outbound** | Explicit IdP configuration | Remote JWKS refresh uses HTTPS when `identityProvider.mode=jwks` and `jwksUri` are configured   |
| **Inbound**  | Default: none              | Standard OpenCode/plugin operation does not start a FlowGuard listener                          |
| **Inbound**  | Explicit Claude hook mode  | Claude Code HTTP hook mode starts a localhost listener, default `127.0.0.1:18462`, when enabled |

**Customer Responsibility:**

- Network isolation verification
- Firewall rules for air-gapped environments
- Disabling or avoiding network-dependent features (`/review url=...`, remote JWKS,
  Claude HTTP hook listener) where outbound access or local listeners are prohibited

**`/review url=...` target validation:**

- Only `https:` URLs are accepted.
- `localhost`, private/reserved literal IPv4 and IPv6 targets, DNS lookup failures,
  empty DNS results, malformed DNS addresses, and mixed DNS answers containing any
  private/reserved A or AAAA record are blocked before native `fetch` is called.
- Redirect following is disabled.
- Residual risk remains: DNS preflight does not cryptographically bind the validated
  address to the later HTTPS connection. Deployments that need complete SSRF
  containment should also enforce host-level egress controls or a network sandbox.

---

## Threat Model

### Threats Within Trust Boundary

| Threat                  | Mitigated By                      |
| ----------------------- | --------------------------------- |
| **Tampered state**      | Zod schema validation, hash chain |
| **Tampered audit**      | Hash chain breaks on modification |
| **Invalid transitions** | Topology enforced, no bypass      |
| **Missing evidence**    | Phase gates block progression     |

### Threats Outside Trust Boundary

| Threat                     | Mitigation                     |
| -------------------------- | ------------------------------ |
| **Unauthorized access**    | OS file permissions (customer) |
| **Disk corruption**        | Backup and restore (customer)  |
| **Malicious host runtime** | Host sandbox and OS controls   |
| **OS compromise**          | Host hardening (customer)      |

---

## Security Properties

### FlowGuard Design Properties

| Property         | Implementation                          |
| ---------------- | --------------------------------------- |
| **Integrity**    | Hash chain, Zod validation, fail-closed |
| **Determinism**  | Pure functions, no randomness           |
| **Traceability** | Policy snapshot, audit trail            |
| **Isolation**    | Adapters as boundary layer              |

### Customer Responsibility

| Property               | Notes                                            |
| ---------------------- | ------------------------------------------------ |
| **Confidentiality**    | Data in session files — customer controls access |
| **Network isolation**  | Customer implements                              |
| **Encryption at rest** | Customer implements                              |
| **Access control**     | OS-level permissions                             |

---

## Deployment Considerations

### Single-User Machine

| Boundary       | Assessment                    |
| -------------- | ----------------------------- |
| **Filesystem** | Trust local user              |
| **Network**    | Customer responsibility       |
| **Host**       | Trust configured host runtime |

### Shared Development Machine

| Boundary       | Assessment              |
| -------------- | ----------------------- |
| **Filesystem** | Minimize shared access  |
| **Network**    | Customer responsibility |
| **Host**       | Per-user isolation      |

### Air-Gapped Environment

| Boundary       | Assessment                                                                           |
| -------------- | ------------------------------------------------------------------------------------ |
| **Network**    | Physically isolated; do not configure or invoke network-dependent FlowGuard features |
| **Filesystem** | Physical access control                                                              |
| **Updates**    | Manual artifact transfer                                                             |

---

FlowGuard Version: 1.2.0-rc.3
_Last Updated: 2026-04-15_
