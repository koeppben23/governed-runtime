# MCP Tool Surface

FlowGuard exposes **15 Integration Tools** (`src/integration/tools/index.ts`).
**14 of these** are registered in the MCP server
(`src/mcp-server/server.ts` `FLOWGUARD_TOOLS`). One tool is not available via
MCP.

## Excluded Tool

**`flowguard_resolve_implementation_challenge`** is the only Integration Tool
not registered in the MCP surface.

This is an existing **capability asymmetry** — the tool was introduced
(2026-07-26) after the last MCP registry update (2026-07-19) and has not been
wired into the MCP server. There is no evidence in code, commit history, or
design documentation of an intentional exclusion decision.

## Tool Behaviour

`resolve_implementation_challenge` records advisory `NOT_VERIFIED` evidence
that a prior implementation review challenge has been addressed. It is available
in the `IMPL_REVIEW` phase after post-implementation validation. The tool:

- Persistently binds one prior implementation challenge to the current
  implementation digest and immutable validation attempt IDs
- Rejects unknown, duplicate, wrong-scope, and wrong-digest references
- Records resolved actor identity when available
- Does **not** change review acceptance, consume review obligations, or bypass
  the `EVIDENCE_REVIEW` user gate

Because the tool has no governance-gate effect and produces only advisory
evidence, it is a candidate for MCP inclusion but does not represent a
functional gap — the same review outcome can be reached without it.

## Resolution

A future change should either:

- **Wire the tool into MCP** (add to `FLOWGUARD_TOOLS`, update SDK baselines,
  update MCP protocol tests), or
- **Document an explicit exclusion decision** with a rationale in
  `src/mcp-server/server.ts` and this file.

Until resolved, this file serves as the canonical reference for the asymmetry.
