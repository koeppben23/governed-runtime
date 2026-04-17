# Distribution Model

This document describes how FlowGuard is distributed, installed, and updated.

---

## Overview

FlowGuard uses **Option A1: Pre-built proprietary GitHub Release distribution** with installer-managed local runtime materialization and offline-resolvable file-based dependencies.

| Aspect                 | Value                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| **Distribution Model** | Pre-built npm pack output (`.tgz`)                                                               |
| **Artifact**           | `flowguard-core-{version}.tgz`                                                                   |
| **Acquisition**        | Operator downloads from approved release distribution point (GitHub Releases or internal mirror) |
| **Runtime Resolution** | Installer-managed local vendoring                                                                |
| **Offline Compatible** | Yes — all dependencies resolved locally                                                          |

---

## Delivery Scope

| Category                    | Description                             | Example                                               |
| --------------------------- | --------------------------------------- | ----------------------------------------------------- |
| **Technically Enforced**    | Properties guaranteed by implementation | Fail-closed, Hash-Chain integrity, Phase gates        |
| **Currently Delivered**     | Available in current release            | 14 phases (3 flows), 3 profiles, archive verification |
| **Optional**                | Can be enabled, not default             | Regulated mode, custom profiles                       |
| **Not Covered**             | Intentionally not implemented           | Multi-user, CI-native, compliance certification       |
| **Customer Responsibility** | Customer must handle                    | Backup, network segmentation, compliance mapping      |

Release publication is tag-driven (`v*`). If no release tag has been published yet, the GitHub Releases page can be empty for that snapshot.

---

## Artifact Contents

The `flowguard-core-{version}.tgz` contains:

| Component       | Description                                      |
| --------------- | ------------------------------------------------ |
| **CLI**         | `flowguard` command (install, uninstall, doctor) |
| **Core**        | State machine, rails, adapters, audit, config    |
| **Integration** | OpenCode tools, plugin, command prompts          |
| **Templates**   | Package.json, opencode.json, mandates            |

---

## Installation Flow

### 1. Download Artifact

```bash
# Download from your approved release source
#    (e.g., GitHub Releases, internal artifact store)

# Verify checksum
sha256sum flowguard-core-{version}.tgz
```

### 2. Install CLI

```bash
npm install -g ./flowguard-core-{version}.tgz
```

### 3. Initialize OpenCode Integration

```bash
flowguard install --core-tarball ./flowguard-core-{version}.tgz
```

The installer:

1. Creates `.opencode/` directory structure
2. Materializes the release artifact into `vendor/flowguard-core-{version}.tgz`
3. Writes `package.json` with `file:`-based dependency
4. Installs OpenCode tools, commands, and plugin
5. Creates `flowguard-mandates.md` with content digest

---

## Dependency Resolution

### file:-Based Dependencies

FlowGuard uses `file:`-based npm dependencies for offline resolution:

```json
{
  "dependencies": {
    "@flowguard/core": "file:./vendor/flowguard-core-1.0.0.tgz"
  }
}
```

**Installer-managed:** The installer writes a `file:` dependency. For A1 distribution, the operator downloads the artifact and provides it to the installer. Registry-based resolution is not supported in A1 mode.

### No Network Fetches at Runtime

After installation, FlowGuard requires **no outbound network connections**. All dependencies are resolved from the local `vendor/` directory.

---

## Upgrade & Rollback

### Upgrade

```bash
# Acquire the artifact from your organization's approved release distribution point.
# Verify the SHA-256 checksum against the published release record before installation.

# Reinstall with new tarball
flowguard install --core-tarball ./flowguard-core-{version}.tgz --force
```

### Rollback

```bash
# Reinstall with previous tarball
flowguard install --core-tarball ./flowguard-core-{old}.tgz --force
```

**Customer Responsibility:** Maintain archives of previous `flowguard-core-{version}.tgz` artifacts for rollback capability.

---

## Uninstall

To remove FlowGuard from an environment:

```bash
# Remove OpenCode integration
flowguard uninstall

# Remove CLI
npm uninstall -g @flowguard/core
```

The uninstall command removes all FlowGuard-owned files from `~/.config/opencode/` (or `./.opencode/` for repo scope) and cleans up the `opencode.json` instruction entries. `flowguard-mandates.md` is also removed. Your `AGENTS.md` is never touched.

---

## Air-Gapped Environments

FlowGuard is designed for air-gapped deployment:

1. Download `flowguard-core-{version}.tgz` on a connected machine
2. Transfer to air-gapped environment (USB, internal artifact store)
3. Install via `npm install -g ./flowguard-core-{version}.tgz`
4. Initialize with `flowguard install --core-tarball ./flowguard-core-{version}.tgz`

No network access required during installation or runtime.

---

## Integrity Verification

| Check                 | Mechanism                          | Enforced By       |
| --------------------- | ---------------------------------- | ----------------- |
| Artifact integrity    | SHA-256 checksum on Releases page  | Operator          |
| Content digest        | SHA-256 in `flowguard-mandates.md` | FlowGuard runtime |
| Dependency resolution | `file:` path validation            | npm               |
| State integrity       | Zod schema validation              | FlowGuard runtime |
| Audit chain integrity | SHA-256 hash chain                 | FlowGuard runtime |

---

## Customer Responsibilities

| Area                      | Responsibility                                        |
| ------------------------- | ----------------------------------------------------- |
| **Artifact procurement**  | Download from GitHub Releases                         |
| **Checksum verification** | Verify SHA-256 before installation                    |
| **Artifact archival**     | Maintain rollback copies                              |
| **Network isolation**     | Ensure no outbound connections from FlowGuard runtime |
| **Backup**                | Archive `.opencode/` directory for disaster recovery  |
| **Compliance mapping**    | Map FlowGuard controls to regulatory requirements     |

---

_FlowGuard Version: 1.0.0_
_Last Updated: 2026-04-15_
