# Upgrade and Rollback

This document describes how to upgrade FlowGuard and how to rollback to a previous version.

---

## Overview

FlowGuard uses a pre-built proprietary distribution model. Upgrades involve downloading a new release artifact and reinstalling.

---

## Delivery Scope

| Category                    | Description                  | Example                                                |
| --------------------------- | ---------------------------- | ------------------------------------------------------ |
| **Technically Enforced**    | Guarantees by implementation | Zod validation, hash chain                             |
| **Currently Delivered**     | Available in current release | CLI install, uninstall, doctor                         |
| **Optional**                | Can be configured            | Version pinning                                        |
| **Not Covered**             | Intentionally not provided   | Automated upgrades, rollback automation                |
| **Customer Responsibility** | External to FlowGuard        | Artifact archival, testing, compatibility verification |

---

## Upgrade Procedure

### Standard Upgrade

```bash
# 1. Download new release artifact from your approved release source
#    (e.g., GitHub Releases, internal artifact store)

# 2. Verify checksum manually, or keep checksums.sha256 next to the tarball so
#    flowguard install verifies it by default
sha256sum -c checksums.sha256

# 3. Reinstall with new artifact
flowguard install --core-tarball ./flowguard-core-{new}.tgz --force

# 4. Verify installation
flowguard doctor
```

### Upgrade with Project Installation

```bash
# In repository directory
cd /path/to/repository
flowguard install --core-tarball ./flowguard-core-{new}.tgz --install-scope repo --force
```

If the checksum file is not adjacent to the tarball, pass it explicitly with
`--checksums-file <path>`. Missing or mismatched checksum evidence blocks the
upgrade before managed artifacts are written.

### What Gets Updated

| Component         | Updated | Notes                       |
| ----------------- | ------- | --------------------------- |
| **CLI binary**    | Yes     | New `flowguard` command     |
| **Core package**  | Yes     | Via vendor tarball          |
| **Tools**         | Yes     | Re-installed from new core  |
| **Commands**      | Yes     | Updated prompts             |
| **Plugin**        | Yes     | Updated audit hook          |
| **Mandates**      | Yes     | Content-digested, versioned |
| **Configuration** | No      | Preserved                   |

### What Is Preserved

| Component         | Preserved | Notes                                         |
| ----------------- | --------- | --------------------------------------------- |
| **Session state** | Yes       | File-based; compatibility is release-specific |
| **Audit trails**  | Yes       | File-based                                    |
| **Archives**      | Yes       | File-based                                    |
| **Configuration** | Yes       | `flowguard.json` unchanged                    |

**Customer Responsibility:**

- Archive active sessions before upgrade
- Verify archives after upgrade
- Test upgrade in non-production

---

## Version Compatibility

### State Schema Compatibility

FlowGuard is a prerelease product. The persisted session-state schema is the
Assurance epoch `schemaVersion: 'v2'` and audit records are strictly
`audit-chain.v3`. Pre-v2 state is **hard-rejected** with
`SESSION_STATE_INCOMPATIBLE` at the `readState` preflight, and pre-v3 audit
records are rejected with `LEGACY_ASSURANCE_FORMAT_UNSUPPORTED` at every
audit persistence and verification boundary — legacy artifacts are never
migrated, reinterpreted, or re-sealed. Archive or complete active sessions
before crossing the epoch boundary. See
[`docs/architecture/schema-migration.md`](./architecture/schema-migration.md)
for the superseded migration proposal.

| From Version                                                                 | To Version                                | Compatibility                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any prerelease                                                               | Later prerelease                          | No forward-compatibility guarantee. Archive or complete active sessions before upgrading.                                                                                                 |
| Pre-Assurance-epoch sessions (`schemaVersion: v1`, `audit-chain.v2`/earlier) | Assurance epoch (`v2` / `audit-chain.v3`) | Incompatible by design. State rejected with `SESSION_STATE_INCOMPATIBLE` (audit records with `LEGACY_ASSURANCE_FORMAT_UNSUPPORTED`); no migration or re-seal path. Start a fresh session. |
| `v1.2.0-tp.2` and earlier unversioned policy digests                         | A release requiring `policy-digest.v2`    | Incompatible by design. The old digest did not bind nested policy fields; archive or complete the session with the old artifact, then start a new session.                                |

**FlowGuard validates state on read.** A release that requires an incompatible
schema or evidence contract rejects the state at hydrate time with an explicit
BLOCKED `SCHEMA_VALIDATION_FAILED` (or `SESSION_STATE_INCOMPATIBLE` at the
`readState` contract preflight for pre-v2 state).
Do not edit persisted state to bridge that boundary. Use the previously
installed artifact to archive or complete the session, then start a fresh
session after upgrading.

**Customer Responsibility:**

- Complete or archive every active session with the currently installed artifact
  before upgrading
- Test upgrade in non-production
- Treat every changed schema or required evidence contract as breaking —
  the Assurance epoch replaces migration with hard rejection
  (`docs/architecture/schema-migration.md`)

