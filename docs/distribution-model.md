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

| Component       | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| **CLI**         | `flowguard` command (install, uninstall, doctor, run, serve) |
| **Core**        | State machine, rails, adapters, audit, config                |
| **Integration** | OpenCode tools, plugin, command prompts                      |
| **Templates**   | Package.json, opencode.jsonc, mandates                       |

---

## Headless Operation

FlowGuard operates within a supported host runtime. Headless modes are achieved via the selected host's native CLI interface:

### Host Headless Modes

| Host            | Non-interactive command                          | Serve support                          |
| --------------- | ------------------------------------------------ | -------------------------------------- |
| **OpenCode**    | `opencode run "prompt"`                          | `opencode serve --port 4096`           |
| **Claude Code** | `claude -p "prompt" --output-format stream-json` | Not verified; `flowguard serve` blocks |
| **Codex**       | `codex --non-interactive --prompt "prompt"`      | Not verified; `flowguard serve` blocks |

### FlowGuard Headless Wrapper (EXPERIMENTAL)

FlowGuard provides a CLI wrapper for headless operation:

```bash
# Execute FlowGuard commands non-interactively (EXPERIMENTAL)
flowguard run --host opencode -- "Run /hydrate policyMode=team-ci"
flowguard run --host claude-code -- "Run /validate"
flowguard run --host codex -- "Run /status"

# Start a verified native server (OpenCode only)
flowguard serve --host opencode --port 4096
```

Host resolution is strict: CLI `--host` overrides `host.defaultHost` in `.opencode/flowguard.json`, which overrides the built-in default `opencode`. Invalid config and missing host binaries fail explicitly; FlowGuard never falls back to another host.

`flowguard serve --host claude-code` and `flowguard serve --host codex` fail closed with `HOST_SERVE_UNSUPPORTED` until a verified native long-running serve/session mode exists for those hosts.

**Status:** This feature is being refined. For production CI, use the official host commands directly:

```bash
# Direct host usage (recommended)
opencode run "Run /hydrate"
opencode serve --port 4096
claude -p "Run /validate" --output-format stream-json
codex --non-interactive --prompt "Run /status"
```

**Note:** Selecting `codex` or `claude-code` for `flowguard run` selects the host process and argument shape only. It does not prove native plugin load, hook trust, MCP activation, or governance enforcement unless those checks are verified separately.

**Headless ambiguity handling:** In non-interactive automation (`flowguard run`, `flowguard serve`, `opencode run`, API-driven execution), operators must provide all required inputs up front. Missing safety-critical input returns `BLOCKED`; there is no follow-up question loop in headless mode.

### ACP Mode (Experimental)

The Agent Client Protocol (ACP) provides STDIN/STDOUT-based communication:

```bash
opencode acp
```

**Status:** Experimental — ACP is treated as a compatibility surface for editor/IDE integration.

For CI/headless automation, use the host CLI directly:
opencode run "prompt"
opencode serve --port 4096
claude -p "prompt" --output-format stream-json
codex --non-interactive --prompt "prompt"

FlowGuard wrappers are experimental convenience commands.

See [docs/experimental-acp.md](./experimental-acp.md) for research findings.

---

## Installation Flow

### 1. Download Artifact

```bash
# Download from your approved release source
#    (e.g., GitHub Releases, internal artifact store)

# Verify checksum
sha256sum flowguard-core-{version}.tgz
```

### 2. Initialize OpenCode Integration (Standard)

The approved local tarball is the authoritative package source. No global installation is required.

```bash
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz
```

The installer:

1. Creates `.opencode/` directory structure
2. Materializes the release artifact into `vendor/flowguard-core-{version}.tgz`
3. Writes `package.json` with `file:`-based dependency
4. Installs OpenCode tools, commands, and plugin
5. Creates `flowguard-mandates.md` with content digest

OpenCode merges configuration files from multiple sources (global, project,
managed) — later configs override earlier ones only for conflicting keys,
non-conflicting settings are preserved. FlowGuard's installer follows this
merge semantics: it merges (never replaces) its instruction entry and task
permission into the existing config.

---

## Dependency Resolution

### file:-Based Dependencies

FlowGuard uses `file:`-based npm dependencies for offline resolution:

```json
{
  "dependencies": {
    "@flowguard/core": "file:./vendor/flowguard-core-{version}.tgz"
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
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz --force
```

### Rollback

```bash
# Reinstall with previous tarball
npx --package ./flowguard-core-{old}.tgz flowguard install \
  --core-tarball ./flowguard-core-{old}.tgz --force
```

**Customer Responsibility:** Maintain archives of previous `flowguard-core-{version}.tgz` artifacts for rollback capability.

---

## Uninstall

To remove FlowGuard from an environment:

```bash
# Remove OpenCode integration
npx --package ./flowguard-core-{version}.tgz flowguard uninstall
```

The uninstall command removes all FlowGuard-owned files from `~/.config/opencode/` (or `./.opencode/` for repo scope) and cleans up the `opencode.jsonc` instruction entries. `flowguard-mandates.md` is also removed. Your `AGENTS.md` is never touched.

---

## Air-Gapped Environments

FlowGuard is designed for air-gapped deployment:

1. Download `flowguard-core-{version}.tgz` on a connected machine
2. Transfer to air-gapped environment (USB, internal artifact store)
3. Install: `npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball ./flowguard-core-{version}.tgz`

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

FlowGuard Version: 1.2.0-rc.3
_Last Updated: 2026-04-15_
