# Air-Gapped Installation Guide

How to install FlowGuard in environments without internet access.

---

## Overview

FlowGuard is distributed via GitHub Releases as a tarball containing pre-built JavaScript, `package.json`, and `package-lock.json`. In air-gapped environments, all artifacts must be transferred to the target machine manually.

This guide covers the preparation (on an internet-connected machine) and the installation (on the air-gapped target).

---

## Prerequisites

### Internet-Connected Machine (Preparation)

- Node.js 20+
- npm
- Access to GitHub Releases and the npm registry

### Air-Gapped Target Machine

- Node.js 20+
- npm
- OpenCode (already installed)
- A file transfer mechanism (USB drive, internal artifact repository, etc.)

---

## Step 1: Download Artifacts (Internet-Connected Machine)

Download the following from the [Releases page](https://github.com/koeppben23/governed-runtime/releases):

| File | Purpose |
|------|---------|
| `flowguard-<version>.tar.gz` | Pre-built FlowGuard package |
| `flowguard-<version>-checksums.sha256` | SHA-256 checksums for integrity verification |
| `flowguard-<version>-sbom.cdx.json` | CycloneDX SBOM (optional, for compliance records) |

---

## Step 2: Download npm Dependencies (Internet-Connected Machine)

FlowGuard has **1 runtime dependency** (`zod`). You need to download it for offline installation.

```bash
# Create a working directory
mkdir flowguard-offline && cd flowguard-offline

# Extract the release tarball
tar -xzf flowguard-<version>.tar.gz

# Download the dependency tarball from npm
npm pack zod
# This creates a file like zod-3.x.x.tgz
```

After this step, your `flowguard-offline/` directory should contain:

```
flowguard-offline/
  flowguard-<version>.tar.gz          # Release tarball
  flowguard-<version>-checksums.sha256 # Checksums
  zod-3.x.x.tgz                       # Runtime dependency
```

---

## Step 3: Verify Integrity (Before Transfer)

Verify the release tarball checksum before transferring to the air-gapped machine:

```bash
# Verify checksums
sha256sum -c flowguard-<version>-checksums.sha256
```

Expected output:

```
flowguard-<version>.tar.gz: OK
flowguard-<version>-sbom.cdx.json: OK
```

If verification fails, re-download the artifacts. Do not transfer unverified files.

---

## Step 4: Transfer to Air-Gapped Machine

Transfer the following files to the target machine using your approved transfer mechanism:

- `flowguard-<version>.tar.gz`
- `flowguard-<version>-checksums.sha256`
- `zod-3.x.x.tgz`

---

## Step 5: Verify Integrity (After Transfer)

On the air-gapped machine, verify the checksum again to confirm the transfer was clean:

```bash
sha256sum -c flowguard-<version>-checksums.sha256
```

---

## Step 6: Install FlowGuard (Air-Gapped Machine)

```bash
# Create a working directory and extract
mkdir flowguard && cd flowguard
tar -xzf /path/to/flowguard-<version>.tar.gz

# Install the runtime dependency from the local tarball
npm install --offline /path/to/zod-3.x.x.tgz

# Install FlowGuard globally
npm install -g ./

# Verify the CLI is available
flowguard --version
```

---

## Step 7: Initialize OpenCode Integration

```bash
# Install FlowGuard tools into your OpenCode environment
flowguard install

# Verify the installation
flowguard doctor
```

Expected `doctor` output (abridged):

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
flowguard install --install-scope repo --policy-mode regulated
```

This writes FlowGuard artifacts to `.opencode/` within the repository.

---

## Step 8: Install OpenCode Wrapper Dependencies

The FlowGuard installer writes thin wrapper files and a `package.json` into the OpenCode directory. These wrappers need their dependency resolved:

```bash
# For global installation
cd ~/.config/opencode/
npm install --offline /path/to/flowguard  # Points to the extracted FlowGuard directory

# For repo-scoped installation
cd /path/to/your/repo/.opencode/
npm install --offline /path/to/flowguard
```

---

## Upgrading in Air-Gapped Environments

1. Download the new release tarball and checksums on the internet-connected machine.
2. Download the updated `zod` tarball if the version constraint changed (check `package.json`).
3. Transfer, verify, and install following Steps 3-8 above.
4. Re-run `flowguard install --force` to update all managed artifacts.
5. Re-run `flowguard doctor` to verify the upgrade.

The `--force` flag ensures all thin wrappers and managed artifacts are overwritten with the new version. Without `--force`, existing wrappers are skipped (they are designed to be stable across versions).

---

## Troubleshooting

### `npm install` fails with "network request" errors

npm is attempting to reach the registry. Ensure you are using `--offline` and that all dependency tarballs are provided locally.

### `flowguard doctor` reports `MISSING` files

Run `flowguard install` (or `flowguard install --force` if upgrading). Doctor only checks — it does not create files.

### `flowguard doctor` reports `VERSION` mismatch

The installed `flowguard-mandates.md` was written by a different FlowGuard version. Run `flowguard install` to update it.

### Permission errors on `~/.config/opencode/`

Ensure the current user has write access to the OpenCode configuration directory:

```bash
# Linux/macOS
chmod 755 ~/.config/opencode/

# Windows (PowerShell)
# The directory is typically at %USERPROFILE%\.config\opencode\
```

### Verifying no outbound network calls

FlowGuard itself makes no outbound network calls. All data stays on the local filesystem. The only network-dependent step is the initial `npm install` of the `zod` dependency, which is handled offline in this guide.

---

## Security Considerations

- **Always verify checksums** before and after transfer. The checksums file uses SHA-256.
- **Sigstore attestation** is available for release artifacts on GitHub. In air-gapped environments, attestation verification requires network access to Sigstore infrastructure and may not be feasible. Rely on SHA-256 checksums for offline integrity verification.
- **SBOM** (`flowguard-<version>-sbom.cdx.json`) documents the complete dependency tree. Retain it for compliance records.
- **Minimal attack surface**: FlowGuard has 1 runtime dependency (`zod` — a schema validation library). Review the SBOM to verify the dependency tree matches expectations.

---

*FlowGuard Version: 1.3.0*
*Last Updated: 2026-04-15*
