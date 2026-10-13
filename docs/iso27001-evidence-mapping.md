# ISO/IEC 27001:2022 Evidence-to-Control Mapping

How FlowGuard session evidence can be associated with an organization's own
approved secure-development and change-management controls for **ISO/IEC
27001:2022, Annex A** — as a read-only projection, not a conformity verdict.

---

## Scope and Disclaimer

**ISO/IEC 27001:2022** is the international standard for information security
management systems (ISMS). Annex A lists controls; which controls are
applicable and how they are implemented remains an organizational decision
recorded in the Statement of Applicability (SoA) under **clause 6.1.3**. The
SoA may also contain organization-specific controls beyond Annex A.
**ISO/IEC 27002:2022** is additional implementation guidance — it is not the
same norm or edition, and nothing in this document treats it as normative.

FlowGuard provides a deterministic, read-only mapping from **verified archive
evidence of one session** to **organization-owned policy requirements** that
the organization maps to candidate Annex A controls. FlowGuard alone does not satisfy any
ISO/IEC 27001 control, is not an ISMS, does not decide SoA applicability, and
never issues a conformity, certification, or audit verdict.

**References:**
[ISO/IEC 27001:2022](https://www.iso.org/standard/27001) (ISO/IEC 27001:2022
clause 6.1.3 and Annex A).

### Reading This Document

- **Relevance** describes how directly FlowGuard evidence can contribute.
- **What FlowGuard Contributes** lists concrete, evidence-backed capabilities.
- **Organization Must Provide** lists responsibilities FlowGuard cannot
  address.

Relevance levels:

- **Direct** — FlowGuard produces the technical evidence that directly
  supports the mapping.
- **Partial** — FlowGuard contributes evidence to some aspects only.
- **Not Applicable** — outside FlowGuard's scope.

---

## Mapping Summary

| Annex A control | Name                                           | Relevance  | FlowGuard contribution                                        |
| --------------- | ---------------------------------------------- | ---------- | ------------------------------------------------------------- |
| A.8.15          | Logging (supplementary only)                   | Partial    | Tamper-evident audit chain with head/count anchor             |
| A.8.25          | Secure development life cycle                  | Partial    | Phase-gated workflow with evidence slots                      |
| A.8.26          | Application security requirements              | Partial    | Approved plan and policy-bound requirements as declared input |
| A.8.27          | Secure system architecture and engineering     | Partial    | Architecture decisions with review binding                    |
| A.8.28          | Secure coding                                  | Partial    | Implementation revision digest and risk assessment            |
| A.8.29          | Security testing in development and acceptance | **Direct** | Executed checks with structured, attempt-bound assertions     |
| A.8.32          | Change management                              | Partial    | Approved plan, revision binding, recorded human decisions     |

A control without a rule in the organization mapping is reported as
`NOT_MAPPED` — informational, not a gap statement. A control with an asserted
exclusion is reported with its assertion, and the rule remains `NOT_VERIFIED`
because v1 has no independently verified applicability source (there is no
`NOT_APPLICABLE_BY_SOA` output). The full candidate control set is closed and
edition-specific; unknown controls and unknown editions are rejected.

---

## Command

```bash
flowguard inspect --session <id> --iso27001-mapping ./iso27001-mapping.json
flowguard inspect --session <id> --iso27001-mapping ./iso27001-mapping.json --json
flowguard inspect --session <id> --iso27001-mapping ./iso27001-mapping.json --output ./iso27001-report.json
```

- The option is opt-in; ordinary `flowguard inspect` behavior is unchanged.
- `--output` writes a companion report to a **new** file (write-once, refuses
  overwrite) and refuses paths inside the FlowGuard config workspace.
- Exit codes: `0` — a report was produced (even when it lists missing
  evidence); `1` — invalid arguments, mapping, or output path; `2` — the
  immutable completion export is missing or failed verification.
- The immutable `export-<sessionId>.tar.gz` package (with its `.sha256`
  sidecar) is verified first; findings derive only from the verified snapshot.
- An offline recipient can re-run the existing offline verifier
  (`demos/java-task-manager/verify-evidence-package.mjs`) against the original
  package and compare its digest with `evidencePackage.packageSha256`.

### Mapping input (abridged)

```json
{
  "mappingSchemaVersion": "iso27001-evidence-mapping.v1",
  "framework": { "id": "ISO/IEC 27001:2022", "annex": "A" },
  "organizationId": "acme-secdev",
  "ismsScopeId": "isms-prod-2026",
  "mappingVersion": "1.0",
  "owner": "Secure Development Lead",
  "approval": {
    "reference": "ISMS-APPROVAL-2026-014",
    "approvedAt": "2026-01-15T10:00:00.000Z",
    "assertedBy": "CISO Office"
  },
  "soaRef": {
    "documentId": "soa-2026",
    "version": "2026.1",
    "status": "current"
  },
  "rules": [
    {
      "ruleId": "sec-testing",
      "controlRef": {
        "namespace": "iso27001:2022/annexA",
        "controlId": "A.8.29"
      },
      "policyRequirementId": "SDLC-SEC-TEST-01",
      "applicability": "asserted_applicable",
      "evidence": [
        { "kind": "validation.check_supported", "checkId": "test" },
        {
          "kind": "validation.assertion_passed",
          "checkId": "test",
          "assertion": {
            "providerId": "vitest",
            "localId": "auth.spec.ts::rejects-invalid-token"
          }
        }
      ]
    }
  ]
}
```

