# Installation

FlowGuard is distributed via GitHub Releases as source code. The release contains the complete TypeScript source that must be built before installation.

## Prerequisites

- Node.js 20+
- Bun (recommended) or npm
- OpenCode

## Installation Steps

### 1. Download the Release

Download the latest release from the [Releases page](https://github.com/koeppben23/governed-runtime/releases).

### 2. Build the Package

```bash
# Extract the release
cd flowguard-release

# Install dependencies and build
npm install
npm run build
```

### 3. Install Globally

```bash
# Install the built CLI globally
npm install -g ./

# Verify installation
flowguard --version
```

### 4. Initialize OpenCode Integration

```bash
# Set up FlowGuard tools in your OpenCode environment
flowguard install
```

### 5. Verify Installation

```bash
flowguard doctor
```

Expected output (abridged — one line per managed artifact):
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
| `--policy-mode solo\|team\|regulated` | Set default policy mode |

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

### Tools not discovered

```bash
# Reinstall tools
flowguard install --force

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
