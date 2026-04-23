# DORA Compliance Mapping

How FlowGuard capabilities map to DORA (Digital Operational Resilience Act) by the European Union.

---

## Scope and Disclaimer

**DORA** (Regulation (EU) 2022/2554) is the EU regulation on digital operational resilience for the financial sector. It requires financial entities to manage ICT risks, report incidents, test resilience, and manage third-party risk.

**FlowGuard is not a compliance certification product.** It is a locally installed, self-hosted development workflow tool that provides building blocks for governance, audit trails, and approval workflows. FlowGuard alone does not satisfy any DORA requirement in full. Organizations must assess whether FlowGuard's capabilities, combined with their own policies, processes, and infrastructure, meet their specific compliance requirements.

**Reference:** [EUR-Lex — Regulation (EU) 2022/2554](https://eur-lex.europa.eu/eli/reg/2022/2554/oj)

---

## Mapping Summary

| DORA Chapter | Requirement Area                       | Relevance      | FlowGuard Contribution                         |
| ------------ | -------------------------------------- | -------------- | ---------------------------------------------- |
| Chapter I    | General Provisions                     | Partial        | Policy modes, governance framing               |
| Chapter II   | ICT Risk Management                    | **Direct**     | Structured change workflow, risk documentation |
| Chapter III  | ICT Incident Management                | Not Applicable | —                                              |
| Chapter IV   | Digital Operational Resilience Testing | Not Applicable | —                                              |
| Chapter V    | Third-Party ICT Risk                   | Partial        | Evidence of change intent and approval         |
| Chapter VI   | Information Sharing                    | Not Applicable | —                                              |
| Chapter VII  | Supervisory Powers                     | Not Applicable | —                                              |

---

## Detailed Mapping

### Chapter I — General Provisions

**Relevance: Partial**

DORA requires governance frameworks for ICT risk management.

#### FlowGuard Provides

- Policy modes: Solo, Team, Team-CI, Regulated
- Policy snapshot frozen at session creation
- Explicit governance rules documented

#### Organization Must Provide

- Enterprise ICT governance
- Board oversight
- Compliance framework alignment

---

### Chapter II — ICT Risk Management

**Relevance: Direct**

DORA Article 5-8 requires comprehensive ICT risk management frameworks.

#### FlowGuard Provides

**Risk Identification (Art. 5):**

- Ticket phase forces documentation of ICT change intent
- Plan phase requires risk considerations
- Validation phase checks rollback safety

**Risk Assessment (Art. 6):**

- Evidence-based workflow ensures documented assessment
- Plan evidence includes risk analysis
- Validation evidence shows risk mitigation

**Risk Treatment (Art. 7):**

- Phase gates enforce evidence requirements
- Rollback safety validation
- Implementation review loop

**Monitoring & Reporting (Art. 8):**

- Hash-chained audit trail provides traceable history
- Evidence completeness matrix
- Decision receipts for approvals

**Key Capabilities:**

| DORA Article                  | FlowGuard Capability                |
| ----------------------------- | ----------------------------------- |
| Art. 5(1) Risk identification | Ticket evidence (change intent)     |
| Art. 5(2) Risk analysis       | Plan evidence (risk considerations) |
| Art. 6(1) Assessment          | Validation phase (risk checks)      |
| Art. 7(1) Mitigation          | Rollback safety validation          |
| Art. 7(2) Controls            | Phase gates, human approval         |
| Art. 8(1) Monitoring          | Audit trail, phase status           |

---

### Chapter III — ICT Incident Management

**Relevance: Not Applicable**

FlowGuard is a development workflow tool, not an incident management system.

#### Organization Must Provide

- Incident response procedures
- ICT incident classification
- Major incident reporting to authorities
- Root cause analysis

---

### Chapter IV — Digital Operational Resilience Testing

**Relevance: Not Applicable**

FlowGuard is not a testing framework.

#### Organization Must Provide

- Penetration testing
- threat-led testing
- vulnerability assessments
- Disaster recovery tests

---

### Chapter V — Third-Party ICT Risk

**Relevance: Partial**

DORA requires managing third-party ICT risk (Art. 25-27).

#### FlowGuard Provides

- Evidence of change intent and approval (useful for third-party verification)
- Audit trail of decisions
- Configuration for vendor dependencies (FlowGuard uses minimal supply chain: Zod only)

#### Organization Must Provide

- Third-party risk assessments
- Vendor due diligence
- Contractual arrangements
- Oversight of third parties

---

### Chapter VI — Information Sharing

**Relevance: Not Applicable**

FlowGuard does not facilitate information sharing.

#### Organization Must Provide

- Threat intelligence sharing
- Industry collaborations
- Information sharing agreements

---

### Chapter VII — Supervisory Powers

**Relevance: Not Applicable**

FlowGuard is not a supervisory tool.

#### Organization Must Provide

- Supervisory reporting
- Inspection support
- Remediation plans

---

## DORA-Specific Workflow Mapping

FlowGuard's Ticket Flow maps to DORA requirements:

```
READY → TICKET (Art. 5: Risk Identification)
       → PLAN (Art. 6: Risk Assessment)
       → VALIDATION (Art. 7: Risk Mitigation)
       → IMPLEMENTATION (Art. 7: Controls)
       → IMPL_REVIEW (Quality Gate)
       → EVIDENCE_REVIEW (Art. 8: Monitoring)
       → COMPLETE (Audit Trail Ready)
```

| DORA Requirement         | FlowGuard Phase |
| ------------------------ | --------------- |
| Art. 5(1) Identification | TICKET          |
| Art. 6(1) Assessment     | PLAN            |
| Art. 7(1) Mitigation     | VALIDATION      |
| Art. 7(2) Controls       | IMPL_REVIEW     |
| Art. 8(1) Monitoring     | EVIDENCE_REVIEW |

---

## Enterprise Integration

FlowGuard integrates with DORA compliance programs through:

- **Evidence Artifacts**: Standalone files for each phase
- **Session Archives**: Complete evidence + audit trail export
- **Decision Receipts**: Immutable proof of approval decisions
- **Hash-Chained Audit Trail**: Tamper-evident record
- **Headless Mode**: Pipeline integration via OpenCode SDK

---

## DORA Key Capabilities Summary

| DORA Requirement                | FlowGuard Capability                      |
| ------------------------------- | ----------------------------------------- |
| Art. 5: ICT risk identification | Ticket evidence (documented intent)       |
| Art. 6: ICT risk assessment     | Plan evidence (risk analysis)             |
| Art. 7: Risk treatment          | Validation (rollback safety), Phase gates |
| Art. 7: Control measures        | Human approval at gates                   |
| Art. 8: Monitoring              | Hash-chained audit trail                  |
| Art. 25: Third-party risk       | Change documentation for vendor changes   |
| Art. 27: Oversight              | Decision receipts, evidence archives      |

---

_Last Updated: 2026-04-19_

_FlowGuard Version: 1.2.0-rc.1-rc.1_
