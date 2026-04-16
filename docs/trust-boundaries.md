# Trust Boundaries

This document describes the trust boundaries within FlowGuard and between FlowGuard and its environment.

---

## Overview

A trust boundary is a line across which data passes between trusted and untrusted components. Understanding these boundaries is essential for security assessment and deployment planning.

---

## Delivery Scope

| Category | Description | Example |
|----------|-------------|---------|
| **Technically Enforced** | Guarantees by implementation | Fail-closed, hash chain, phase gates |
| **Currently Delivered** | Available in current release | CLI, state validation, audit |
| **Optional** | Can be configured | Policy mode selection |
| **Not Covered** | Intentionally not provided | Network isolation, encryption |
| **Customer Responsibility** | External to FlowGuard | OS security, network controls |

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

| Property | Trust Level | Reason |
|----------|-------------|--------|
| **State Machine** | **Highest** | Pure, deterministic, no side effects |
| **Evaluator** | **Highest** | Pure function, no I/O |
| **Topology** | **Highest** | Immutable transition table |
| **Guards** | **Highest** | Pure predicates |

**Technically Enforced:**
- No network calls from core
- No filesystem access from pure functions
- Zod schema validation on all state transitions
- Fail-closed on unknown inputs

### Adapters

| Property | Trust Level | Reason |
|----------|-------------|--------|
| **Persistence** | Medium | Reads/writes filesystem |
| **Workspace** | Medium | Enumerates repository files |
| **Git** | Medium | Calls external git binary |
| **Context** | Medium | Integrates with OpenCode |

**Customer Responsibility:**
- Filesystem permissions
- Git binary availability
- OpenCode installation integrity

### CLI

| Property | Trust Level | Reason |
|----------|-------------|--------|
| **Installer** | Medium | Writes to filesystem |
| **Doctor** | Medium | Reads filesystem |
| **Templates** | Lower | Generates user-facing files |

**CLI Design:**
- Re-running install with --force re-applies templates
- Merge-aware package.json handling
- AGENTS.md is not modified by installer

---

## Boundary Crossings

### Filesystem Boundary

| Direction | Mechanism | Validation |
|-----------|-----------|------------|
| **Read state** | Adapter reads JSON | Zod parse, reject invalid |
| **Write state** | Adapter writes JSON | Zod validate before write |
| **Read evidence** | Adapter reads files | Path validation |
| **Write audit** | Adapter appends JSONL | Hash chain update |

**Customer Responsibility:**
- Filesystem permissions
- Directory protection
- Concurrent access control

### OpenCode Boundary

| Direction | Mechanism | Validation |
|-----------|-----------|------------|
| **Tool calls** | OpenCode invokes FlowGuard tools | Tool interface contracts |
| **State access** | Tools read/write session state | Via adapters only |
| **Audit events** | Plugin records via hook | Structured event schema |

**FlowGuard Adapters Only:**
- FlowGuard accesses filesystem only through adapters
- Adapters validate and transform all data
- No raw filesystem access from core logic

### Network Boundary

| Direction | Status | Implementation |
|-----------|--------|----------------|
| **Outbound** | **Not Supported** | No network calls in FlowGuard |
| **Inbound** | **Not Applicable** | Local process only |

**Customer Responsibility:**
- Network isolation verification
- Firewall rules for air-gapped environments

---

## Threat Model

### Threats Within Trust Boundary

| Threat | Mitigated By |
|--------|--------------|
| **Tampered state** | Zod schema validation, hash chain |
| **Tampered audit** | Hash chain breaks on modification |
| **Invalid transitions** | Topology enforced, no bypass |
| **Missing evidence** | Phase gates block progression |

### Threats Outside Trust Boundary

| Threat | Mitigation |
|--------|------------|
| **Unauthorized access** | OS file permissions (customer) |
| **Disk corruption** | Backup and restore (customer) |
| **Malicious OpenCode** | OpenCode sandbox (OpenCode) |
| **OS compromise** | Host hardening (customer) |

---

## Security Properties

### FlowGuard Design Properties

| Property | Implementation |
|----------|---------------|
| **Integrity** | Hash chain, Zod validation, fail-closed |
| **Determinism** | Pure functions, no randomness |
| **Traceability** | Policy snapshot, audit trail |
| **Isolation** | Adapters as boundary layer |

### Customer Responsibility

| Property | Notes |
|----------|-------|
| **Confidentiality** | Data in session files — customer controls access |
| **Network isolation** | Customer implements |
| **Encryption at rest** | Customer implements |
| **Access control** | OS-level permissions |

---

## Deployment Considerations

### Single-User Machine

| Boundary | Assessment |
|----------|------------|
| **Filesystem** | Trust local user |
| **Network** | Customer responsibility |
| **OpenCode** | Trust OpenCode runtime |

### Shared Development Machine

| Boundary | Assessment |
|----------|------------|
| **Filesystem** | Minimize shared access |
| **Network** | Customer responsibility |
| **OpenCode** | Per-user isolation |

### Air-Gapped Environment

| Boundary | Assessment |
|----------|------------|
| **Network** | Physically isolated |
| **Filesystem** | Physical access control |
| **Updates** | Manual artifact transfer |

---

*FlowGuard Version: 1.0.0*
*Last Updated: 2026-04-15*
