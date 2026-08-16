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

## Step 5: Initialize OpenCode Integration (Air-Gapped Machine)

The approved local tarball is the authoritative package source. No global installation is required.

```bash
# Install FlowGuard tools into your OpenCode environment
# Use the local path to the transferred tarball
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz

# Verify the installation
npx --package ./flowguard-core-{version}.tgz flowguard doctor
```

**Important:** The `--core-tarball` argument is required and must point to the locally available release artifact.
Keep `checksums.sha256` in the same directory as the tarball. The installer
verifies it by default and fails closed if the checksum file is missing or the
hash does not match. Use `--checksums-file <path>` only when the checksum file is
stored elsewhere.

Expected `doctor` output:

```
  [ok] ~/.config/opencode/flowguard-mandates.md
  [ok] ~/.config/opencode/tools/flowguard.ts
  [ok] ~/.config/opencode/plugins/flowguard-audit.ts
  [ok] ~/.config/opencode/commands/hydrate.md
  ... (installed command files)
  [ok] ~/.config/opencode/commands/archive.md
  [ok] ~/.config/opencode/package.json
  [ok] ~/.config/opencode/opencode.json
  [ok] flowguard.json — config valid (defaults only)

  N/N checks passed
```

### Repository-Scoped Installation

To install FlowGuard into a specific repository instead of globally:

```bash
cd /path/to/your/repo
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz --install-scope repo --policy-mode regulated
```

This writes FlowGuard artifacts to `.opencode/` within the repository.

---

## Step 6: Verify Offline-Capable Configuration

FlowGuard's default workflows are offline-capable when the installer uses only
locally provided artifacts and network-dependent features are not configured or
invoked. The following surfaces perform outbound network I/O and **must be
left disabled (or explicitly pinned to an internal mirror) in environments
where outbound access or local listeners are prohibited**:

| Surface               | Trigger                                                                           | Avoidance / mitigation                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/review url=...`     | Operator passes a URL to `/review`                                                | Do not pass `url=...`; use `text=...`, `prNumber=`, or `branch=`. FlowGuard resolves branch refs and materializes local review content without network access.                                                                                                                                                                                                  |
| Remote JWKS           | `policy.identityProvider.mode = 'jwks'` with a `jwksUri`                          | Use `mode: 'static'` with pre-staged signing keys, or point `jwksUri` at an internal mirror reachable from the air-gapped network.                                                                                                                                                                                                                              |
| Claude Code HTTP hook | `flowguard-hook-server` started for the Claude Code host integration              | Use the OpenCode plugin path instead; or run the HTTP hook only when its localhost listener is acceptable.                                                                                                                                                                                                                                                      |
| RFC 3161 TSA          | `policy.audit.timestampAssurance.mode = 'tsa_critical'` with `tsaUrl` set         | Keep the default `mode: 'local_only'`, or set `tsaUrl` to an internal RFC 3161 timestamp authority and pin its `trustAnchors`.                                                                                                                                                                                                                                  |
| NTP drift checks      | `policy.audit.timestampAssurance.mode = 'ntp_check'` with `ntpServers` reachable  | Keep the default `mode: 'local_only'`, or point `ntpServers` at an internal NTP source.                                                                                                                                                                                                                                                                         |
| OTLP log export       | `logging.otlp.enabled = true` with an endpoint (or `OTEL_EXPORTER_OTLP_ENDPOINT`) | Keep the default `logging.otlp.enabled = false`. When enabled, the endpoint must be an `https://` URL (cleartext requires explicit `logging.otlp.allowInsecure`); point it at an internal collector. The `@opentelemetry/sdk-logs` and `@opentelemetry/exporter-logs-otlp-http` packages are `optionalDependencies` and are not required for default operation. |

```bash
# Verify local installation and configuration
npx --package ./flowguard-core-{version}.tgz flowguard doctor
```

All checks should pass without network access when local artifacts are present and
network-dependent features are disabled.

---

## Upgrading in Air-Gapped Environments

1. Download the new release tarball and checksums on the internet-connected machine.
2. Transfer, verify, and install following Steps 2-5 above.
3. Re-run `npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball ./flowguard-core-{version}.tgz --force` with the matching `checksums.sha256` next to the tarball to update all managed artifacts.
4. Re-run `npx --package ./flowguard-core-{version}.tgz flowguard doctor` to verify the upgrade.

The `--force` flag ensures all thin wrappers and managed artifacts are overwritten with the new version.

---

## Troubleshooting

### --core-tarball required

```
ERROR: --core-tarball is required.
Usage: npx --package ./flowguard-core-1.2.0-tp.1 flowguard install --core-tarball ./flowguard-core-1.2.0-tp.1
Download from: https://github.com/koeppben23/governed-runtime/releases
```

Ensure you have downloaded `flowguard-core-{version}.tgz` and provide the correct path.

### `flowguard doctor` reports `MISSING` files

Run `npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball ./flowguard-core-{version}.tgz` with the release `checksums.sha256` next to the tarball (or with `--force` if upgrading). Doctor only checks — it does not create files.

### `flowguard doctor` reports `VERSION` mismatch

The installed `flowguard-mandates.md` was written by a different FlowGuard version. Run `npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball ./flowguard-core-{version}.tgz` to update it.

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
- **Minimal attack surface**: FlowGuard ships with seven runtime dependencies
  (`@modelcontextprotocol/sdk`, `@opentelemetry/api`, `asn1js`, `jose`,
  `jsonc-parser`, `pkijs`, `zod`). All are well-known, narrowly-scoped
  packages; FlowGuard does not bundle a utility belt (no lodash, axios, etc.).
  The three `@opentelemetry/*` SDK packages listed as `optionalDependencies`
  are skipped automatically when the installer cannot resolve them, so
  air-gapped installs do not require an internet connection to npm.
- **Offline-first**: FlowGuard requires no outbound network calls for default
  workflows after installation when the optional surfaces above are not
  configured or invoked.

---

FlowGuard Version: 1.2.0-tp.2
_Last Updated: 2026-04-15_