### Reviewer Mandate Compatibility

Reviewer obligations bind both `criteriaVersion` and the reviewer-mandate digest. The
`p38-v1` mandate requires `changes_requested` whenever `blockingIssues` is non-empty.
The `p39-v1` mandate makes the reviewer tool-capability profile part of the attested
contract by denying direct and MCP-prefixed `flowguard_*` tools while preserving
read-only research tools. The `p40-v1` mandate additionally denies the reviewer's
`task` capability, preventing subagent cascades. Each version has its own digest.

Existing obligations remain bound to their persisted `p38-v1` or `p39-v1` criteria and
digest and are never reinterpreted as `p40-v1` evidence. Archive or complete an
in-flight review before upgrading when its attestation must remain reproducible; create
a new artifact review cycle to use p40. Rolling back to a p39 build likewise requires a
new review cycle for any p40-bound obligation. Do not edit obligation attestation values
or mandate digests to bridge the version boundary.

### Archive Compatibility

Archives are tar.gz files containing structured JSON. Archive readability depends on the archive format used by each version.

**Customer Responsibility:**

- Verify archive readability after upgrade
- Maintain archives in accessible storage

---

## Rollback Procedure

### Standard Rollback

```bash
# 1. Ensure previous artifact is available
ls -la vendor/flowguard-core-{old}.tgz

# 2. If not available, obtain from backup or approved release source

# 3. Rollback installation
flowguard install --core-tarball ./flowguard-core-{old}.tgz --force

# 4. Verify
flowguard doctor
```

Rollback requires checksum evidence for the previous tarball as well. Keep the
matching `checksums.sha256` beside the rollback tarball or pass
`--checksums-file <path>`.

### Rollback Verification

```bash
# Verify installation (also reports the installed version in its banner)
flowguard doctor --install-scope global

# Or read the shipped VERSION file directly
cat "$(npm root -g)/@flowguard/core/VERSION"
```

---

## Artifact Management

### Artifact Archival

**Customer Responsibility:**

| Action                       | Frequency   | Storage                 |
| ---------------------------- | ----------- | ----------------------- |
| **Download artifacts**       | On release  | Internal artifact store |
| **Verify checksums**         | On download | Before use              |
| **Maintain rollback copies** | Continuous  | Last 2-3 versions       |

### Artifact Storage Recommendations

Maintain at least the current and previous two release tarballs alongside their
checksums:

```
/artifact-store/
├── flowguard-core-1.2.0-tp.2.tgz   (current)
├── flowguard-core-1.2.0-tp.2.tgz   (previous)
├── flowguard-core-1.2.0-tp.2.tgz        (rollback target)
└── checksums.sha256
```

---

## Upgrade Testing

### Pre-Upgrade Checklist

| Step | Action                  | Verified |
| ---- | ----------------------- | -------- |
| 1    | Archive active sessions | ☐        |
| 2    | Verify archives         | ☐        |
| 3    | Download new artifact   | ☐        |
| 4    | Verify checksum         | ☐        |
| 5    | Test in non-production  | ☐        |

### Non-Production Testing

```bash
# 1. Create test environment
mkdir /tmp/flowguard-test
cd /tmp/flowguard-test

# 2. Install new version (with matching checksums.sha256 beside the tarball)
flowguard install --core-tarball /path/to/new/flowguard-core-{new}.tgz

# 3. Test installation
flowguard doctor

# 4. Clean up
cd /tmp && rm -rf flowguard-test
```

### Post-Upgrade Verification

```bash
# 1. Verify installation (the doctor banner reports the installed version)
flowguard doctor --install-scope global

# 2. (Optional) Read the shipped VERSION file directly
cat "$(npm root -g)/@flowguard/core/VERSION"
```

---

## Session State During Upgrade

Sessions in progress are stored as files in `.opencode/`. Upgrading FlowGuard reinstalls the CLI and core package but does not modify existing session files.

**Customer Responsibility:**

- Complete or archive sessions before every prerelease upgrade
- Verify archives after upgrade; do not expect an active pre-upgrade session to
  remain readable

---

## Troubleshooting

### Upgrade Fails

| Error               | Cause              | Solution                    |
| ------------------- | ------------------ | --------------------------- |
| `tarball not found` | Wrong path         | Verify path to artifact     |
| `checksum mismatch` | Corrupt download   | Re-download, verify         |
| `install failed`    | Permission issue   | Check directory permissions |
| `doctor fails`      | Incomplete install | Re-run install with --force |

### Rollback Fails

| Error                | Cause            | Solution                     |
| -------------------- | ---------------- | ---------------------------- |
| `artifact not found` | No rollback copy | Obtain from backups/releases |
| `doctor fails`       | Partial rollback | Re-run install               |

---

FlowGuard Version: 1.2.0-tp.2
_Last Updated: 2026-08-25_
