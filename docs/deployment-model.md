# Deployment Model

This document describes how FlowGuard is deployed, where it runs, and how it integrates with the host environment.

---

## Deployment Overview

| Aspect | Value |
|--------|-------|
| **Deployment Type** | Self-hosted, locally installed |
| **Runtime Environment** | OpenCode / Bun (same process) |
| **Installation Target** | `~/.config/opencode/` (global) or `.opencode/` (project) |
| **Network Behavior** | No outbound connections required |
| **Multi-Instance** | Not supported (single-machine, no built-in multi-user coordination) |

---

## Delivery Scope

| Category | Description | Example |
|----------|-------------|---------|
| **Technically Enforced** | Guarantees by implementation | Fail-closed, phase gates, hash chain |
| **Currently Delivered** | Available in current release | CLI installer, OpenCode tools, archive |
| **Optional** | Can be enabled | `--policy-mode regulated`, project-scoped install |
| **Not Covered** | Intentionally not provided | Multi-user, distributed, hosted |
| **Customer Responsibility** | Operational decisions | Network isolation, access control |

---

## Supported Deployment Modes

### Global Installation (Default)

FlowGuard is installed system-wide in `~/.config/opencode/`:

```
~/.config/opencode/
├── flowguard-mandates.md   # Managed mandates with content digest
├── opencode.json           # OpenCode configuration
├── package.json            # With file:-based @flowguard/core dependency
├── plugins/
│   └── flowguard-audit.ts  # Audit plugin
├── tools/
│   └── flowguard.ts        # Tool bindings
└── commands/
    ├── hydrate.md
    ├── ticket.md
    └── ...
```

**Currently Delivered:**
- Single installation available across all projects
- Updates affect all projects using global install
- Configuration via `~/.config/opencode/flowguard.json` (optional)

### Project Installation

FlowGuard is installed per-repository in `.opencode/`:

```
repository/
├── .opencode/              # Committed to repo
│   ├── flowguard-mandates.md
│   ├── opencode.json
│   ├── package.json
│   └── ...
└── ...
```

**Optional:**
- Must be explicitly enabled with `--install-scope repo`
- Allows per-project policy mode selection
- Installation committed to version control

---

## Environment Requirements

### Prerequisites

| Component | Requirement | Status |
|-----------|-------------|--------|
| **Runtime** | OpenCode | Customer Responsibility |
| **Node.js / Bun** | Node.js 20+ or Bun | Customer Responsibility |
| **Filesystem** | Read/write access to installation directory | Customer Responsibility |

### Runtime Characteristics

| Characteristic | Description |
|---------------|-------------|
| **Memory** | Minimal (state machine is pure, no heavy computation) |
| **CPU** | Negligible (evaluation is sub-millisecond) |
| **Disk I/O** | On state read/write only |
| **Network** | None at runtime |

---

## Integration Architecture

### OpenCode Integration

FlowGuard integrates with OpenCode via:

| Component | Purpose | Installed By |
|-----------|---------|--------------|
| **Custom Tools** | Bridge between LLM and state machine | `flowguard install` |
| **Command Prompts** | Phase-specific behavioral guidance | `flowguard install` |
| **Audit Plugin** | Automatic event recording | `flowguard install` |
| **Mandates** | FlowGuard rules for LLM | `flowguard install` |

### Adapter Layer

| Adapter | Responsibility |
|---------|----------------|
| **Persistence** | Read/write session state (JSON, Zod-validated) |
| **Workspace** | Discover repository files, manage workspace registry |
| **Git** | Repository fingerprint, metadata |
| **Binding** | Workspace-to-session binding |
| **Context** | OpenCode context (session ID, user info) |

---

## Security Boundaries

| Boundary | Enforced By | Customer Responsibility |
|----------|-------------|------------------------|
| **FlowGuard runtime** | Code | Protect installation directory |
| **Session state** | Zod schemas | Protect `.opencode/` directory |
| **Audit trail** | Hash chain | Protect JSONL file |
| **Archives** | Manifest + digests | Secure archive storage |

---

## Deployment Scenarios

### Standard Developer Machine

**Currently Delivered:**
- Global installation in `~/.config/opencode/`
- Per-project activation via `.opencode/` if needed
- Local filesystem storage for all data

**Customer Responsibility:**
- OS user permissions
- Filesystem backup
- Access control to developer machine

### Air-Gapped Environment

**Currently Delivered:**
- Artifact-based installation (no network during install)
- `file:`-based dependency resolution
- Full offline operation

**Customer Responsibility:**
- Artifact procurement (download on connected machine)
- Secure transfer to air-gapped environment
- Artifact archival for rollback

### Regulated Environment

**Optional:**
- Regulated policy mode (`--policy-mode regulated`)
- Four-eyes principle enforcement
- Enhanced audit requirements

**Customer Responsibility:**
- Network isolation verification
- Compliance mapping to organizational requirements
- Audit evidence retention

---

## Limitations

| Limitation | Impact | Workaround |
|------------|--------|------------|
| **Single-machine** | No distributed sessions | External coordination |
| **Session access** | Multi-user access requires customer-managed controls | OS-level access controls, host-level account separation, external workflow coordination |
| **No hosted option** | No managed service | Self-hosted only |
| **Local storage** | No cloud sync | Manual archive transfer |

---

*FlowGuard Version: 1.3.1*
*Last Updated: 2026-04-15*
