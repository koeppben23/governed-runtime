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

# 2. Verify checksum
sha256sum flowguard-core-{new}.tgz

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

| Component         | Preserved | Notes                                |
| ----------------- | --------- | ------------------------------------ |
| **Session state** | Yes       | File-based, readable after reinstall |
| **Audit trails**  | Yes       | File-based                           |
| **Archives**      | Yes       | File-based                           |
| **Configuration** | Yes       | Workspace `config.json` unchanged    |

**Customer Responsibility:**

- Archive active sessions before upgrade
- Verify archives after upgrade
- Test upgrade in non-production

---

## Version Compatibility

### State Schema Compatibility

| From Version | To Version | Recommendation                           |
| ------------ | ---------- | ---------------------------------------- |
| 1.x          | 1.y        | Test before production use               |
| 1.x          | 2.0        | Check release notes for breaking changes |

**FlowGuard validates state on read.** If a version change introduces incompatible state format, FlowGuard will reject the state and block operations.

**Customer Responsibility:**

- Test upgrade in non-production
- Archive sessions before upgrading
- Verify state readability after upgrade

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

### Rollback Verification

```bash
# Check version
flowguard --version

# Verify installation
flowguard doctor
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

```
/artifact-store/
├── flowguard-core-1.2.0-rc.1.tgz
├── flowguard-core-1.2.0-rc.1.tgz
├── flowguard-core-1.2.0-rc.1.tgz
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

# 2. Install new version
flowguard install --core-tarball /path/to/new/flowguard-core-{new}.tgz

# 3. Test installation
flowguard doctor

# 4. Clean up
cd /tmp && rm -rf flowguard-test
```

### Post-Upgrade Verification

```bash
# 1. Verify CLI version
flowguard --version

# 2. Verify installation
flowguard doctor
```

---

## Session State During Upgrade

Sessions in progress are stored as files in `.opencode/`. Upgrading FlowGuard reinstalls the CLI and core package but does not modify existing session files.

**Customer Responsibility:**

- Complete or archive sessions before major upgrades
- Verify session state is readable after upgrade

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

_FlowGuard Version: 1.2.0-rc.1_
_Last Updated: 2026-04-15_
