# Archive

FlowGuard can archive completed sessions for audit and compliance purposes.

## Archive Process

When a session reaches COMPLETE phase, you can archive it:

```bash
/archive
```

## Archive Contents

An archive includes:

- `state/session-state.json` — Complete canonical session state
- `audit/audit.jsonl` — Complete hash-chained audit trail
- `audit/decision-receipts.v1.json` — Decision receipt projection
- `context/discovery-snapshot.json` — Repository discovery snapshot
- `context/profile-resolution-snapshot.json` — Profile resolution snapshot
- `artifacts/ticket/`, `artifacts/plan/`, and `artifacts/reviews/` — Evidence artifacts
- `reports/review-report.json` — Standalone review report when present
- `implementation/implementation-diff.<digest>.patch` — Implementation patch when present

FlowGuard fail-closes archive creation when `session-state.json` contains ticket/plan evidence but required derived artifacts under `artifacts/` are missing, malformed, or digest/hash-inconsistent with current ticket/plan evidence.

Archive Layout v2 is a complete, raw evidence package for authorized auditors. It
does not apply redaction or encryption. Store and transfer it as confidential
material. A future redacted sharing export is a separate product surface and is
not an audit substitute.

Archive Layout v2 requires `archive.redaction.mode=none` and
`archive.redaction.includeRaw=true`. These are the defaults. Legacy redaction
settings (`basic`, `strict`, or `includeRaw=false`) fail archive creation; migrate
the configuration before exporting.

## Archive Location

Archives are stored at:

```
~/.config/opencode/workspaces/{fingerprint}/sessions/archive/{sessionId}.tar.gz
```

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
audit trail **before** calling `archiveSession()`, ensuring the archive
contains the terminal lifecycle event. The `archiveStatus` field on session
state tracks the archive lifecycle:

| Status     | Meaning                                 |
| ---------- | --------------------------------------- |
| `pending`  | Archive creation in progress            |
| `created`  | Archive created, verification pending   |
| `verified` | Archive created and verification passed |
| `failed`   | Archive creation or verification failed |

**Invariant:** A regulated session with `phase === 'COMPLETE'` and
`archiveStatus !== 'verified'` (and no `error`) is NOT a clean regulated
completion. Status/doctor tools should surface this as degraded.

**Non-regulated sessions** (solo, team) do not set `archiveStatus`. Archive
creation is fire-and-forget via the audit plugin — existing behavior preserved.

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

### Audit Chain Format

Current audit events use `auditFormatVersion: "audit-chain.v2"`.
The v2 chain hash is `SHA-256(prevHash + canonicalJson(eventWithoutChainHash))`,
where canonical JSON sorts object keys recursively at every nesting depth while
preserving array order. This binds nested audit content such as decision details,
actor metadata, timestamp evidence, and enforcement metadata to the chain hash.

Pre-v2 chained audit events either omit `auditFormatVersion` or declare
`audit-chain.v1`. These events are not verified under the v2 tamper-evidence
guarantee because the historical chain serializer did not bind nested content.
Current verification reports them as `audit_chain_legacy_format`, not as
`audit_chain_invalid`, so operators can distinguish old-format evidence from a
tampered v2 chain.

Recovery for legacy/pre-v2 archives:

1. Treat the archive as reduced-assurance legacy evidence until migration is complete.
2. If operational policy allows it, re-verify with an explicit weak legacy verifier and re-seal under v2.
3. Otherwise retain the archive with the `audit_chain_legacy_format` finding documented in the evidence record.

Unknown audit chain formats are reported as `audit_chain_unsupported_format` and
must be handled by a runtime that explicitly supports that format. The default
verifier does not silently fall back to legacy hashing.

## Retention

Archives should be retained according to your compliance requirements:

- **Banks/Finance:** 7-10 years
- **Healthcare:** 6 years (HIPAA)
- **General:** As required by policy
