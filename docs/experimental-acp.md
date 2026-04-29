# ACP (Agent Client Protocol) — Experimental Exploration

> **Status:** ACP is treated as an **experimental compatibility surface**, not a production headless CI path.

---

## Overview

OpenCode supports [ACP](https://agentclientprotocol.com) — an open protocol for editor/IDE integration (Zed, JetBrains, Avante.nvim, CodeCompanion.nvim).

This document captures research findings. ACP is NOT a supported FlowGuard CI path.

---

## Official Documentation

| Source | Command                                               | Protocol                  |
| ------ | ----------------------------------------------------- | ------------------------- |
| CLI    | `opencode acp`                                        | stdin/stdout via JSON-RPC |
| Docs   | [opencode.ai/docs/acp](https://opencode.ai/docs/acp/) | ACP specification         |

---

## Decision

1. **Primary CI path:** Use OpenCode directly: `opencode run` / `opencode serve`
2. **ACP status:** Experimental compatibility surface only
3. **Test gate:** ENV-gated: `RUN_OPENCODE_ACP_TESTS=1` (not default)

---

## Test Usage

```bash
RUN_OPENCODE_ACP_TESTS=1 npm run test:acp
```

---

## References

- [OpenCode ACP Docs](https://opencode.ai/docs/acp/)
- [OpenCode CLI Docs](https://opencode.ai/docs/cli/)
- [ACP Spec](https://agentclientprotocol.com)

---

FlowGuard Version: 1.2.0-rc.1
_Last Updated: 2026-04-20_
