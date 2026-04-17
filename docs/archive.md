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
- `decision-receipts.v1.json` — Structured receipts derived from `decision:DEC-xxx` audit events
- `review-report.json` — Final review report
- `discovery-snapshot.json` — Repository discovery snapshot
- `profile-resolution-snapshot.json` — Profile resolution snapshot

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
  "includedFiles": ["session-state.json", "audit.jsonl"],
  "fileDigests": {
    "session-state.json": "sha256...",
    "audit.jsonl": "sha256..."
  },
  "contentDigest": "sha256..."
}
```

## Verification

FlowGuard provides `verifyArchive()` to validate archive integrity.

### Finding Codes

| Code | Description |
|------|-------------|
| `missing_manifest` | Archive manifest not found |
| `manifest_parse_error` | Manifest is malformed |
| `missing_file` | File listed in manifest missing |
| `unexpected_file` | File not listed in manifest |
| `file_digest_mismatch` | File hash doesn't match manifest |
| `content_digest_mismatch` | Content hash incorrect |
| `archive_checksum_missing` | SHA256 sidecar not found |
| `archive_checksum_mismatch` | Archive hash doesn't match |
| `state_missing` | Session state missing |
| `snapshot_missing` | Discovery snapshot missing |

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
