# Air-Gapped Installation Guide

How to install FlowGuard in environments without internet access.

---

## Overview

FlowGuard is distributed as a pre-built proprietary release artifact via GitHub Releases. In air-gapped environments, the release artifact must be transferred to the target machine manually.

This guide covers the preparation (on an internet-connected machine) and the installation (on the air-gapped target).

---

## Prerequisites

### Internet-Connected Machine (Preparation)

- Node.js 20+
- npm
- Access to GitHub Releases

### Air-Gapped Target Machine

- Node.js 20+
- npm
- OpenCode (already installed)
- A file transfer mechanism (USB drive, internal artifact repository, etc.)

---

## Step 1: Download Release Artifact (Internet-Connected Machine)

Download `flowguard-core-{version}.tgz` from the [Releases page](https://github.com/koeppben23/governed-runtime/releases).

Download the checksums file:
- `checksums.sha256`

---

## Step 2: Verify Integrity (Before Transfer)

Verify the release tarball checksum before transferring to the air-gapped machine:

```bash
sha256sum -c checksums.sha256
```

Expected output:

```
flowguard-core-{version}.tgz: OK
```

If verification fails, re-download the artifacts. Do not transfer unverified files.

---

## Step 3: Transfer to Air-Gapped Machine

Transfer the following files to the target machine using your approved transfer mechanism:

- `flowguard-core-{version}.tgz`
- `checksums.sha256`

---

## Step 4: Verify Integrity (After Transfer)

On the air-gapped machine, verify the checksum again to confirm the transfer was clean:

```bash
sha256sum -c checksums.sha256
```

---

## Step 5: Install the CLI (Air-Gapped Machine)

```bash
npm install -g ./flowguard-core-{version}.tgz

# Verify the CLI is available
flowguard --version
```

---

## Step 6: Initialize OpenCode Integration

```bash
# Install FlowGuard tools into your OpenCode environment
# Use the local path to the transferred tarball
flowguard install --core-tarball /path/to/flowguard-core-{version}.tgz

# Verify the installation
flowguard doctor
```

**Important:** The `--core-tarball` argument is required and must point to the locally available release artifact.

Expected `doctor` output:
```
  [ok] ~/.config/opencode/flowguard-mandates.md
  [ok] ~/.config/opencode/tools/flowguard.ts
  [ok] ~/.config/opencode/plugins/flowguard-audit.ts
  [ok] ~/.config/opencode/commands/hydrate.md
  ... (10 command files)
  [ok] ~/.config/opencode/commands/archive.md
  [ok] ~/.config/opencode/package.json
  [ok] ~/.config/opencode/opencode.json
  [ok] config.json — no config file — using defaults

  N/N checks passed
```

### Repository-Scoped Installation

To install FlowGuard into a specific repository instead of globally:

```bash
cd /path/to/your/repo
flowguard install --core-tarball /path/to/flowguard-core-{version}.tgz --install-scope repo --policy-mode regulated
```

This writes FlowGuard artifacts to `.opencode/` within the repository.

---

## Step 7: Verify No Network Dependencies

FlowGuard itself makes no outbound network calls. All data stays on the local filesystem. The installer uses only locally provided artifacts.

```bash
# Verify the CLI has no network dependencies
flowguard doctor
```

All checks should pass without network access.

---

## Upgrading in Air-Gapped Environments

1. Download the new release tarball and checksums on the internet-connected machine.
2. Transfer, verify, and install following Steps 2-6 above.
3. Re-run `flowguard install --core-tarball /path/to/new/flowguard-core-{version}.tgz --force` to update all managed artifacts.
4. Re-run `flowguard doctor` to verify the upgrade.

The `--force` flag ensures all thin wrappers and managed artifacts are overwritten with the new version.

---

## Troubleshooting

### --core-tarball required

```
ERROR: --core-tarball is required.
Usage: flowguard install --core-tarball /path/to/flowguard-core-1.0.0.tgz
Download from: https://github.com/koeppben23/governed-runtime/releases
```

Ensure you have downloaded `flowguard-core-{version}.tgz` and provide the correct path.

### `flowguard doctor` reports `MISSING` files

Run `flowguard install --core-tarball /path/to/flowguard-core-{version}.tgz` (or with `--force` if upgrading). Doctor only checks — it does not create files.

### `flowguard doctor` reports `VERSION` mismatch

The installed `flowguard-mandates.md` was written by a different FlowGuard version. Run `flowguard install --core-tarball /path/to/flowguard-core-{version}.tgz` to update it.

### Permission errors on `~/.config/opencode/`

Ensure the current user has write access to the OpenCode configuration directory:

```bash
# Linux/macOS
chmod 755 ~/.config/opencode/

# Windows (PowerShell)
# The directory is typically at %USERPROFILE%\.config\opencode\
```

---

## Security Considerations

- **Always verify checksums** before and after transfer. The checksums file uses SHA-256.
- **Minimal attack surface**: FlowGuard has 1 runtime dependency (`zod` — a schema validation library) that is installed via the local package manager when running `npm install` in the `.opencode/` directory.
- **Offline-first**: FlowGuard makes no outbound network calls after installation.

---

*FlowGuard Version: 1.0.0*
*Last Updated: 2026-04-15*
