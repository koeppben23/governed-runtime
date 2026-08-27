# Archive

FlowGuard can archive completed sessions for audit and compliance purposes.

## Archive Process

When a session reaches COMPLETE phase, you can archive it:

```bash
/archive
```

## Archive Contents

Raw-evidence archives include:

- `state/session-state.json` — Complete canonical session state
- `audit/audit.jsonl` — Complete hash-chained audit trail
- `audit/decision-receipts.v1.json` — Decision receipt projection
- `context/discovery-snapshot.json` — Repository discovery snapshot
- `context/profile-resolution-snapshot.json` — Profile resolution snapshot
- `artifacts/ticket/`, `artifacts/plan/`, and `artifacts/reviews/` — Evidence artifacts
- `reports/review-report.json` — Standalone review report when present
- `implementation/implementation-diff.<digest>.patch` — Implementation patch when present

Redacted sharing archives instead contain redacted state, audit, receipt, and
review-report projections where available. They intentionally omit the canonical
state and audit-chain files listed above.

FlowGuard fail-closes archive creation when `session-state.json` contains ticket/plan evidence but required derived artifacts under `artifacts/` are missing, malformed, or digest/hash-inconsistent with current ticket/plan evidence.

Archive Layout v2 supports two distinct export purposes. The default is a
redacted sharing archive (`basic`, `includeRaw=false`). Its result reports
`packagePurpose: sharing`, `integrityCapability: not_verifiable`, and
`verificationStatus: not_run`: redaction excludes the canonical state and audit
chain that full evidence verification requires. It remains suitable for
controlled sharing, but is not an audit substitute.

For complete auditor evidence, authorize raw export with
`archive.redaction.allowRawExport=true` and explicitly export with
`redactionMode=none, includeRaw=true`. That package contains unredacted evidence,
reports `packagePurpose: auditor` and `integrityCapability: verifiable`, and
reports `verificationStatus: passed` or `failed` after verification. It must be
stored and transferred as confidential material.

Regulated clean completion is a separate system-owned path: it always creates
and verifies its mandatory local raw-evidence archive, regardless of the manual
sharing-export permission. The permission governs user-requested raw exports.

## Archive Location

Archives are stored at:

```
~/.config/opencode/workspaces/{fingerprint}/sessions/archive/{sessionId}.tar.gz
```

The mandatory regulated raw-evidence package is stored separately as
`regulated-{sessionId}.tar.gz`, so a later sharing export cannot replace it.

### Configuration Scope

Archive creation calls `readConfig()` without a worktree argument intentionally.
The originating worktree may no longer exist at archive time. Archive
configuration uses global config or default config. Repo config overrides do not
apply to archives unless a future policy-snapshot change is introduced.

## Manifest

Each archive includes an `archive-manifest.json`:

```json
{
  "schemaVersion": "archive-manifest.v2",
  "layoutVersion": 2,
  "createdAt": "2026-04-15T10:00:00.000Z",
  "sessionId": "uuid",
  "fingerprint": "abc123...",
  "policyMode": "regulated",
  "profileId": "typescript",
  "discoveryDigest": "sha256...",
  "auditChainHead": "sha256...",
  "auditEventCount": 12,
  "rawIncluded": true,
  "riskFlags": ["raw_audit_evidence_export"],
  "includedFiles": ["state/session-state.json", "audit/audit.jsonl"],
  "fileDigests": {
    "state/session-state.json": "sha256...",
    "audit/audit.jsonl": "sha256..."
  },
  "contentDigest": "sha256..."
}
```

### Manifest schema versions

`archive-manifest.v2` is a **breaking** schema with **no legacy compatibility
path**. v1 archives are hard-rejected at verification: the `v1` schema version
fails `ArchiveManifestSchema` validation and surfaces as `manifest_parse_error`
(fail-closed). There is no in-place upgrade — a v1 archive must be re-sealed by
re-running archive creation against its source session.

The v2 changes are integrity-driven:

- `auditChainHead` / `auditEventCount` — audit trail completeness anchor (see
  [Integrity Chain](#integrity-chain)).
- `policyMode`, `auditChainHead`, `auditEventCount`, `schemaVersion`,
  `sessionId`, `fingerprint`, and `discoveryDigest` are now **folded into
  `contentDigest`**, so they can no longer be mutated without invalidating the
  digest.

## Verification

FlowGuard provides `verifyArchive()` to validate archive integrity.

### Finding Codes

| Code                             | Description                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `missing_manifest`               | Archive manifest not found                                                                          |
| `manifest_parse_error`           | Manifest is malformed                                                                               |
| `missing_file`                   | File listed in manifest missing                                                                     |
| `unexpected_file`                | File not listed in manifest                                                                         |
| `file_digest_mismatch`           | File hash doesn't match manifest                                                                    |
| `content_digest_mismatch`        | Content hash incorrect                                                                              |
| `manifest_policy_mode_mismatch`  | `manifest.policyMode` disagrees with the integrity-covered governed state mode (strict-mode tamper) |
| `audit_chain_truncated`          | Actual audit head/count disagrees with the manifest completeness anchor (tail truncation)           |
| `archive_checksum_missing`       | SHA256 sidecar not found                                                                            |
| `archive_checksum_mismatch`      | Archive hash doesn't match                                                                          |
| `audit_chain_invalid`            | Current-format v2 audit trail chain verification failed                                             |
| `audit_chain_legacy_format`      | Pre-v2 audit chain requires migration or explicit weak legacy verification                          |
| `audit_chain_unsupported_format` | Audit trail declares an unsupported audit chain format                                              |
| `state_missing`                  | Session state missing                                                                               |
| `snapshot_missing`               | Discovery snapshot missing                                                                          |

### Verification Example

```typescript
// Available after installation (see docs/installation.md)
import { verifyArchive } from '@flowguard/core';

const result = await verifyArchive('/path/to/archive.tar.gz');

if (result.passed) {
  console.log('Archive is valid');
} else {
  console.log('Findings:', result.findings);
}
```

## Regulated Archive Completion Semantics

In regulated mode (`policySnapshot.mode === 'regulated'`), clean completion
(`EVIDENCE_REVIEW → APPROVE → COMPLETE`) requires archive creation **and**
verification to succeed. The decision tool emits `session_completed` to the
audit trail **before** calling `archiveRegulatedEvidence()`, ensuring the archive
contains the terminal lifecycle event. The `regulatedArchiveStatus` field on
session state tracks the immutable regulated-evidence lifecycle:

| Status     | Meaning                                 |
| ---------- | --------------------------------------- |
| `pending`  | Archive creation in progress            |
| `created`  | Archive created, verification pending   |
| `verified` | Archive created and verification passed |
| `failed`   | Archive creation or verification failed |

**Invariant:** A regulated session with `phase === 'COMPLETE'` and
`regulatedArchiveStatus !== 'verified'` (and no `error`) is NOT a clean regulated
completion. Status/doctor tools should surface this as degraded.

**Manual exports** record their own semantics independently in
`lastExportPackagePurpose` (`sharing` or `auditor`),
`lastExportIntegrityCapability` (`verifiable` or `not_verifiable`), and
`lastExportVerificationStatus` (`not_run`, `passed`, or `failed`). They never
change `regulatedArchiveStatus`. `archiveStatus` remains a deprecated
compatibility mirror for the regulated lifecycle only. Solo sessions may use the
audit plugin's fire-and-forget archive path. Team sessions never archive on
completion: `/export` is the explicit archive action.

**Aborted sessions** (`error.code === 'ABORTED'`) do not trigger the regulated
archive lifecycle. Abort is an emergency escape with no archive guarantee.

**Checksum sidecar** (`.sha256`): In regulated mode, sidecar write failure is
fatal (`ARCHIVE_FAILED`). In non-regulated mode, sidecar failure is non-fatal
and the archive remains usable.

## Integrity Chain

Archives include tamper-evident features:

1. **File digests:** SHA-256 of each file
2. **Content digest:** SHA-256 binding both the sorted file digests **and** an
   integrity header of security-relevant manifest metadata (`schemaVersion`,
   `sessionId`, `fingerprint`, `policyMode`, `discoveryDigest`, `auditChainHead`,
   `auditEventCount`). The single canonical formula lives in
   `src/archive/content-digest.ts` and is shared by the builder and the verifier
   (no parallel digest authority). Mutating any covered field invalidates the
   digest and surfaces as `content_digest_mismatch`.
3. **Archive checksum:** SHA-256 of the tar.gz file

Modifying any archived file breaks the chain and is detectable.

### Strict-mode authority (SSOT)

Verification strictness is derived from the **integrity-covered**
`state.policySnapshot.mode`, never from the mutable `manifest.policyMode`. The
verifier cross-checks the two: a mismatch (for example flipping `regulated →
team` to weaken verification) is reported as `manifest_policy_mode_mismatch` and
fails closed. When the governed mode cannot be resolved from state
(missing/invalid `session-state.json`), verification **defaults to strict**
(fail-closed default-deny); a resolvable non-regulated mode is never escalated.

### Audit completeness anchor

A truncated audit trail is still a valid hash-chain _prefix_, so chain
verification alone cannot detect a removed tail. The manifest records
`auditChainHead` (last chain hash) and `auditEventCount` at archive time; the
verifier recomputes both from the archived `audit.jsonl` and reports
`audit_chain_truncated` on any mismatch. This is **defense-in-depth above**
`file_digest_mismatch` and the folded content digest — it does not replace them.

> **Residual risk (NOT a full mitigation):** the truncation anchor and digest
> coverage are keyless. An attacker who can rewrite `audit.jsonl` _and_ re-seal
> the manifest (recomputing every digest) can still produce an internally
> consistent archive. The cryptographic root of trust for that threat remains
> external timestamping (TSA / RFC 3161) in regulated mode. See
> [security-hardening.md](./security-hardening.md).
>
> **Timestamp verification trust (enforced):** when TSA evidence is present,
> archive verification enforces the RFC 3161 signer contract (exactly one,
> critical exclusive id-kp-timeStamping EKU; signed ESSCertID/ESSCertIDv2
> signer binding; independent SHA-256/384/512 algorithm allowlists; validated
> RSASSA-PSS parameters; unknown critical extensions reject; constant-time
> imprints), rejects downgraded timestamp statuses as
> `tsa_evidence_downgraded`, and derives timestamp-finding severity
> exclusively from the trusted policy state (`resolveStrictMode`) — the
> manifest policy mode is cross-checked, never a severity authority.

### Audit Chain Format

All audit records use `auditFormatVersion: "audit-chain.v3"` (the Assurance
epoch format). A v3 record carries a semantic content digest
(`semanticEventDigest`) separate from the position-bound record digest:
`chainHash = SHA-256("audit-chain.v3:" + prevHash + canonicalJson(recordWithoutChainHash))`,
where canonical JSON sorts object keys recursively at every nesting depth while
preserving array order. `auditSequence` is the sequence authority (assigned by
the append lock, never producer-supplied), `occurredAt` is the event occurrence
time, and `recordedAt` is stamped by the append authority. This binds nested
audit content such as decision details, actor metadata, timestamp evidence, and
enforcement metadata to the chain hash.

Records that omit `auditFormatVersion` or declare a pre-v3 format are rejected
with `LEGACY_ASSURANCE_FORMAT_UNSUPPORTED` at every persistence and
verification boundary. Legacy assurance artifacts are never migrated,
reinterpreted, or re-sealed: a trail containing them fails verification with
the `audit_chain_legacy_format` finding, not `audit_chain_invalid`, so operators
can distinguish unsupported epoch data from a tampered v3 chain. A time
regression between `occurredAt` values is reported as `CLOCK_ANOMALY`.

## Retention

Archives should be retained according to your compliance requirements:

- **Banks/Finance:** 7-10 years
- **Healthcare:** 6 years (HIPAA)
- **General:** As required by policy
