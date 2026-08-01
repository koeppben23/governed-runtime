# MCP Tool Surface

FlowGuard exposes **17 Integration Tools** (`src/integration/tools/index.ts`).
**16 of these** are registered in the MCP server
(`src/mcp-server/server.ts` `FLOWGUARD_TOOLS`). One tool is not available via
MCP.

## Excluded Tool

**`flowguard_resolve_implementation_challenge`** is the only Integration Tool
not registered in the MCP surface.

This is an intentional capability asymmetry: the tool records advisory
implementation-review evidence and is not required to complete the governed
review flow.

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

If this advisory operation must be available to MCP consumers, add it to
`FLOWGUARD_TOOLS` and update the SDK baseline and MCP protocol tests.
