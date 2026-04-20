# ACP (Agent Client Protocol) — Experimental Exploration

> ACP is treated as an experimental compatibility surface, not the primary CI/headless execution path.

---

## Overview

OpenCode supports the [Agent Client Protocol](https://agentclientprotocol.com) — an open protocol that standardizes communication between code editors and AI coding agents.

This document captures the exploration of ACP as an optional integration path for FlowGuard.

---

## Official Documentation Findings

### From OpenCode CLI Docs

```
### acp

Start an ACP (Agent Client Protocol) server.

Terminal window

opencode acp

This command starts an ACP server that communicates via stdin/stdout using nd-JSON.
```

### From OpenCode ACP Support Docs

- **Protocol:** ACP (Agent Client Protocol) — open standard at agentclientprotocol.com
- **Communication:** JSON-RPC via stdio
- **Editor Support:** Zed, JetBrains IDEs, Avante.nvim, CodeCompanion.nvim
- **Command:** `opencode acp [--cwd <dir>] [--port <port>] [--hostname <host>]`
- **Status:** Supported, but documentation notes: "Some built-in slash commands like /undo and /redo are currently unsupported"

---

## Delta: ACP vs run/serve

| Aspect | ACP | opencode run | opencode serve |
|--------|-----|------------|--------------|
| **Protocol** | ACP (JSON-RPC via stdio) | CLI argument passing | HTTP REST API |
| **Target** | Editor/IDE integration | Automation/CI | API integration |
| **Output Format** | JSON-RPC messages | Text output | JSON responses |
| **Stability** | Experimental | Stable | Stable |
| **FlowGuard CI** | ❌ Not recommended | ✅ Recommended | ✅ Recommended |

---

## Research Findings Summary

| Question | Finding |
|----------|---------|
| **Is ACP stable enough for FlowGuard CI?** | No — not recommended as primary path. |
| **Protocol spec available?** | Yes — ACP at agentclientprotocol.com |
| **Communication format** | JSON-RPC via stdio (not nd-JSON as initially noted in docs) |
| **CI-Relevanz** | Low — Primär für Editor-Integration, nicht CI-Automation |
| **Recommended path for CI** | `flowguard run` / `flowguard serve` (wraps opencode run/serve) |

---

## Decision

1. **Run/serve is the recommended path** for FlowGuard headless CI/CD
2. **ACP remains experimental** — compatibility surface for editor integration only
3. **No full ACP integration** — only smoke probe if explicitly requested
4. **Test gate:** ENV-gated only: `RUN_OPENCODE_ACP_TESTS=1`

---

## Test Coverage

ACP tests are optional and gated:

```bash
RUN_OPENCODE_ACP_TESTS=1 npm run test:acp
```

Tests must not run in default CI to avoid external dependency.

---

## References

- [OpenCode ACP Documentation](https://opencode.ai/docs/acp/)
- [OpenCode CLI Documentation](https://opencode.ai/docs/cli/)
- [Agent Client Protocol Spec](https://agentclientprotocol.com)

---

_FlowGuard Version: 1.1.0_
_Last Updated: 2026-04-20_