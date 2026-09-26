# Installation

FlowGuard is distributed as a pre-built proprietary release artifact via GitHub Releases. No build step required.
Release publication is tag-driven (`v*`): if no release tag has been published yet, the Releases page can be empty for that repository snapshot.

## Prerequisites

- Node.js 20+
- npm
- OpenCode

## Installation Steps

### 1. Download the Release Artifact

Download `flowguard-core-{version}.tgz` and `checksums.sha256` from the [Releases page](https://github.com/koeppben23/governed-runtime/releases).

The installer verifies the tarball by default. Keep `checksums.sha256` next to
the tarball, or pass its location with `--checksums-file`. Missing or mismatched
checksum evidence blocks installation before any FlowGuard artifacts are written.

You can also verify the checksum manually before install:

```bash
sha256sum -c checksums.sha256
```

For automated integrity verification with an explicit checksum path, use the
`--checksums-file` flag:

```bash
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz \
  --checksums-file ./checksums.sha256
```

If `--checksums-file` is omitted, FlowGuard uses `checksums.sha256` in the same
directory as `flowguard-core-{version}.tgz`.

The explicit supply-chain opt-out is `--allow-unverified-tarball`. It is not
recommended; the installer warns and logs the opt-out. Use it only when an
operator has verified the artifact through another controlled channel.

## Host Selection Matrix

Before installing, choose the host platform. Enforcement and activation guarantees
differ per host.

| Host        | Enforcement   | Global Target                 | Repo Target            | Activation       | Key Limitation               |
| ----------- | ------------- | ----------------------------- | ---------------------- | ---------------- | ---------------------------- |
| OpenCode    | `synchronous` | `~/.config/opencode/`         | `./.opencode/`         | Restart OpenCode | —                            |
| Claude Code | `hook_gated`  | `~/.claude/`                  | `./.claude/`           | Restart Claude   | Hook timeout = tool proceeds |
| Codex       | `hook_gated`  | `~/.codex/plugins/flowguard/` | `./plugins/flowguard/` | Restart Codex    | `NOT_VERIFIED_NATIVE_LOAD`   |

OpenCode provides the strongest enforcement path through its synchronous plugin.
Claude Code and Codex are supported through MCP, hooks, and native packaging with
hook-gated, platform-limited guarantees. See
[Platform Limitations](./platform-limitations.md) for details.

Claude Code and Codex are technical previews; OpenCode is the fully supported GA host.

### 2. Initialize OpenCode Integration (Standard)

The approved local tarball is the authoritative package source. npm/npx may use an internal cache, but no global installation is required.

```bash
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz

# Verify
npx --package ./flowguard-core-{version}.tgz flowguard doctor
```

### 2b. Initialize Claude Code Or Codex Plugin

For detailed Claude Code and Codex installation, activation, trust, verification,
and uninstall guidance, see [Host Installation](./host-installation.md).

### 3. Verify Installation

```bash
npx --package ./flowguard-core-{version}.tgz flowguard doctor
npx --package ./flowguard-core-{version}.tgz flowguard doctor --host claude-code
npx --package ./flowguard-core-{version}.tgz flowguard doctor --host codex
```

`doctor --host opencode|claude-code|codex` reports host-specific installation files plus a projection-only trust/capability report. This report is diagnostic evidence only; it does not create a new runtime, approval, review, policy, or risk authority. File presence can mean `configured`, but it never proves native plugin load, active governance, trust approval, or review approval.

`doctor` also validates the shipped executable surface: every command declared in the package `bin` map (`flowguard`, `flowguard-mcp`, and the `flowguard-hook-*` binaries) must exist, be a regular file, and carry the Node shebang. A missing or corrupt runtime binary — or a missing/invalid `bin` manifest — is reported as a failure and makes `doctor` exit non-zero (fail-closed).

The trust report surfaces:

- Expected host capability shape and enforcement level from FlowGuard's Host Adapter contract.
- Runtime activation as `NOT_VERIFIED_RUNTIME` unless a runtime probe has actually executed.
- Claude/Codex reviewer agents/subagents as transport/isolation only.
- Approval primitive as FlowGuard `/review-decision` / `flowguard_decision` with validated obligation-bound `ReviewFindings`.
- Receipt-preservation fields, explicitly marking values not preserved by host transport instead of fabricating them.

For Codex, `doctor --host codex` also reports `NOT_VERIFIED_NATIVE_LOAD`, requires `[features].plugin_hooks = true`, reminds operators to review `/hooks` trust prompts, and calls out that `PreToolUse` is a guardrail for `Bash` and `apply_patch`, not a complete security boundary.

Expected output:

```
  [ok] ~/.config/opencode/flowguard-mandates.md
  [ok] ~/.config/opencode/tools/flowguard.ts
  [ok] ~/.config/opencode/plugins/flowguard-audit.ts
  [ok] ~/.config/opencode/commands/hydrate.md
  ... (installed command files)
  [ok] ~/.config/opencode/commands/archive.md
  [ok] ~/.config/opencode/package.json
  [ok] ~/.config/opencode/opencode.json (or opencode.jsonc when present)
  [ok] flowguard.json — config valid (defaults only)

  N/N checks passed
```

## Install from Local Source Checkout

Dogfood installation from a source checkout is owned by the
[Development and Debugging guide](./development/debugging.md#10-dogfood-installation-from-source).
Use `npm ci` there for reproducible installation from the committed lockfile;
use `npm install` only when intentionally changing dependencies.

## Project-Bound Installation (Recommended for Teams)

For teams that want FlowGuard integrated into their project workflow:

```json
{
  "scripts": {
    "flowguard:install": "npx --package ./vendor/flowguard-core-1.2.0 flowguard install --core-tarball ./vendor/flowguard-core-1.2.0",
    "flowguard:doctor": "npx --package ./vendor/flowguard-core-1.2.0 flowguard doctor"
  }
}
```

Then run:

```bash
npm run flowguard:install
npm run flowguard:doctor
```

## Installation Options

| Option                                         | Description                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `--install-scope global`                       | Install to `~/.config/opencode/` (default)                                         |
| `--install-scope repo`                         | Install to `.opencode/` (committed to repo)                                        |
| `--host opencode\|claude-code\|codex`          | Host alias for `--platform` during install; runtime host for `flowguard run/serve` |
| `--platform opencode\|claude-code\|codex`      | Select host integration target                                                     |
| `--policy-mode solo\|team\|team-ci\|regulated` | Set default policy mode (persisted to `flowguard.json`); defaults to `team`        |
| `--core-tarball <path>`                        | **Required.** Path to `flowguard-core-{version}.tgz`                               |
| `--checksums-file <path>`                      | Optional explicit checksum file. Defaults to `checksums.sha256` next to tarball    |
| `--allow-unverified-tarball`                   | Explicit supply-chain opt-out; not recommended and logged                          |

## Malformed JSON Recovery

When FlowGuard recovers from malformed JSON by rewriting an installer-managed config file, it first writes a timestamped `.flowguard-backup-*` file next to the original. If the backup cannot be written, install stops and does not overwrite the malformed file.

Inspect the backup, repair the malformed JSON if needed, then rerun `flowguard install --force`.

## Headless Runtime Host Selection

Headless host selection, wrapper status, and direct-host operation are owned by
[Distribution Model](./distribution-model.md#headless-operation).

## How It Works

In OpenCode chat, use the normal product sequence `/start`, `/task`, `/plan`,
`/approve`, `/implement`, and `/export`. FlowGuard runs validation automatically;
use `/check` only for manual recovery or explicit evidence recording.

The complete user-command, compatibility, and internal-tool reference is
[Commands](./commands.md). It is the canonical command surface.

### User-Facing Commands (OpenCode Workflow)

See [Commands](./commands.md#daily-workflow) for the normal workflow and its
complete product-command reference.

### Internal Tool Bindings (OpenCode Infrastructure)

See [Command Surface](./commands.md#command-surface) for the installed internal
tool bindings.

## Uninstall

```bash
npx --package ./flowguard-core-{version}.tgz flowguard uninstall
```

## Local Development

Use the [Development Guide](./development/index.md) for contributor setup,
debugging, and dogfooding. `npm ci` installs exactly from the lockfile for a
reproducible checkout. Use `npm install` when deliberately changing
dependencies; it is the repository's required lockfile update command.

## Headless Operation

Headless operation is available through the selected host's native CLI. The
complete OpenCode, Claude Code, Codex, wrapper, and ACP guidance is in
[Distribution Model](./distribution-model.md#headless-operation).

### Non-Interactive Mode (opencode run)

Use the [central headless guide](./distribution-model.md#headless-operation)
for the supported host CLI commands and their fail-closed input behavior.

### HTTP API Mode (opencode serve)

Use the [central headless guide](./distribution-model.md#http-api-mode-opencode-serve)
for OpenCode server authentication, session creation, and message examples.

### ACP Mode (Experimental)

Use the [central headless guide](./distribution-model.md#acp-mode-experimental)
for ACP's experimental STDIN/STDOUT integration path.

## Troubleshooting

### --core-tarball required

```
ERROR: --core-tarball is required.
Usage: npx --package ./flowguard-core-1.2.0 flowguard install --core-tarball ./flowguard-core-1.2.0
Download from: https://github.com/koeppben23/governed-runtime/releases
```

Ensure you have downloaded `flowguard-core-{version}.tgz` from the releases page.

### Tools not discovered

```bash
# Reinstall tools (requires --core-tarball again)
npx --package ./flowguard-core-{version}.tgz flowguard install --core-tarball /path/to/flowguard-core-{version}.tgz --force

# Check OpenCode config
opencode doctor
```

### Permission errors

```bash
# Check write permissions
ls -la ~/.config/opencode/

# Fix permissions if needed
chmod 755 ~/.config/opencode/
```
