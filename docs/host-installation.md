# Host Installation

This guide contains the host-specific installation, activation, and trust
details. Start with [Installation](./installation.md) for release artifact
verification and the standard install path.

## Claude Code

Install the approved local artifact with the Claude Code target:

```bash
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --host claude-code \
  --core-tarball ./flowguard-core-{version}.tgz
```

The plugin is installed at `.claude/flowguard-plugin/` for repository scope or
`~/.claude/flowguard-plugin/` for global scope. Load it with the installer
output, for example:

```bash
claude --plugin-dir .claude/flowguard-plugin
```

When the Claude CLI is available, validate the installed plugin:

```bash
claude plugin validate .claude/flowguard-plugin --strict
```

If that CLI is unavailable in the verification environment, record the check as
`NOT_VERIFIED`. The plugin is packaging, instruction, MCP, hook, and transport
surface only; validated, obligation-bound `ReviewFindings` remain the review
completion authority.

## Codex

Install and register the local Codex plugin:

```bash
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --host codex \
  --core-tarball ./flowguard-core-{version}.tgz
```

Repository scope writes `.agents/plugins/marketplace.json` and
`plugins/flowguard/`. Global scope writes `~/.agents/plugins/marketplace.json`
and `~/.codex/plugins/flowguard/`. The FlowGuard-owned marketplace entry uses a
local, repository-relative plugin path.

Codex hook enforcement additionally requires native trust configuration outside
the installer:

```text
[features]
plugin_hooks = true
```

Review the Codex `/hooks` trust prompts after enabling hooks. `PreToolUse` is a
guardrail for `Bash` and `apply_patch`, not a complete security boundary;
`PostToolUse` audits after execution and cannot roll back mutations. The
installer reports `NOT_VERIFIED_NATIVE_LOAD` until it has real native-load
evidence. Codex cloud-only operation is out of scope because this integration
requires local plugin files, local MCP execution, and local hook trust.

## Verify And Uninstall

Use `doctor` for the installed host:

```bash
npx --package ./flowguard-core-{version}.tgz flowguard doctor --host claude-code
npx --package ./flowguard-core-{version}.tgz flowguard doctor --host codex
```

The report proves installed files and projects host capability/trust status; it
does not prove native plugin load, active enforcement, trust approval, or review
approval. Set `FLOWGUARD_HOST_PLATFORM=claude-code` or
`FLOWGUARD_HOST_PLATFORM=codex` for MCP/tool execution so FlowGuard renders the
appropriate pending-instruction guidance.

Uninstall removes only FlowGuard-owned plugin and registration surfaces:

```bash
npx --package ./flowguard-core-{version}.tgz flowguard uninstall --host claude-code --install-scope repo
npx --package ./flowguard-core-{version}.tgz flowguard uninstall --host codex --install-scope repo
```

See [Platform Limitations](./platform-limitations.md) for the host enforcement
model and residual risks.