Approval metadata in the mapping is an **asserted, unsigned** statement of
organizational approval. It is reported as `asserted_unsigned` and never
presented as cryptographic authorization. Organization control ids live in a
separate `organization` namespace and are never conflated with Annex A ids.

### Report output (abridged, `--json`)

```json
{
  "reportSchemaVersion": "iso27001-evidence-report.v1",
  "framework": { "id": "ISO/IEC 27001:2022", "annex": "A" },
  "organization": { "mappingDigest": "<sha256>" },
  "soaVerification": "not_verified",
  "evidencePackage": {
    "sessionId": "<id>",
    "packageSha256": "<sha256>",
    "sidecarSha256": "<sha256>",
    "auditChainHead": "<hash>",
    "verification": "verified_snapshot"
  },
  "controls": [
    {
      "controlRef": {
        "namespace": "iso27001:2022/annexA",
        "controlId": "A.8.29"
      },
      "status": "EVIDENCE_LINKED_VERIFIED",
      "rules": [
        { "ruleId": "sec-testing", "status": "EVIDENCE_LINKED_VERIFIED" }
      ]
    }
  ],
  "reportDigest": "<sha256 over the semantic report>"
}
```

States per rule/control are limited to `EVIDENCE_LINKED_VERIFIED`,
`EVIDENCE_PRESENT_UNVERIFIED`, `EVIDENCE_MISSING`, `NOT_VERIFIED`, and
`NOT_MAPPED`. A verified association is evidence **toward** a control, not a
conformity conclusion. The machine never emits `ISO_COMPLIANT`,
`CONTROL_SATISFIED`, `CERTIFIED`, `AUDIT_PASSED`, percentages, or scores.

---

## Demonstration

A self-contained, self-checking offline demo runs the whole chain against a
built checkout — temporary foreign repository, synthetic session fixture,
canonical export and verification, and all three projection scenarios
(positive, missing/skipped assertion, tampered package):

```bash
npm run build
node demos/iso27001-evidence-mapping/run-demo.mjs
```

See [demos/iso27001-evidence-mapping/README.md](../demos/iso27001-evidence-mapping/README.md)
for the scenario table, exit codes, and the explicit statement that the
synthetic fixture demonstrates the tool chain, not production state security.

## Trust Boundary

- The **only** positive-evidence source is the raw completion export read from
  the same private snapshot the archive verifier checked. Live workspace files
  contribute only the explicitly labeled `export.completion` live binding and
  can never make another selector verified.
- A broken audit chain, tampered archive or sidecar, modified artifact, wrong
  session, redacted sharing archive, missing sidecar, or unverifiable export
  blocks the run (exit 2); no valid-looking report is produced.
- A missing or malformed sidecar is a hard block for this projection even where
  general archive verification is non-strict.
- Reports contain minimal identifiers and digests. They do not include raw
  transcripts, prompts, secrets, personal data, or absolute filesystem paths.
- Evidence references and escaped rendering are injection-safe; mapping values
  cannot inject Markdown structure, HTML, or terminal control sequences.

## Organization Must Provide

- The ISMS, risk treatment, and the Statement of Applicability, including
  applicability decisions under clause 6.1.3.
- The mapping itself, its approval, and the organization-authored policy
  requirements and their sufficiency.
- Independent assessment of control effectiveness across time, projects,
  staff, and production deployment.
- Semantic appropriateness of the tests the organization declares as security
  evidence.
- Retention, access control, and the trusted channel for package digests.

## What FlowGuard Does Not Attest

1. **Not a certification or conformity assessment.** A report is not an audit,
   attestation, or ISO/IEC 27001 conformity statement.
2. **Not an applicability decision.** Asserted applicability and asserted
   exclusions remain `not_verified`; no SoA decision is produced.
3. **Not organization-wide.** One verified export covers one session, one
   workspace revision, and the evidence the session recorded.
4. **Not proof of external authenticity.** The internal manifest is unsigned;
   package authenticity requires a trusted hash or signature delivered through
   an independent channel.
5. **Not a review-independence or policy-adequacy proof.** Identity fields are
   reported at their recorded assurance level and are never upgraded.
6. **Not a replacement for the organization's limits section.** Every report
   carries the full static limitation list; the referenced ownership entries
   (`#1078`, `#1079`, `#1080` resolved on this baseline; `#959` parked) are
   reported verbatim.

---

_Reference: ISO/IEC 27001:2022 — Information security, cybersecurity and
privacy protection — Information security management systems — Requirements_
FlowGuard Version: 2.0.0-tp.2
_Last Updated: 2026-10-13_
