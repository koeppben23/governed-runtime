# Security Hardening

This document provides recommendations for securing FlowGuard deployments.

---

## Overview

FlowGuard is designed to run locally with no network access. Security hardening focuses on host-level controls and operational practices.

---

## Delivery Scope

| Category | Description | Example |
|----------|-------------|---------|
| **Technically Enforced** | Guarantees by implementation | Fail-closed, hash chain, phase gates |
| **Currently Delivered** | Available in current release | CLI, state validation, audit |
| **Not Covered** | Customer implements | OS hardening, encryption, access control |

---

## Host-Level Hardening

### Filesystem Permissions

| Path | Recommended Permissions | Notes |
|------|------------------------|-------|
| `~/.config/opencode/` | 700 (owner only) | Contains session state |
| `.opencode/` | 700 (owner only) | Project-scoped install |
| `.opencode/audit.jsonl` | 600 (owner read/write) | Audit trail |
| `.opencode/state.json` | 600 (owner read/write) | Session state |

**Customer Responsibility:**
- Set appropriate filesystem permissions
- Audit permissions regularly
- Restrict access to authorized users only

### Installation Directory

| Path | Purpose | Hardening |
|------|---------|------------|
| `~/.config/opencode/` | Global installation | User-owned, not shared |
| `vendor/` | Vendored artifacts | Read-only after install |
| `flowguard-mandates.md` | Managed mandates | Content-digested |

---

## Operational Security

### Session Isolation

| Practice | Recommendation |
|----------|----------------|
| **One session per workspace** | Avoid concurrent sessions in same directory |
| **Clean completion** | Archive and close sessions when done |
| **State protection** | Don't modify `.opencode/` files directly |

### Access Control

| Resource | Control |
|----------|---------|
| **FlowGuard execution** | OS user permissions |
| **Session state** | Filesystem permissions |
| **Audit trail** | Filesystem permissions |
| **Archives** | Archive permissions, storage access |

---

## Network Security

### Air-Gapped Deployment

| Step | Action |
|------|--------|
| 1 | Operator downloads artifact from release source |
| 2 | Verify checksum |
| 3 | Transfer to air-gapped environment |
| 4 | Install via `flowguard install --core-tarball <path>` | |

**Customer Responsibility:**
- Verify network isolation
- Configure firewall rules
- Monitor for unauthorized connections

### No Outbound Connections

FlowGuard does not make outbound network connections. After installation, FlowGuard runs entirely offline.

**Verification:**
```bash
# Monitor for network activity during FlowGuard execution
# (flowguard should make no network calls after install)
```

---

## Data Security

### Encryption at Rest

FlowGuard stores session data as plaintext JSON. If encryption is required:

**Customer Responsibility:**
- Enable filesystem-level encryption (LUKS, BitLocker, etc.)
- Use encrypted storage volumes
- Manage encryption keys separately

### Backup Security

| Asset | Security Measure |
|-------|------------------|
| **Session archives** | Encrypt before off-site storage |
| **Installation artifacts** | Store in secure artifact repository |
| **Configuration** | Version control with access control |

---

## Operational Practices

### Secure Development

| Practice | Recommendation |
|----------|----------------|
| **Minimize exposure** | Don't share `.opencode/` directories |
| **Clean up** | Archive completed sessions, remove temporary files |
| **Audit access** | Log who accesses session directories |

### Incident Response

| Phase | Action |
|-------|--------|
| **Detect** | Monitor for unauthorized access to `.opencode/` |
| **Respond** | Isolate affected sessions, revoke access |
| **Recover** | Restore from verified archive |
| **Post-incident** | Review access logs, update permissions |

---

## Compliance Mapping

| Control | Implementation |
|---------|---------------|
| **Access control** | OS permissions, filesystem ACLs |
| **Audit logging** | FlowGuard audit trail |
| **Data protection** | Customer-managed encryption |
| **Network isolation** | Customer-managed firewall |

---

*FlowGuard Version: 1.0.0*
*Last Updated: 2026-04-15*
