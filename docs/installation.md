# Installation

FlowGuard is distributed as a pre-built proprietary release artifact via GitHub Releases. No build step required.
Release publication is tag-driven (`v*`): if no release tag has been published yet, the Releases page can be empty for that repository snapshot.

## Prerequisites

- Node.js 20+
- npm
- OpenCode

## Installation Steps

### 1. Download the Release Artifact

Download `flowguard-core-{version}.tgz` from the [Releases page](https://github.com/koeppben23/governed-runtime/releases).

Verify the checksum:
```bash
sha256sum flowguard-core-{version}.tgz
```

### 2. Install the CLI

```bash
npm install -g ./flowguard-core-{version}.tgz

# Verify installation
flowguard --version
```

### 3. Initialize OpenCode Integration

```bash
flowguard install --core-tarball /path/to/flowguard-core-{version}.tgz
cd ~/.config/opencode && npm install
```

**Note:** The `--core-tarball` path must point to the downloaded release artifact. This is required for the installer to set up local vendored dependencies.

### 4. Verify Installation

```bash
flowguard doctor
```

Expected output:
```
  [ok] ~/.config/opencode/flowguard-mandates.md
  [ok] ~/.config/opencode/tools/flowguard.ts
  [ok] ~/.config/opencode/plugins/flowguard-audit.ts
  [ok] ~/.config/opencode/commands/hydrate.md
  ... (10 command files total)
  [ok] ~/.config/opencode/commands/archive.md
  [ok] ~/.config/opencode/package.json
  [ok] ~/.config/opencode/opencode.json
  [ok] config.json — no config file — using defaults

  N/N checks passed
```

## Installation Options

| Option | Description |
|--------|-------------|
| `--install-scope global` | Install to `~/.config/opencode/` (default) |
| `--install-scope repo` | Install to `.opencode/` (committed to repo) |
| `--policy-mode solo\|team\|team-ci\|regulated` | Set default policy mode |
| `--core-tarball <path>` | **Required.** Path to `flowguard-core-{version}.tgz` |

## How It Works

FlowGuard integrates with OpenCode via a two-level command surface:

### User-Facing Commands (OpenCode Workflow)

Use these commands in OpenCode chat to drive workflows:

| Command | Description |
|---------|-------------|
| `/hydrate` | Bootstrap session |
| `/ticket <text>` | Record task |
| `/plan` | Generate plan |
| `/continue` | Auto-advance |
| `/validate` | Run checks |
| `/implement` | Execute plan |
| `/review-decision approve\|reject` | Human approval |
| `/review` | Generate report |
| `/abort` | Terminate session |
| `/archive` | Archive session |

### Internal Tool Bindings (OpenCode Infrastructure)

These are the underlying tool names that FlowGuard installs into OpenCode:

| Tool Name | Purpose |
|-----------|---------|
| `flowguard_status` | Check session state |
| `flowguard_hydrate` | Session bootstrap |
| `flowguard_ticket` | Task recording |
| `flowguard_plan` | Plan generation |
| `flowguard_decision` | Record review verdict |
| `flowguard_validate` | Validation runner |
| `flowguard_implement` | Plan executor |
| `flowguard_review` | Generate compliance report |
| `flowguard_abort_session` | Session termination |
| `flowguard_archive` | Session archival |

## Uninstall

```bash
flowguard uninstall
```

## Local Development

For development on FlowGuard itself:

```bash
# Clone repository
git clone https://github.com/koeppben23/governed-runtime.git
cd governed-runtime

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run check
```

## Troubleshooting

### --core-tarball required

```
ERROR: --core-tarball is required.
Usage: flowguard install --core-tarball /path/to/flowguard-core-1.0.0.tgz
Download from: https://github.com/koeppben23/governed-runtime/releases
```

Ensure you have downloaded `flowguard-core-{version}.tgz` from the releases page.

### Tools not discovered

```bash
# Reinstall tools (requires --core-tarball again)
flowguard install --core-tarball /path/to/flowguard-core-{version}.tgz --force

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
