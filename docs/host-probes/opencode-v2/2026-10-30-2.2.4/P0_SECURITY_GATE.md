# P0 security-design gate: inactive host and provider/MCP execution

Status: **NOT_SUPPORTED for an immutable host-side lock**

This is a bounded Phase-0 follow-up to the main v2.2.4 report. It answers only
two questions:

1. Can the host be stopped before the first model or tool action when the
   FlowGuard plugin is not active?
2. Can MCP and provider-executed tools be prevented from causing side effects
   before permission or a local tool hook?

No production adapter is changed here.

## P0-A: inactive plugin must not reach a model or tool

### Attempted design: plugin-owned provider only

Configuration under test:

- no static `providers` block;
- `model: probe/probe`;
- the FlowGuard probe plugin registers the only provider during `setup()`;
- a managed `policies` entry denies the built-in `opencode` provider;
- the probe's `Plugin.define` command is the only plugin that registers a
  provider.

Result with an active plugin:

- `setup:provider-registered` recorded;
- prompt reached the local deterministic provider exactly once;
- assistant turn completed with `finish: stop`.

Result with a deliberately failed plugin setup:

- `setup:fail` recorded;
- **no** assistant turn, **no** provider request and **no** hook record;
- prompt admission was still accepted by the host, but model resolution did
  not reach a provider.

This is a real **configuration-level** fail-closed gate for the tested config.
It is not a host-side immutable lock: a host launched with another config,
another provider or an added static provider bypasses it. The control probe
with a static provider still reached the local provider after plugin failure.

The p0 probe runs three cases: active plugin (provider registered, one request),
failed plugin (no provider request, no assistant, no hooks), and static-provider
after failure (still reaches the mock provider). The static-provider case is a
control proving why a static provider must not be present.

**Decision: `NOT_SUPPORTED` for a non-bypassable runtime lock; `SUPPORTED` only
as a managed-config/deployment gate.**

### Why “remove the static provider” alone is not enough

The v2 host falls back to its built-in `opencode/big-pickle` provider when no
configured provider is available. The inactive probe observed assistant
messages with:

```json
{ "id": "big-pickle", "providerID": "opencode" }
```

and an outbound provider connection, while the probe's local mock provider
recorded zero requests. Therefore a no-static-provider configuration **without
a provider policy** is not fail-closed. The policy deny is the part that stops
the fallback in the tested configuration.

## P0-B: MCP and provider-executed tools

### Hosted-tool request policy

A plugin-level `http.request` policy can inspect the **final provider request**
and throw before the request is sent. The probe configured a provider body with
`{ "tools": [{ "type": "web_search" }] }` and a policy that rejects known hosted
tool types:

- denied request: policy hook fired, provider request count **0**;
- allowed control without a hosted tool definition: provider request count
  **1**.

This proves a working **pre-request** gate for hosted-tool definitions that are
visible in the final request. It does not prove protection against a provider
that autonomously emits an unoffered hosted call; that requires a provider
capability contract or exclusion of that provider. The prior hosted-tool
fixture attempt did not reach a stable terminal completion, so the real
response-side negative path remains `NOT_VERIFIED`.

### MCP

Source inspection of the installed v2.2.4 host shows `McpTool` calling
`permission.assert(...)` before `mcp.callTool(...)`. A permission `deny` for the
normalized `<server>_<tool>` action is therefore a preventive candidate.

The current probe could not advertise the test MCP tool in the session tool
list, so the real negative path remains **`NOT_VERIFIED`**. This must be closed
with a working MCP catalog test before MCP can be called supported.

### Provider-executed tools

`ResponsesHostedTools.onDone` emits `providerExecuted: true` tool calls and
results. The v2 runner deliberately skips the local tool executor for those
calls:

```ts
if (event.type !== 'tool-call' || event.providerExecuted) return;
```

There is no local `execute.before` and no permission assertion in that path.
A provider that emits a hosted `web_search`, `web_extract` or similar item can
therefore produce provider-side effects that FlowGuard cannot deny through the
normal tool fence. The earlier hosted-tool fixture did not reach a stable
terminal completion, so the real-host positive/negative proof is still
`NOT_VERIFIED`; source evidence already shows the local hook gap.

**Decision: `NOT_SUPPORTED` as a universal preventive guarantee.** The supported
scope must either exclude providers/protocols that can execute hosted tools or
require an explicit provider capability contract. A hook-only adapter cannot
turn this into a local deny.

## What the security gate established

- A plugin-owned provider plus a managed policy that denies the built-in
  provider is a viable **deployment-level** gate; it is not non-bypassable.
- A static provider defeats the gate; the control case proves it.
- A plugin `http.request` policy can reject visible hosted-tool definitions
  before the provider request; the denied case produced zero provider requests.
- MCP permission denial is plausible but not proven against an advertised MCP
  tool.
- Provider-executed tools have no local post-response hook; a provider that
  emits an unoffered hosted call remains a host-level limitation and must be
  excluded or explicitly unsupported.

## Repro

```sh
node scripts/opencode-v2-probe/probes/p0-inactive-host.mjs
node scripts/opencode-v2-probe/probes/fences.mjs
```

The inactive probe uses a managed policy to deny the built-in provider; it does
not intentionally send prompts to an external provider. Raw evidence stays
under `scripts/opencode-v2-probe/evidence/` and is not committed.

## Consequence

The full host-governance claim remains **NO-GO**. The next decision is not an
adapter port; it is whether FlowGuard accepts a managed-config deployment gate
with an explicit bypass limitation, or requires a launcher/OS-level enforcement
mechanism that OpenCode v2 does not provide by itself.
