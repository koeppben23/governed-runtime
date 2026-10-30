# ADR-009: Model-neutral, correlated reviewer JSON

- Status: Accepted (architecture approved; implementation verification recorded separately)
- Date: 2026-10-30
- Supersedes: the required OpenCode StructuredOutput transport, not review governance

## Context

OpenCode 1.19.5 implements `format: json_schema` by forcing `toolChoice: required`.
Some otherwise executable agent models cannot use that mode with their selected
reasoning settings. FlowGuard must not introduce additional provider-specific
requirements or model/variant substitutions.

Official sources (pinned host source is authoritative for implementation):

- [Prompt, request identity and required tool choice](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/session/prompt.ts)
- [Local and MCP before-tool boundaries](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/session/tools.ts)
- [Provider option merging](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/session/llm/request.ts)
- [Host model and variant configuration](https://opencode.ai/docs/models/)
- [Synchronous plugin tool hooks](https://opencode.ai/docs/plugins/)

## Decision

Use one visible native reviewer child for execution and a normal same-child
serialization prompt, without any `format`, permission override, or forced tool
choice. Model and variant come from the completed child call and are explicitly
bound to serialization and its one permitted structural repair.

Every serialization request has its own explicit `messageID` and a unique owner
lease. Only that lease can release the fence, so a failed concurrent `begin`
cannot remove another operation's protection. The synchronous message hook
confirms the prompt and selected model. The messages-transform hook derives its
session identity from the host messages (the hook has no session-ID argument)
and requires the expected request to be the last pre-step message. The
parameters hook observes exactly one model step. Response `parentID`, session,
agent, model, variant and successful completion must match. A before-tool fence
denies every tool in this scope; an attempted action permanently invalidates that
capture. Tool parts in the final response are rejected, including provider-executed
tools. An additional model step is rejected before execution. Persistent child
permissions are not modified. Unknown execution outcomes retain the fence.

The complete regular text of the correlated assistant message is decoded as one
strict JSON object, bounded to 1 MiB, depth 64 and 100,000 values. There is no prose
extraction, Markdown unwrapping, duplicate-key acceptance, or parser repair.
`ReviewerFindingsInput`, host stamping, canonical findings, observation binding,
scope/challenge checks, frozen obligation/revision identity and atomic reuse/dispatch
checks remain mandatory. The original payload and canonical findings have distinct
digests. Evidence transport generation 5 records request/response identity and
`host_message_validated` assurance; it never claims host StructuredOutput was used.

Host-selected output capacity is the default. An explicit numeric FlowGuard cap
continues to require a verifiable, sufficient model limit. Aborts, truncation and
capacity failures remain terminal under the existing execution contract.

## Consequences

- One implementation serves PLAN, ARCHITECTURE, IMPLEMENTATION and REVIEW.
- There are no provider-name branches, capability database, or special reasoning profiles.
- Invalid JSON and inadequate reviews still fail closed; integration is not an LLM quality guarantee.
- The superseded transport is removed, not retained as a fallback.
- Historical v4 bytes/hashes remain unchanged and are inspected with the corresponding old version; the new runtime does not normalize old evidence.
- OpenCode's formatted-message persistence defect remains upstream (#40169/#26929).
  New unformatted traffic does not fix historical formatted sessions.
- Host/provider, binding, concurrency and negative-path tests are required before claiming verification.

## Verification (2026-10-30)

- Pinned official host/SDK baseline: `opencode-ai@1.19.5`, `@opencode-ai/plugin@1.19.5`.
- Live wire smoke on that pinned host: explicit request identity, correlated
  response, preserved provider/model, no StructuredOutput tool, no required
  tool choice, and readable unformatted history — passed.
- Installed reviewer capability smoke on the pinned host (permissions, denied
  FlowGuard/MCP tools, observation carve-out) — passed.
- FlowGuard unit/integration suite, architecture guards, installer smoke,
  formatting, TypeScript checks, strict lint, build, dependency-surface check —
  passed.
- NOT_VERIFIED: the cross-provider live matrix (DeepSeek, GPT-6.1 Sol low/high,
  Claude, Gemini, local agent model) requires credentials and external provider
  execution. It was not run here and must not be claimed as passed.
- The targeted mutation run for the new capture authorities did not produce a
  usable score because the Stryker/Vitest per-test coverage mapping reported
  zero executed tests and many harness errors for those files. The unit and
  negative-path suites pass, but mutation coverage remains NOT_VERIFIED.
