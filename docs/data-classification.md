# Data Classification

This document describes how FlowGuard classifies, handles, and protects data.

---

## Overview

FlowGuard processes data in two contexts:
1. **Workflow Data** — Evidence, plans, decisions created during FlowGuard sessions
2. **Operational Data** — Installation files, configuration, audit trails

---

## Delivery Scope

| Category | Description | Example |
|----------|-------------|---------|
| **Technically Enforced** | Guarantees by implementation | Zod schema validation, hash chain integrity |
| **Currently Delivered** | Available in current release | State persistence, archive with manifest |
| **Optional** | Can be configured | Encryption, external storage |
| **Not Covered** | Intentionally not provided | Multi-user access control, data loss prevention |
| **Customer Responsibility** | Customer must handle | Encryption at rest, network security, backup |

---

## Data Classification Matrix

### Session State

| Attribute | Classification | Protection |
|-----------|---------------|------------|
| **Session ID** | Internal | FlowGuard runtime |
| **Phase** | Internal | FlowGuard runtime |
| **Profile** | Internal | FlowGuard runtime |
| **Evidence (ticket, plan, etc.)** | **Confidential** | Customer responsibility |
| **Review decisions** | **Confidential** | Customer responsibility |
| **Policy snapshot** | Internal | Hash-protected |

**Currently Delivered:**
- Zod-validated JSON persistence
- Atomic writes
- Schema validation on every read

**Customer Responsibility:**
- Filesystem access control
- Backup and recovery
- Encryption at rest (if required)

### Audit Trail

| Attribute | Classification | Protection |
|-----------|---------------|------------|
| **Event timestamps** | Internal | JSONL append-only |
| **Event kinds** | Internal | Structured schema |
| **Actor identity** | **Confidential** | Customer responsibility |
| **Event details** | **Confidential** | Customer responsibility |
| **Hash chain** | Integrity-critical | SHA-256 enforced |

**Technically Enforced:**
- SHA-256 hash chain (tamper-evident)
- Append-only JSONL format
- Zod schema validation on each event

**Customer Responsibility:**
- Filesystem access control
- Long-term retention
- Archive integrity verification

### Configuration

| Attribute | Classification | Protection |
|-----------|---------------|------------|
| **Policy mode** | Internal | Runtime only |
| **Profile rules** | Internal | Runtime only |
| **Reason codes** | Internal | Runtime only |
| **Installation path** | Internal | Filesystem |

**Currently Delivered:**
- Configuration stored in `flowguard.json` (optional)
- Profile auto-detection from repository signals

### Installation Artifacts

| Attribute | Classification | Protection |
|-----------|---------------|------------|
| **CLI binary** | Proprietary | LICENSE file |
| **Core package** | Proprietary | Binary distribution |
| **Mandates** | Internal | Content-digested |
| **Tool bindings** | Internal | Installed files |

**Currently Delivered:**
- Pre-built proprietary artifact
- Content digest on mandates file
- Installer validation

---

## Data Handling Requirements

### Confidentiality

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| **Encryption at rest** | **Not Covered** | Customer responsibility |
| **Encryption in transit** | **Not Applicable** | No network communication |
| **Access control** | **Not Covered** | OS-level, customer responsibility |
| **Data loss prevention** | **Not Covered** | Customer responsibility |

### Integrity

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| **State validation** | **Technically Enforced** | Zod schemas on every write |
| **Audit chain** | **Technically Enforced** | SHA-256 hash chain |
| **Archive verification** | **Currently Delivered** | Multi-check validation |
| **Tamper detection** | **Technically Enforced** | Hash chain breaks on modification |

### Availability

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| **Backup** | **Customer Responsibility** | Manual archive export |
| **Restore** | **Customer Responsibility** | Archive extraction + verification |
| **Disaster recovery** | **Customer Responsibility** | Tested restore procedures |

---

## Retention and Disposal

### Session Data Retention

| Data Type | Default Retention | Customer Responsibility |
|-----------|------------------|------------------------|
| **Active session state** | Until session complete/abort | Customer responsibility |
| **Audit trail** | Until archived | Customer responsibility |
| **Archives** | Indefinite (customer-managed) | Customer responsibility |
| **Discovery snapshots** | Until archived | Customer responsibility |

**Customer Responsibility:**
- Define retention policies
- Implement automated backup
- Test restore procedures
- Secure disposal of old archives

### Installation Data Retention

| Data Type | Retention | Notes |
|-----------|-----------|-------|
| **CLI installation** | Until uninstalled | Can be reinstalled from artifact |
| **Configuration** | Until changed | Optional `flowguard.json` |
| **Mandates** | Until updated | Content-digested, versioned |

---

## Sensitive Data Handling

### Data Flow

```
User Input → OpenCode → FlowGuard Tools → Session State → Audit Trail → Archive
                ↓               ↓
            Commands      Evidence (ticket, plan, etc.)
```

### Sensitive Data Categories

| Category | Examples | Handling |
|----------|----------|----------|
| **Credentials** | API keys, passwords | FlowGuard never processes; customer responsible |
| **Business logic** | Plans, designs, code | Evidence in session; customer responsibility |
| **Review comments** | Approval rationale | Evidence in session; customer responsibility |
| **User identities** | Initiator, reviewer | Tracked in audit; customer responsibility |

### Data Isolation

| Mechanism | Scope | Implementation |
|-----------|-------|----------------|
| **Session isolation** | Per-session | Session ID + workspace binding |
| **Workspace isolation** | Per-repository | Git worktree fingerprint |
| **Process isolation** | Per-machine | OpenCode runtime boundary |

**Not Covered:**
- Cross-session data isolation (customer manages access)
- Encryption boundaries (customer configures)
- Network isolation (customer implements)

---

## Customer Responsibilities Summary

| Area | Responsibility |
|------|----------------|
| **Encryption** | Enable if required by policy |
| **Access control** | OS-level permissions, directory protection |
| **Backup** | Regular archive export and storage |
| **Retention** | Define and enforce retention policies |
| **Disposal** | Secure deletion of old data |
| **Compliance mapping** | Map data classification to regulatory requirements |

---

*FlowGuard Version: 1.3.0*
*Last Updated: 2026-04-15*
