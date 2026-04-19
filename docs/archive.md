# Archive

FlowGuard can archive completed sessions for audit and compliance purposes.

## Archive Process

When a session reaches COMPLETE phase, you can archive it:

```bash
/archive
```

## Archive Contents

An archive includes:

- `session-state.json` — Complete session state
- `audit.jsonl` — Audit trail (if enabled)
- `decision-receipts.redacted.v1.json` — Redacted decision receipts export artifact
- `review-report.redacted.json` — Redacted review report export artifact (when review report exists)
- `discovery-snapshot.json` — Repository discovery snapshot
- `profile-resolution-snapshot.json` — Profile resolution snapshot
- `artifacts/ticket.v*.md` + `artifacts/ticket.v*.json` — Append-only ticket evidence artifacts
- `artifacts/plan.v*.md` + `artifacts/plan.v*.json` — Append-only plan evidence artifacts

By default (`archive.redaction.mode=basic`, `includeRaw=false`), raw decision receipts and raw review report are excluded from archives.

FlowGuard fail-closes archive creation when `session-state.json` contains ticket/plan evidence but required derived artifacts under `artifacts/` are missing, malformed, or digest/hash-inconsistent with current ticket/plan evidence.

**Redaction scope:** Redaction is applied only to export artifacts (`decision-receipts.*.json`, `review-report.*.json`). The following artifacts are **always included as raw** and are **never redacted**:

- `session-state.json` — raw session state (internal SSOT)
- `audit.jsonl` — raw append-only audit chain (integrity chain artifact)

Raw runtime and audit state is preserved internally; redaction is applied only to export artifacts according to the configured archive policy.

## Archive Location

Archives are stored at:

```
~/.config/opencode/workspaces/{fingerprint}/sessions/archive/{sessionId}.tar.gz
```

## Manifest

Each archive includes an `archive-manifest.json`:

```json
{
  "schemaVersion": "archive-manifest.v1",
  "createdAt": "2026-04-15T10:00:00.000Z",
  "sessionId": "uuid",
  "fingerprint": "abc123...",
  "policyMode": "regulated",
  "profileId": "typescript",
  "discoveryDigest": "sha256...",
  "redactionMode": "basic",
  "rawIncluded": false,
  "redactedArtifacts": [
    "decision-receipts.redacted.v1.json",
    "review-report.redacted.json"
  ],
  "excludedFiles": ["decision-receipts.v1.json", "review-report.json"],
  "riskFlags": [],
  "includedFiles": ["session-state.json", "audit.jsonl"],
  "fileDigests": {
    "session-state.json": "sha256...",
    "audit.jsonl": "sha256..."
  },
  "contentDigest": "sha256..."
}
```

If `includeRaw=true`, `riskFlags` includes `raw_export_enabled`.

## Verification

FlowGuard provides `verifyArchive()` to validate archive integrity.

### Finding Codes

| Code                        | Description                      |
| --------------------------- | -------------------------------- |
| `missing_manifest`          | Archive manifest not found       |
| `manifest_parse_error`      | Manifest is malformed            |
| `missing_file`              | File listed in manifest missing  |
| `unexpected_file`           | File not listed in manifest      |
| `file_digest_mismatch`      | File hash doesn't match manifest |
| `content_digest_mismatch`   | Content hash incorrect           |
| `archive_checksum_missing`  | SHA256 sidecar not found         |
| `archive_checksum_mismatch` | Archive hash doesn't match       |
| `state_missing`             | Session state missing            |
| `snapshot_missing`          | Discovery snapshot missing       |

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

## Integrity Chain

Archives include tamper-evident features:

1. **File digests:** SHA-256 of each file
2. **Content digest:** SHA-256 of all file digests
3. **Archive checksum:** SHA-256 of the tar.gz file

Modifying any archived file breaks the chain and is detectable.

## Retention

Archives should be retained according to your compliance requirements:

- **Banks/Finance:** 7-10 years
- **Healthcare:** 6 years (HIPAA)
- **General:** As required by policy
