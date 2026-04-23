# Retention and Recovery

This document describes data retention policies and recovery procedures for FlowGuard.

---

## Overview

FlowGuard manages several types of data with different retention requirements. This document defines what is retained, for how long, and how to recover from failures.

---

## Delivery Scope

| Category                    | Description                  | Example                            |
| --------------------------- | ---------------------------- | ---------------------------------- |
| **Technically Enforced**    | Guarantees by implementation | Hash chain, state schema           |
| **Currently Delivered**     | Available in current release | Archive with verification          |
| **Optional**                | Can be configured            | Retention policies                 |
| **Not Covered**             | Intentionally not provided   | Automated backup, cloud storage    |
| **Customer Responsibility** | External to FlowGuard        | Backup schedules, archival storage |

---

## Data Retention Matrix

### FlowGuard Data Lifecycle

| Data Type              | FlowGuard Preserves | Until               | Customer Retains        |
| ---------------------- | ------------------- | ------------------- | ----------------------- |
| **Session state**      | Yes                 | Archived or cleaned | Archive indefinitely    |
| **Audit trail**        | Yes                 | Archived            | Archive indefinitely    |
| **Discovery snapshot** | Yes                 | Archived            | Archive indefinitely    |
| **Archives**           | —                   | —                   | Customer responsibility |

### Installation Data Lifecycle

| Data Type            | FlowGuard Preserves | Until       | Customer Responsibility |
| -------------------- | ------------------- | ----------- | ----------------------- |
| **CLI installation** | Yes                 | Uninstalled | Archive artifacts       |
| **Configuration**    | Yes                 | Changed     | Version control         |
| **Mandates**         | Yes                 | Updated     | Content verification    |

### Retention Triggers

| Event                | FlowGuard Action      | Customer Action           |
| -------------------- | --------------------- | ------------------------- |
| **Session complete** | Preserves state       | Archive recommended       |
| **Session abort**    | Preserves state       | Archive for analysis      |
| **Workspace change** | Marks session invalid | Archive before change     |
| **Version upgrade**  | Installs new version  | Archive previous artifact |

---

## Archive Lifecycle

### Archive Creation

| Step | Command    | Description                    |
| ---- | ---------- | ------------------------------ |
| 1    | `/review`  | Verify session completeness    |
| 2    | `/archive` | Create `.tar.gz` with manifest |
| 3    | Verify     | Run integrity checks           |
| 4    | Store      | Move to archival storage       |

**Currently Delivered:**

- `verifyArchive()` with multi-check validation
- SHA-256 file hashes in manifest
- Content digest for complete archive

### Archive Contents

```
session-{sessionId}-{timestamp}.tar.gz
├── archive-manifest.json      # Session metadata, file inventory, digests
├── state.json                 # Final session state
├── audit.jsonl                # Complete audit trail
├── discovery.json             # Repository discovery snapshot
└── {evidence-files}...        # Tickets, plans, reviews
```

### Archive Verification

| Check                 | Purpose                    |
| --------------------- | -------------------------- |
| Manifest presence     | Archive is complete        |
| File completeness     | All expected files present |
| File digests          | Individual file integrity  |
| Content digest        | Overall archive integrity  |
| Discovery consistency | State linked to discovery  |
| State validity        | Session state is parseable |

**Currently Delivered:**

- Multi-check `verifyArchive()` function
- Structured finding codes for each check

---

## Recovery Procedures

### Session Recovery

| Scenario         | Recovery Method                 | Notes                       |
| ---------------- | ------------------------------- | --------------------------- |
| **State lost**   | Extract from archive            | Verify hash chain integrity |
| **Audit lost**   | Extract from archive            | Verify hash chain integrity |
| **Disk failure** | Fresh install + archive extract | Restore session files       |

**Procedure:**

1. Install FlowGuard on new machine
2. Extract archive: `tar -xzf session-{id}.tar.gz`
3. Verify archive integrity
4. Review state in OpenCode using `/review`

### Disaster Recovery

| Step | Action                                  | Owner         |
| ---- | --------------------------------------- | ------------- |
| 1    | Restore `.opencode/` directory          | Customer      |
| 2    | Verify installation: `flowguard doctor` | Customer      |
| 3    | Verify archives                         | Customer      |
| 4    | Archive incomplete sessions             | Session owner |

### Backup Recommendations

| Data                      | Frequency            | Method                     |
| ------------------------- | -------------------- | -------------------------- |
| **Active sessions**       | Daily or per session | Archive + external storage |
| **Archives**              | Weekly incremental   | External storage           |
| **Installation artifact** | Per version          | Artifact repository        |
| **Configuration**         | On change            | Version control            |

**Customer Responsibility:**

- Automated backup scheduling
- Off-site storage
- Backup encryption (if required)
- Restore testing

---

## Data Disposal

### Session Data Disposal

| Data                   | Disposal Method            | Notes                 |
| ---------------------- | -------------------------- | --------------------- |
| **Active session**     | Complete and archive first | Preserves evidence    |
| **Audit trail**        | Archive or delete          | Archive recommended   |
| **Discovery snapshot** | Archive or delete          | Archive recommended   |
| **Session files**      | Customer-managed           | Delete after archival |

### Installation Data Disposal

| Data              | Disposal Method                | Notes                                                                        |
| ----------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| **CLI**           | `flowguard uninstall`          | Removes installed files                                                      |
| **Configuration** | Delete workspace `config.json` | Must be re-materialized; doctor reports missing config as an integrity error |
| **Mandates**      | Overwritten on update          | Content-digested                                                             |

### Secure Disposal

**Customer Responsibility:**

- Secure deletion of session directories
- Archive encryption during storage
- Compliance with retention policies
- Audit trail for disposed data

---

## Retention Compliance

### Regulatory Considerations

| Requirement            | FlowGuard Capability | Customer Responsibility   |
| ---------------------- | -------------------- | ------------------------- |
| **Evidence retention** | Archive format       | Storage duration          |
| **Audit trail**        | Hash-chained JSONL   | Archival policy           |
| **Data minimization**  | Manual disposal      | Retention schedule        |
| **Right to erasure**   | Manual deletion      | Compliance implementation |

### Retention Schedule (Customer Responsibility)

| Data Type                  | Recommendation            | Notes                        |
| -------------------------- | ------------------------- | ---------------------------- |
| **Session archives**       | Per organizational policy | Regulatory requirements vary |
| **Audit trails**           | With archive              | Retained as part of archive  |
| **Configuration**          | Per version               | Version control recommended  |
| **Installation artifacts** | 2-3 versions              | For rollback capability      |

---

## Monitoring and Alerts

### Health Indicators

| Indicator                | Normal     | Action                |
| ------------------------ | ---------- | --------------------- |
| **Archive verification** | Pass       | None                  |
| **Archive verification** | Fail       | Investigate + restore |
| **Session state**        | Valid      | None                  |
| **Session state**        | Invalid    | Recover from archive  |
| **Disk space**           | > 10% free | Archive old sessions  |

### Audit Trail Health

| Check                | Frequency           | Owner              |
| -------------------- | ------------------- | ------------------ |
| Archive verification | On archive creation | Session owner      |
| Integrity spot-check | Monthly             | Installation owner |
| Full archive audit   | Quarterly           | Compliance team    |

---

_FlowGuard Version: 1.2.0-rc.1-rc.1_
_Last Updated: 2026-04-15_
