# MaRisk Compliance Mapping

How FlowGuard capabilities map to MaRisk (Mindestanforderungen an das Risikomanagement) by the German Federal Financial Supervisory Authority (BaFin).

---

## Scope and Disclaimer

**MaRisk** (Mindestanforderungen an das Risikomanagement) defines requirements for risk management in banks and financial institutions in Germany. It covers risk identification, measurement, controlling, monitoring, and reporting.

**FlowGuard is not a compliance certification product.** It is a locally installed, self-hosted development workflow tool that provides building blocks for governance, audit trails, and approval workflows. FlowGuard alone does not satisfy any MaRisk requirement in full. Organizations must assess whether FlowGuard's capabilities, combined with their own policies, processes, and infrastructure, meet their specific compliance requirements.

**Reference:** [BaFin — Mindestanforderungen an das Risikomanagement (MaRisk)](https://www.bafin.de/DE/Aufgaben/Risikomanagement/RisikomanagerNode.html)

---

## Mapping Summary

| MaRisk Module | Requirement Area                       | Relevance      | FlowGuard Contribution                                        |
| ------------- | -------------------------------------- | -------------- | ------------------------------------------------------------- |
| AT 7.2        | IT Security — Change Management        | **Direct**     | Structured change workflow, evidence gates, audit trail       |
| AT 7.3        | IT Security — Authorization Management | Partial        | Four-eyes principle (regulated mode), role separation         |
| AT 7.4        | IT Security — Access Control           | Partial        | Session binding to filesystem, local execution                |
| BT 1          | Risk Identification                    | Partial        | Evidence-based workflow forces documentation of change intent |
| BT 2          | Risk Measurement                       | Not Applicable | —                                                             |
| BT 3          | Risk Controlling                       | Partial        | Audit trail provides traceable decision history               |
| BT 4          | Risk Monitoring                        | Partial        | Hash-chained audit trail for monitoring                       |
| BT 5          | Risk Reporting                         | Partial        | Compliance summary generation, session archives               |
| BT 6          | Business Continuity                    | Not Applicable | —                                                             |

---

## Detailed Mapping

### AT 7.2 — IT Security: Change Management (Änderungsmanagement)

**Relevance: Direct**

MaRisk AT 7.2 requires documented change management processes for IT systems. This includes authorization, testing, and approval of changes.

#### FlowGuard Provides

**Change Enablement:**

- 14 explicit workflow phases across 3 flows with mandatory evidence gates
- Phase gates that require evidence before progression — no change can bypass required approvals
- Mandatory independent subagent review loop for plans (configurable iterations based on policy)
- Independent implementation review loop for code changes
- Validation checks (test quality, rollback safety) before implementation begins
- Backward transitions on rejection: `changes_requested` returns to authoring phase, `reject` returns to initial phases

**Documentation & Approval:**

- Ticket evidence: Every change starts with a documented task description
- Plan evidence: Implementation plan with version history
- Validation evidence: Test quality and rollback safety checks
- Implementation evidence: Evidence of executed changes
- Review decisions: Human approval/rejection with rationale
- Decision receipts: Immutable `decision:DEC-xxx` receipt events

**Audit Trail:**

- Hash-chained audit trail: SHA-256 linked events in JSONL append-only format
- Tamper-evident design: Each event's hash includes previous event's hash
- 5 structured event kinds: `transition`, `tool_call`, `error`, `lifecycle`, `decision`
- Policy snapshot: Immutable, SHA-256 hashed copy of active policy frozen at session creation
- Complete session archives with integrity verification

#### Organization Must Provide

- Organizational change management policies beyond FlowGuard sessions
- Integration with enterprise ticket systems (Jira, ServiceNow, etc.)
- Integration with external approval workflows
- Retention policies for audit data beyond session archives
- Backup and recovery procedures for FlowGuard session data

---

### AT 7.3 — IT Security: Authorization Management

**Relevance: Partial**

MaRisk AT 7.3 requires role-based authorization management.

#### FlowGuard Provides

- Four-eyes principle enforcement in regulated mode (initiator ≠ reviewer)
- Actor classification: `human` vs. `system` in policy
- Review decision receipts with actor identity

#### Organization Must Provide

- Enterprise identity management (LDAP, Active Directory)
- Role mapping to organizational functions
- Authorization for multi-user session access

---

### AT 7.4 — IT Security: Access Control

**Relevance: Partial**

MaRisk AT 7.4 requires access control for IT systems.

#### FlowGuard Provides

- Sessions bound to filesystem workspace and OpenCode session
- Self-hosted execution — no network access to external services
- Local filesystem permissions applied

#### Organization Must Provide

- Operating system-level access control
- Filesystem permission policies
- Multi-user coordination (sessions are single-user by design)

---

### BT 1 — Risk Identification

**Relevance: Partial**

MaRisk BT 1 requires identification of risks associated with changes.

#### FlowGuard Provides

- Ticket phase forces documentation of change intent (risk identification)
- Plan phase requires risk Considerations
- Validation phase checks rollback safety
- Evidence-based workflow creates traceable risk documentation

#### Organization Must Provide

- Formal risk assessment processes
- Risk categorization frameworks
- Risk appetite statements

---

### BT 3 — Risk Controlling / BT 4 — Risk Monitoring

**Relevance: Partial**

MaRisk BT 3-4 require controlling and monitoring of identified risks.

#### FlowGuard Provides

- Hash-chained audit trail provides traceable decision history
- Phase gates enforce evidence requirements
- Evidence completeness matrix shows required vs. provided evidence
- Compliance summary generation from audit trail

#### Organization Must Provide

- Integration with enterprise GRC (Governance, Risk, Compliance) systems
- Dashboard and reporting infrastructure
- Risk threshold definitions

---

### BT 5 — Risk Reporting

**Relevance: Partial**

MaRisk BT 5 requires reporting of risk status.

#### FlowGuard Provides

- Compliance summary generation: 7-check assessment
- Session archives with complete evidence
- Decision receipts for audit
- Hash-chained audit trail for reporting

#### Organization Must Provide

- Integration with enterprise reporting systems
- PDF report generation (manual artifact creation)
- Regulatory reporting templates

---

## Integration Points

FlowGuard integrates with enterprise compliance programs through:

- **Session Archives**: Export complete session state + audit trail for external review
- **Evidence Artifacts**: Standalone evidence files (ticket, plan, validation, implementation, review)
- **Decision Receipts**: Immutable proof of approval decisions
- **API Headless Mode**: Pipeline integration via OpenCode SDK (`POST /session/:id/command`)

---

_Last Updated: 2026-04-19_

FlowGuard Version: 1.2.0-rc.2
