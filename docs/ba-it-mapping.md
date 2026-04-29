# BAIT Compliance Mapping

How FlowGuard capabilities map to BAIT (Bankenaufsichtliche Anforderungen an die IT) by the German Federal Financial Supervisory Authority (BaFin).

---

## Scope and Disclaimer

**BAIT** (Bankenaufsichtliche Anforderungen an die IT) defines IT security requirements for banks and financial institutions in Germany. It covers IT governance, IT risk management, information security, and IT operations.

**FlowGuard is not a compliance certification product.** It is a locally installed, self-hosted development workflow tool that provides building blocks for governance, audit trails, and approval workflows. FlowGuard alone does not satisfy any BAIT requirement in full. Organizations must assess whether FlowGuard's capabilities, combined with their own policies, processes, and infrastructure, meet their specific compliance requirements.

**Reference:** [BaFin — Bankenaufsichtliche Anforderungen an die IT (BAIT)](https://www.bafin.de/DE/Aufgaben/IT_Aufsicht/BAIT/BAITNode.html)

---

## Mapping Summary

| BAIT Section | Requirement Area       | Relevance      | FlowGuard Contribution                              |
| ------------ | ---------------------- | -------------- | --------------------------------------------------- |
| § 8          | IT Governance          | Partial        | Policy-bound execution, explicit workflow phases    |
| § 9          | IT Strategic Planning  | Partial        | Evidence-based workflow forces documentation        |
| § 10         | IT Risk Management     | **Direct**     | Structured change workflow, risk documentation      |
| § 11         | Information Security   | **Direct**     | Four-eyes principle, audit trail, approval workflow |
| § 12         | ABS                    | Not Applicable | —                                                   |
| § 13         | IT Operations          | Partial        | Local execution, no external communication          |
| § 14         | System Development     | **Direct**     | Structured dev workflow, validation gates           |
| § 15         | Outsourcing            | Not Applicable | —                                                   |
| § 16         | IT Incident Management | Not Applicable | —                                                   |
| § 17         | Contingency Planning   | Not Applicable | —                                                   |

---

## Detailed Mapping

### § 8 — IT Governance

**Relevance: Partial**

BAIT § 8 requires establishing IT governance frameworks.

#### FlowGuard Provides

- Policy modes: Solo, Team, Team-CI, Regulated
- Configurable workflow enforcement per policy
- Phase-based governance with explicit evidence gates
- Policy snapshot frozen at session creation for audit

#### Organization Must Provide

- Enterprise IT governance policies
- Strategy alignment with FlowGuard usage
- Board-level oversight

---

### § 9 — IT Strategic Planning

**Relevance: Partial**

BAIT § 9 requires strategic IT planning including architecture and capacity.

#### FlowGuard Provides

- Architecture flow for ADR creation
- Discovery pipeline for repository analysis
- Evidence-based planning phase

#### Organization Must Provide

- Enterprise architecture standards
- Capacity planning processes
- Technology roadmap alignment

---

### § 10 — IT Risk Management (IT-Risikomanagement)

**Relevance: Direct**

BAIT § 10 requires systematic IT risk management.

#### FlowGuard Provides

**Risk Identification:**

- Ticket phase forces documentation of change intent
- Plan phase requires risk considerations
- Validation phase checks rollback safety (risk mitigation)

**Risk Documentation:**

- Ticket evidence: Documented task with business justification
- Plan evidence: Implementation plan with version history
- Validation evidence: Test quality + rollback safety assessment

**Risk Monitoring:**

- Hash-chained audit trail provides traceable risk documentation
- Phase gates enforce evidence requirements

#### Organization Must Provide

- Enterprise risk appetite definitions
- Risk assessment methodologies
- Integration with GRC systems

---

### § 11 — Information Security (Informationssicherheit)

**Relevance: Direct**

BAIT § 11 requires information security management.

#### FlowGuard Provides

**Access Control:**

- Four-eyes principle in regulated mode
- Actor classification (`human` vs. `system`)
- Session binding to filesystem workspace

**Approval Workflow:**

- Human gates at PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW
- Review decision with rationale
- Decision receipts with actor identity

**Audit Trail:**

- Hash-chained audit trail
- SHA-256 hash chain for tamper evidence
- Structured event kinds (transition, tool_call, error, lifecycle, decision)

**Change Management:**

- Explicit change workflow with evidence gates
- Backward transitions on rejection
- Complete evidence chain

#### Organization Must Provide

- Information security policies
- Security awareness training
- Penetration testing
- Vulnerability management

---

### § 13 — IT Operations

**Relevance: Partial**

BAIT § 13 requires IT operations management.

#### FlowGuard Provides

- Self-hosted execution — no outbound network calls
- Local filesystem storage of all data
- Offline-capable operation

#### Organization Must Provide

- Infrastructure operations
- Monitoring and alerting
- Capacity management

---

### § 14 — System Development (Systementwicklung)

**Relevance: Direct**

BAIT § 14 requires structured system development processes.

#### FlowGuard Provides

**Development Workflow:**

- 14 explicit phases across 3 flows
- Ticket → Plan → Validation → Implementation → IMPL_REVIEW → EVIDENCE_REVIEW → Complete
- Phase gates require evidence before progression

**Testing & Quality:**

- Validation phase requires test quality checks
- Rollback safety validation before implementation
- Implementation review loop

**Documentation:**

- Complete evidence chain (ticket, plan, validation, implementation)
- Versioned plan history
- Decision receipts

**Approval:**

- Human gates at critical points
- Four-eyes principle enforcement in regulated mode
- Review decisions with rationale

**Release Management:**

- Version-controlled artifact generation
- Session archives with integrity verification
- Decision receipts for audit

#### Organization Must Provide

- Testing strategies
- Performance testing
- Security testing (penetration testing)
- Acceptance criteria
- Release management processes

---

## Enterprise Integration

FlowGuard integrates with BAIT compliance programs through:

- **Evidence Artifacts**: Standalone files for each phase
- **Session Archives**: Complete evidence + audit trail export
- **Decision Receipts**: Immutable proof of approvals
- **Policy Snapshots**: Immutable proof of governance rules
- **Headless Mode**: Pipeline integration via OpenCode SDK

---

## BAIT-Specific Capabilities

| BAIT Requirement            | FlowGuard Capability                         |
| --------------------------- | -------------------------------------------- |
| § 10(3) Risk documentation  | Ticket + Plan evidence                       |
| § 11(2) Authorization       | Four-eyes principle (regulated mode)         |
| § 11(5) Dual control        | Review decisions with human gates            |
| § 14(2) Development process | Structured 8-phase workflow                  |
| § 14(3) Testing             | Validation phase (test quality)              |
| § 14(4) Changes             | Versioned plan history, backward transitions |
| § 14(5) Approval            | Decision receipts                            |

---

_Last Updated: 2026-04-19_

FlowGuard Version: 1.2.0-rc.1
