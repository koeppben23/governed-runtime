# GoBD Compliance Mapping

How FlowGuard capabilities map to GoBD (Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung von Büchern, Aufzeichnungen und Unterlagen in elektronischer Form sowie zum Datenzugriff) by the German Federal Ministry of Finance.

---

## Scope and Disclaimer

**GoBD** (Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung von Büchern, Aufzeichnungen und Unterlagen in elektronischer Form sowie zum Datenzugriff) is the German principle for the proper keeping and storage of books, records, and documents in electronic form, as well as data access. It governs digital accounting systems and requires traceability, integrity, and auditability.

**FlowGuard is not a compliance certification product.** It is a locally installed, self-hosted development workflow tool that provides building blocks for governance, audit trails, and approval workflows. FlowGuard alone does not satisfy any GoBD requirement in full. Organizations must assess whether FlowGuard's capabilities, combined with their own policies, processes, and infrastructure, meet their specific compliance requirements.

GoBD primarily applies to **accounting-relevant systems**. FlowGuard contributes to software development processes that may touch such systems. The mapping below shows where FlowGuard can provide supporting controls.

**Reference:** [BMF — GoBD](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF/Sonstiges/GoBD.pdf)

---

## Mapping Summary

| GoBD Section | Requirement Area | Relevance      | FlowGuard Contribution                          |
| ------------ | ---------------- | -------------- | ----------------------------------------------- |
| § 2          | Completeness     | Partial        | Evidence workflow forces complete documentation |
| § 3          | Accuracy         | Not Applicable | —                                               |
| § 4          | Traceability     | **Direct**     | Hash-chained audit trail                        |
| § 5          | Original Form    | Partial        | Audit trail in original format (JSONL)          |
| § 6          | Unalterability   | **Direct**     | SHA-256 hash chain, append-only                 |
| § 7          | Clarity          | Partial        | Structured phase workflow                       |
| § 8          | Availability     | Partial        | Session archives with integrity                 |
| § 145/146    | Retention        | Partial        | Archive with retention metadata                 |

---

## Detailed Mapping

### § 2 — Completeness (Vollständigkeit)

**Relevance: Partial**

GoBD § 2 requires that all business transactions are completely recorded.

#### FlowGuard Provides

- Evidence-based workflow forces documentation of each change
- Ticket evidence: Every task is documented
- Plan evidence: Implementation plan with scope
- Validation evidence: Test coverage
- Implementation evidence: Executed changes
- No change can bypass required evidence phases

#### Organization Must Provide

- Integration with accounting systems
- Completeness verification procedures
- Reconciliation processes

---

### § 3 — Accuracy (Richtigkeit)

**Relevance: Not Applicable**

Accuracy of accounting data is outside FlowGuard's scope.

#### Organization Must Provide

- Data validation in source systems
- Reconciliation
- Error correction procedures

---

### § 4 — Traceability (Nachvollziehbarkeit)

**Relevance: Direct**

GoBD § 4 requires that every transaction can be traced back to its origin.

#### FlowGuard Provides

**Audit Trail:**

- Hash-chained audit trail: SHA-256 linked events
- Append-only JSONL format
- 5 event kinds: `transition`, `tool_call`, `error`, `lifecycle`, `decision`
- Each event includes timestamp, actor, phase

**Evidence Chain:**

- Ticket → Plan → Validation → Implementation → Review → Complete
- Each phase creates evidence
- Evidence linked through state

**Decision Receipts:**

- Immutable `decision:DEC-xxx` events
- Actor identity tracked
- Rationale recorded

#### Organization Must Provide

- Audit trail retention
- Access to historical data
- Auditor support

---

### § 5 — Original Form (Ordnungsgemäße Form)

**Relevance: Partial**

GoBD § 5 requires that data be stored in its original form.

#### FlowGuard Provides

- Audit trail in JSONL format (machine-readable, original)
- Session state in canonical JSON format
- Evidence artifacts in structured format
- No data transformation after recording

#### Organization Must Provide

- Original data format definitions
- Storage infrastructure
- Format migration procedures

---

### § 6 — Unalterability (Unveränderlichkeit)

**Relevance: Direct**

GoBD § 6 requires that recorded data cannot be altered unnoticed.

#### FlowGuard Provides

**Hash Chain:**

- SHA-256 linked events
- Each event includes hash of previous event
- Tamper-evident design
- Any alteration breaks chain

**Append-Only:**

- Audit trail is append-only
- No update or delete operations
- Session state uses atomic writes

**Integrity Verification:**

- Archive verification includes hash checks
- File digests in manifest
- SHA-256 checksums

| GoBD § 6 Requirement      | FlowGuard Capability |
| ------------------------- | -------------------- |
| No silent changes         | Hash chain           |
| No deletion               | Append-only          |
| Detection of manipulation | SHA-256 verification |

---

### § 7 — Clarity (Ordnlichkeit)

**Relevance: Partial**

GoBD § 7 requires that records be clear and understandable.

#### FlowGuard Provides

- Structured phase workflow
- Evidence artifacts with clear purpose
- Decision receipts with rationale
- Phase status in state

#### Organization Must Provide

- Clear naming conventions
- Documentation standards
- Training

---

### § 8 — Availability (Verfügbarkeit)

**Relevance: Partial**

GoBD § 8 requires that data be available within reasonable time.

#### FlowGuard Provides

- Session archives with complete evidence
- Structured archive format
- Fast retrieval from filesystem
- Retention metadata in archives

#### Organization Must Provide

- Storage infrastructure
- Backup procedures
- Recovery procedures

---

### § 145/146 — Retention (Aufbewahrungspflichten)

**Relevance: Partial**

GoBD § 145 (AO) and § 146 (HGB) define retention periods.

#### FlowGuard Provides

- Archive includes complete session state
- Retention can be based on session metadata
  -sha-256 hashes for integrity verification
- 10-year retention alignment through archives

#### Organization Must Provide

- Retention policies
- Secure storage
- Disposal procedures

---

## GoBD-Specific Capabilities

| GoBD Requirement     | FlowGuard Capability                |
| -------------------- | ----------------------------------- |
| § 2: Completeness    | Evidence phases force documentation |
| § 4: Traceability    | Hash-chained audit trail            |
| § 5: Original Form   | JSONL append-only format            |
| § 6: Unalterability  | SHA-256 hash chain                  |
| § 7: Clarity         | Structured phases, evidence         |
| § 8: Availability    | Session archives                    |
| § 145/146: Retention | Archive with metadata               |

---

## Workflow Integration

FlowGuard integrates with GoBD compliance through:

- **Audit Trail**: Complete, traceable, unalterable record
- **Evidence Artifacts**: Supporting documentation for changes
- **Decision Receipts**: Approval proof for auditors
- **Integrity Verification**: SHA-256 checksums
- **Archive Export**: Complete session for external review

For accounting-relevant software changes, FlowGuard provides the development controls that support GoBD compliance:

```
Change Request → Ticket (Document Intent)
             → Plan (Risk Assessment)
             → Validation (Testing Evidence)
             → Implementation (Code Changes)
             -> Review (Approval)
             → Archive (Retention-Ready)
```

---

## Limitations

FlowGuard does **not** provide:

- Direct accounting system integration
- Real-time transaction recording
- Financial data validation
- Tax calculation or compliance

These require specialized accounting/ERP systems.

---

_Last Updated: 2026-04-19_

_FlowGuard Version: 1.2.0-rc.1-rc.1_
